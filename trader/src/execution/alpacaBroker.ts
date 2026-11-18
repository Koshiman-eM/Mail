import { fetchJson, fetchWithRetry, HttpError, type FetchOptions } from "../core/http";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, OrderRequest, OrderResult, OrderStatus } from "../core/types";

export const ALPACA_LIVE_URL = "https://api.alpaca.markets";
export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";

export interface AlpacaBrokerOptions extends LiveGuard {
  keyId: string;
  secretKey: string;
  /** ALPACA_PAPER=true なら paper-api を使う (それでも live ガードは必須) */
  paper?: boolean;
  fetchImpl?: typeof fetch;
}

const mapStatus = (s: string, filled: number): OrderStatus => {
  switch (s) {
    case "filled": return "filled";
    case "partially_filled": return "partially_filled";
    case "canceled":
    case "expired":
    case "done_for_day": return filled > 0 ? "partially_filled" : "canceled";
    case "rejected":
    case "suspended": return "rejected";
    default: return "open";
  }
};

export class AlpacaBroker implements Broker {
  readonly venue = "alpaca";
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly done = new Map<string, OrderResult>();

  constructor(private readonly o: AlpacaBrokerOptions) {
    assertLive("AlpacaBroker", o);
    this.base = o.paper ? ALPACA_PAPER_URL : ALPACA_LIVE_URL;
  }

  private req<T>(method: string, path: string, body?: unknown, retries = 3): Promise<T> {
    const opts: FetchOptions = {
      method,
      headers: { "APCA-API-KEY-ID": this.o.keyId, "APCA-API-SECRET-KEY": this.o.secretKey, "content-type": "application/json" },
      retries,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    };
    return fetchJson<T>(`${this.base}${path}`, opts);
  }

  async getBalance(): Promise<Balance> {
    const a = await this.req<any>("GET", "/v2/account");
    return { currency: a.currency ?? "USD", equity: String(a.equity), available: String(a.buying_power) };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const ps = await this.req<any[]>("GET", "/v2/positions");
    return ps.map((p) => {
      const q = Number(p.qty);
      const signed = p.side === "short" ? -Math.abs(q) : q;
      return { symbol: p.symbol, qty: String(signed), avgPrice: Number(p.avg_entry_price) };
    });
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      qty: req.qty,
      side: req.side,
      type: req.type,
      time_in_force: req.tif === "IOC" ? "ioc" : req.tif === "FOK" ? "fok" : req.type === "market" ? "day" : "gtc",
      client_order_id: req.clientId,
    };
    if (req.type === "limit") {
      if (req.limitPrice === undefined) throw new Error("指値価格が必要");
      body.limit_price = String(req.limitPrice);
    }
    let o: any;
    try {
      o = await this.req<any>("POST", "/v2/orders", body, 0);
    } catch (e) {
      // 同じ client_order_id の二重送信は 422。既存注文を返して冪等にする
      if (e instanceof HttpError && e.status === 422 && /client_order_id/i.test(e.body)) {
        o = await this.req<any>("GET", `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(req.clientId)}`);
      } else if (e instanceof HttpError && (e.status === 403 || e.status === 422)) {
        const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason: e.body.slice(0, 200) };
        this.done.set(req.clientId, r);
        return r;
      } else throw e;
    }
    const filled = Number(o.filled_qty ?? 0);
    const fills: Fill[] = [];
    if (filled > 0) {
      fills.push({
        orderId: o.id,
        clientId: req.clientId,
        ts: Date.parse(o.filled_at ?? o.updated_at ?? new Date().toISOString()),
        price: Number(o.filled_avg_price),
        qty: String(filled),
        fee: "0",
        liquidity: req.type === "limit" ? "maker" : "taker",
      });
    }
    const res: OrderResult = { orderId: o.id, clientId: req.clientId, status: mapStatus(o.status, filled), fills };
    this.done.set(req.clientId, res);
    return res;
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    // 204 No Content が返るため JSON 解析はしない
    await fetchWithRetry(`${this.base}/v2/orders/${orderId}`, {
      method: "DELETE",
      headers: { "APCA-API-KEY-ID": this.o.keyId, "APCA-API-SECRET-KEY": this.o.secretKey },
      retries: 0,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
  }
}
