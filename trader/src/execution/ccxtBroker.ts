import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, Instrument, OrderRequest, OrderResult, OrderStatus } from "../core/types";

/** ccxt の認証付き exchange のうち使う部分 (テストでモック可能) */
export interface CcxtTradeLike {
  id: string;
  has?: Record<string, unknown>;
  fetchBalance(): Promise<any>;
  fetchPositions?(symbols?: string[]): Promise<any[]>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>): Promise<any>;
  cancelOrder(id: string, symbol?: string): Promise<any>;
}

export interface CcxtBrokerOptions extends LiveGuard {
  exchange: CcxtTradeLike;
  /** 口座通貨 (例: "JPY", "USDT") */
  accountCurrency: string;
  instruments: Instrument[];
}

const mapStatus = (o: any): OrderStatus => {
  const filled = Number(o.filled ?? 0);
  switch (o.status) {
    case "closed": return "filled";
    case "canceled":
    case "expired": return filled > 0 ? "partially_filled" : "canceled";
    case "rejected": return "rejected";
    default: return filled > 0 ? "partially_filled" : "open";
  }
};

export class CcxtBroker implements Broker {
  readonly venue: string;
  readonly mode = "live" as const;
  private readonly ex: CcxtTradeLike;
  private readonly done = new Map<string, OrderResult>();

  constructor(private readonly o: CcxtBrokerOptions) {
    assertLive("CcxtBroker", o);
    this.ex = o.exchange;
    this.venue = `ccxt:${o.exchange.id}`;
  }

  async getBalance(): Promise<Balance> {
    const b = await this.ex.fetchBalance();
    const ccy = this.o.accountCurrency;
    const total = Number(b?.total?.[ccy] ?? 0);
    const free = Number(b?.free?.[ccy] ?? total);
    return { currency: ccy, equity: String(total), available: String(free) };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (this.ex.has?.fetchPositions && this.ex.fetchPositions) {
      const ps = await this.ex.fetchPositions();
      return ps
        .filter((p) => Number(p.contracts ?? 0) !== 0)
        .map((p) => ({
          symbol: p.symbol,
          qty: String((p.side === "short" ? -1 : 1) * Math.abs(Number(p.contracts))),
          avgPrice: Number(p.entryPrice ?? 0),
        }));
    }
    // 現物は残高から導出 (平均取得単価は取得不可なので 0)
    const b = await this.ex.fetchBalance();
    const out: BrokerPosition[] = [];
    for (const i of this.o.instruments) {
      const q = Number(b?.total?.[i.baseCurrency] ?? 0);
      if (q > 0 && i.baseCurrency !== this.o.accountCurrency) out.push({ symbol: i.symbol, qty: String(q), avgPrice: 0 });
    }
    return out;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    const params: Record<string, unknown> = { clientOrderId: req.clientId };
    if (req.reduceOnly) params.reduceOnly = true;
    if (req.tif === "IOC" || req.tif === "FOK") params.timeInForce = req.tif;
    let order: any;
    try {
      order = await this.ex.createOrder(req.symbol, req.type, req.side, Number(req.qty), req.type === "limit" ? req.limitPrice : undefined, params);
    } catch (e) {
      const name = e instanceof Error ? e.constructor.name : "";
      // 明確な拒否のみ rejected に変換。ネットワーク系は状態不明のため呼び出し側へ投げる
      if (/InvalidOrder|InsufficientFunds|BadSymbol|PermissionDenied|AuthenticationError/.test(name)) {
        const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason: e instanceof Error ? e.message : String(e) };
        this.done.set(req.clientId, r);
        return r;
      }
      throw e;
    }
    const filled = Number(order.filled ?? 0);
    const fills: Fill[] = [];
    if (filled > 0) {
      fills.push({
        orderId: String(order.id),
        clientId: req.clientId,
        ts: Number(order.lastTradeTimestamp ?? order.timestamp ?? Date.now()),
        price: Number(order.average ?? order.price ?? 0),
        qty: String(filled),
        fee: String(order.fee?.cost ?? 0),
        liquidity: req.type === "limit" ? "maker" : "taker",
      });
    }
    const res: OrderResult = { orderId: String(order.id), clientId: req.clientId, status: mapStatus(order), fills };
    this.done.set(req.clientId, res);
    return res;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.ex.cancelOrder(orderId, symbol);
  }
}
