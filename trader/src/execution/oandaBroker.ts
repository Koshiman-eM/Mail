import { fetchJson, HttpError, type FetchOptions } from "../core/http";
import { OANDA_HOSTS, toOandaSymbol, fromOandaSymbol, parseOandaTime } from "../market/feeds/oanda";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, OrderRequest, OrderResult } from "../core/types";

export interface OandaBrokerOptions extends LiveGuard {
  token: string;
  accountId: string;
  env?: "practice" | "live";
  fetchImpl?: typeof fetch;
}

export class OandaBroker implements Broker {
  readonly venue = "oanda";
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly done = new Map<string, OrderResult>();

  constructor(private readonly o: OandaBrokerOptions) {
    assertLive("OandaBroker", o);
    this.base = OANDA_HOSTS[o.env ?? "practice"];
  }

  private req<T>(method: string, path: string, body?: unknown, retries = 3): Promise<T> {
    const opts: FetchOptions = {
      method,
      headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json", "accept-datetime-format": "RFC3339" },
      // 発注系は二重送信を避けるためリトライしない
      retries,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    };
    return fetchJson<T>(`${this.base}${path}`, opts);
  }

  async getBalance(): Promise<Balance> {
    const r = await this.req<{ account: any }>("GET", `/v3/accounts/${this.o.accountId}/summary`);
    return { currency: r.account.currency, equity: String(r.account.NAV), available: String(r.account.marginAvailable) };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const r = await this.req<{ positions: any[] }>("GET", `/v3/accounts/${this.o.accountId}/openPositions`);
    const out: BrokerPosition[] = [];
    for (const p of r.positions ?? []) {
      const lu = Number(p.long?.units ?? 0);
      const su = Number(p.short?.units ?? 0);
      const net = lu + su; // short.units は負
      if (net === 0) continue;
      const avg = net > 0 ? Number(p.long?.averagePrice) : Number(p.short?.averagePrice);
      out.push({ symbol: fromOandaSymbol(p.instrument), qty: String(net), avgPrice: avg });
    }
    return out;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    const units = `${req.side === "buy" ? "" : "-"}${req.qty}`;
    const order: Record<string, unknown> = {
      type: req.type === "market" ? "MARKET" : "LIMIT",
      instrument: toOandaSymbol(req.symbol),
      units,
      timeInForce: req.type === "market" ? "FOK" : req.tif === "IOC" ? "IOC" : req.tif === "FOK" ? "FOK" : "GTC",
      positionFill: req.reduceOnly ? "REDUCE_ONLY" : "DEFAULT",
      clientExtensions: { id: req.clientId.slice(0, 128), tag: req.strategyId.slice(0, 128) },
    };
    if (req.type === "limit") {
      if (req.limitPrice === undefined) throw new Error("指値価格が必要");
      order.price = String(req.limitPrice);
    }
    let r: any;
    try {
      r = await this.req<any>("POST", `/v3/accounts/${this.o.accountId}/orders`, { order }, 0);
    } catch (e) {
      // 4xx は注文が成立していない明確な拒否 (証拠金不足など)。5xx/通信断は状態不明なので投げる
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        const rej: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason: e.body.slice(0, 200) };
        this.done.set(req.clientId, rej);
        return rej;
      }
      throw e;
    }
    const res = this.parse(r, req);
    this.done.set(req.clientId, res);
    return res;
  }

  private parse(r: any, req: OrderRequest): OrderResult {
    const f = r.orderFillTransaction;
    if (f) {
      const fill: Fill = {
        orderId: String(f.orderID ?? f.id),
        clientId: req.clientId,
        ts: f.time ? parseOandaTime(f.time) : Date.now(),
        price: Number(f.price),
        qty: String(Math.abs(Number(f.units))),
        // OANDA はスプレッド型。commission があれば計上
        fee: String(f.commission ?? 0),
        liquidity: req.type === "limit" ? "maker" : "taker",
      };
      return { orderId: fill.orderId, clientId: req.clientId, status: "filled", fills: [fill] };
    }
    const cancel = r.orderCancelTransaction ?? r.orderRejectTransaction;
    if (cancel) {
      return {
        orderId: String(cancel.orderID ?? cancel.id ?? ""),
        clientId: req.clientId,
        status: r.orderRejectTransaction ? "rejected" : "canceled",
        fills: [],
        reason: cancel.reason ?? cancel.rejectReason,
      };
    }
    const c = r.orderCreateTransaction;
    return { orderId: String(c?.id ?? ""), clientId: req.clientId, status: "open", fills: [] };
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    await this.req("PUT", `/v3/accounts/${this.o.accountId}/orders/${orderId}/cancel`, undefined, 0);
  }
}
