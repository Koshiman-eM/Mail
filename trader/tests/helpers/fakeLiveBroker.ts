import type { Balance, Broker, BrokerPosition, OrderRequest, OrderResult, OrderStatus, Quote } from "../../src/core/types";

/**
 * テスト用の「受付のみ」を返す live ブローカー (実在の取引所へは何も送らない)。
 * - placeMode: accept = status "open" / fills [] で受付だけ返す (bitFlyer・Alpaca の成行で多い応答)
 *              fill = 即時に全量約定 / reject = 拒否 / throw = 例外 (タイムアウト等で状態不明)
 * - fill() で取引所側の約定を進め、getOrder は累計の約定を返す。
 */
export class FakeLiveBroker implements Broker {
  readonly mode = "live" as const;
  placeMode: "accept" | "fill" | "reject" | "throw" = "accept";
  getOrderMode: "normal" | "throw" | "missing" = "normal";
  /** getBalance / getPositions を失敗させる */
  failAccount = false;
  equity = 1_000_000;
  currency = "USD";
  /** 約定の手数料 (decimal 文字列) と通貨 (省略時はクオート通貨建て) */
  fee = "0";
  feeCurrency?: string;
  readonly placed: OrderRequest[] = [];
  readonly canceled: string[] = [];
  readonly getOrderCalls: string[] = [];
  /** 取引所側の建玉 (符号付き) */
  readonly positions = new Map<string, number>();
  quoteOf: (symbol: string) => Quote | undefined = () => undefined;
  private readonly orders = new Map<string, { req: OrderRequest; res: OrderResult }>();
  private seq = 0;

  constructor(readonly venue = "paper") {}

  async getBalance(): Promise<Balance> {
    if (this.failAccount) throw new Error("ETIMEDOUT (fake balance)");
    return { currency: this.currency, equity: String(this.equity), available: String(this.equity) };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (this.failAccount) throw new Error("ETIMEDOUT (fake positions)");
    return [...this.positions].filter(([, q]) => Math.abs(q) > 1e-12).map(([symbol, q]) => ({ symbol, qty: String(q), avgPrice: 0 }));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    this.placed.push({ ...req });
    if (this.placeMode === "throw") throw new Error("ETIMEDOUT (fake placeOrder)");
    if (req.reduceOnly) {
      // 実アダプターと同じく、決済は保有数量を上限にする (無ければ拒否)
      const held = this.positions.get(req.symbol) ?? 0;
      const closable = req.side === "sell" ? Math.max(held, 0) : Math.max(-held, 0);
      if (!(closable > 1e-12)) {
        const r: OrderResult = { orderId: `fake-${++this.seq}`, clientId: req.clientId, status: "rejected", fills: [], reason: "reduceOnly だが決済対象の建玉がありません" };
        this.orders.set(req.clientId, { req, res: r });
        return structuredClone(r);
      }
      if (Number(req.qty) > closable) req = { ...req, qty: String(closable) };
    }
    const reject = this.placeMode === "reject";
    const res: OrderResult = {
      orderId: `fake-${++this.seq}`, clientId: req.clientId, status: reject ? "rejected" : "open", fills: [], ...(reject ? { reason: "rejected (fake)" } : {}),
    };
    this.orders.set(req.clientId, { req, res });
    if (this.placeMode === "fill") this.fill(req.clientId);
    return structuredClone(this.orders.get(req.clientId)!.res);
  }

  /** 取引所側で約定させる (累計に追加)。status は約定後の注文状態 */
  fill(clientId: string, o: { qty?: string; price?: number; status?: OrderStatus } = {}): void {
    const rec = this.orders.get(clientId);
    if (!rec) throw new Error(`unknown order ${clientId}`);
    const { req, res } = rec;
    const q = this.quoteOf(req.symbol);
    const price = o.price ?? (req.side === "buy" ? q?.ask : q?.bid) ?? 100;
    const qty = o.qty ?? req.qty;
    res.fills.push({
      orderId: res.orderId, clientId, ts: 0, price, qty, fee: this.fee, ...(this.feeCurrency ? { feeCurrency: this.feeCurrency } : {}), liquidity: "taker",
    });
    res.status = o.status ?? "filled";
    const signed = Number(qty) * (req.side === "buy" ? 1 : -1);
    this.positions.set(req.symbol, (this.positions.get(req.symbol) ?? 0) + signed);
  }

  /** 注文の状態を直接書き換える (取消済みなど) */
  setStatus(clientId: string, status: OrderStatus): void {
    const rec = this.orders.get(clientId);
    if (rec) rec.res.status = status;
  }

  last(): OrderRequest {
    return this.placed[this.placed.length - 1];
  }

  async getOrder(clientId: string, _symbol: string, _orderId?: string): Promise<OrderResult | undefined> {
    this.getOrderCalls.push(clientId);
    if (this.getOrderMode === "throw") throw new Error("ETIMEDOUT (fake getOrder)");
    if (this.getOrderMode === "missing") return undefined;
    const rec = this.orders.get(clientId);
    return rec ? structuredClone(rec.res) : undefined;
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    this.canceled.push(orderId);
    for (const { res } of this.orders.values()) {
      if (res.orderId === orderId && (res.status === "open" || res.status === "partially_filled")) res.status = "canceled";
    }
  }
}
