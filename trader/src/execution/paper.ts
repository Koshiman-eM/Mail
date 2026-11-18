import { D, floorToStep, roundToStep, Decimal } from "../core/decimal";
import {
  systemClock, type Balance, type Broker, type BrokerPosition, type Clock, type Fill, type Instrument, type OrderRequest, type OrderResult, type Quote,
} from "../core/types";

export interface PaperBrokerOptions {
  instruments: Instrument[];
  /** 口座通貨 */
  baseCurrency: string;
  initialEquity: number;
  /** 成行に加えるスリッページ (bps)。既定 2 */
  slippageBps?: number;
  /** クオート通貨 -> 口座通貨の換算レート (既定 1) */
  toAccount?: (ccy: string) => number;
  /** 資産クラス別レバレッジ (証拠金計算)。既定: crypto/meme 1, fx 10, stock 2 */
  leverage?: Partial<Record<Instrument["assetClass"], number>>;
  clock?: Clock;
  /** quote が未受信のときの取得元 */
  quoteProvider?: (symbol: string) => Quote | undefined;
}

interface Pos {
  qty: Decimal;
  avg: Decimal;
  openedAt: number;
}

interface RestingOrder {
  orderId: string;
  req: OrderRequest;
  qty: Decimal;
  limitPrice: Decimal;
  createdAt: number;
}

export interface PaperSnapshot {
  version: 1;
  cash: string;
  realizedPnl: string;
  seq: number;
  positions: { symbol: string; qty: string; avg: string; openedAt: number }[];
  resting: { orderId: string; req: OrderRequest; qty: string; limitPrice: string; createdAt: number }[];
  results: Record<string, OrderResult>;
  quotes: Record<string, Quote>;
}

const DEFAULT_LEVERAGE = { crypto: 1, meme: 1, fx: 10, stock: 2 };

export class PaperBroker implements Broker {
  readonly venue = "paper";
  readonly mode = "paper" as const;

  private readonly inst = new Map<string, Instrument>();
  private readonly base: string;
  private readonly slip: Decimal;
  private readonly toAcct: (ccy: string) => number;
  private readonly clock: Clock;
  private readonly lev: Record<string, number>;
  private cash: Decimal;
  private realized = D(0);
  private seq = 0;
  private positions = new Map<string, Pos>();
  private resting = new Map<string, RestingOrder>();
  private results = new Map<string, OrderResult>(); // clientId -> 結果 (冪等性)
  private quotes = new Map<string, Quote>();
  private listeners: ((f: Fill, symbol: string, side: "buy" | "sell") => void)[] = [];

  constructor(private readonly o: PaperBrokerOptions) {
    for (const i of o.instruments) this.inst.set(i.symbol, i);
    this.base = o.baseCurrency;
    this.cash = D(o.initialEquity);
    this.slip = D(o.slippageBps ?? 2).div(10_000);
    this.toAcct = o.toAccount ?? (() => 1);
    this.clock = o.clock ?? systemClock;
    this.lev = { ...DEFAULT_LEVERAGE, ...(o.leverage ?? {}) };
  }

  addInstrument(i: Instrument): void {
    this.inst.set(i.symbol, i);
  }

  /** 約定通知 (指値が後から約定したときなど) */
  onFill(cb: (f: Fill, symbol: string, side: "buy" | "sell") => void): void {
    this.listeners.push(cb);
  }

  private fx(inst: Instrument): Decimal {
    const r = inst.quoteCurrency === this.base ? 1 : this.toAcct(inst.quoteCurrency);
    return D(Number.isFinite(r) && r > 0 ? r : 1);
  }
  private cs(inst: Instrument): Decimal {
    return D(inst.contractSize ?? 1);
  }
  private quoteOf(symbol: string): Quote | undefined {
    return this.quotes.get(symbol) ?? this.o.quoteProvider?.(symbol);
  }
  private mark(symbol: string, fallback: Decimal): Decimal {
    const q = this.quoteOf(symbol);
    return q ? D(q.bid).plus(q.ask).div(2) : fallback;
  }

  // ───── 評価 ─────

  private unrealized(marks?: Record<string, number>): Decimal {
    let u = D(0);
    for (const [sym, p] of this.positions) {
      const inst = this.inst.get(sym)!;
      const m = marks?.[sym] !== undefined ? D(marks[sym]) : this.mark(sym, p.avg);
      u = u.plus(m.minus(p.avg).mul(p.qty).mul(this.cs(inst)).mul(this.fx(inst)));
    }
    return u;
  }

  private usedMargin(): Decimal {
    let m = D(0);
    for (const [sym, p] of this.positions) {
      const inst = this.inst.get(sym)!;
      const lev = this.lev[inst.assetClass] ?? 1;
      m = m.plus(this.mark(sym, p.avg).mul(p.qty.abs()).mul(this.cs(inst)).mul(this.fx(inst)).div(lev));
    }
    return m;
  }

  /** 評価額の計算。marks 省略時は最新 quote の仲値 */
  markToMarket(marks?: Record<string, number>): { equity: number; cash: number; unrealized: number; realized: number } {
    const u = this.unrealized(marks);
    return { equity: this.cash.plus(u).toNumber(), cash: this.cash.toNumber(), unrealized: u.toNumber(), realized: this.realized.toNumber() };
  }

  async getBalance(): Promise<Balance> {
    const equity = this.cash.plus(this.unrealized());
    const available = Decimal.max(equity.minus(this.usedMargin()), 0);
    return { currency: this.base, equity: equity.toString(), available: available.toString() };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [...this.positions].map(([symbol, p]) => ({ symbol, qty: p.qty.toString(), avgPrice: p.avg.toNumber() }));
  }

  openOrders(): { orderId: string; clientId: string; symbol: string; side: "buy" | "sell"; qty: string; limitPrice: number }[] {
    return [...this.resting.values()].map((r) => ({
      orderId: r.orderId, clientId: r.req.clientId, symbol: r.req.symbol, side: r.req.side, qty: r.qty.toString(), limitPrice: r.limitPrice.toNumber(),
    }));
  }

  getOrder(clientId: string): OrderResult | undefined {
    return this.results.get(clientId);
  }

  // ───── 発注 ─────

  private reject(req: OrderRequest, reason: string): OrderResult {
    const r: OrderResult = { orderId: `paper-${++this.seq}`, clientId: req.clientId, status: "rejected", fills: [], reason };
    this.results.set(req.clientId, r);
    return r;
  }

  /** 約定後に増える建玉の必要証拠金が余力内か */
  private canAfford(inst: Instrument, side: "buy" | "sell", qty: Decimal, price: Decimal): boolean {
    const pos = this.positions.get(inst.symbol);
    const signed = side === "buy" ? qty : qty.neg();
    const cur = pos?.qty ?? D(0);
    const after = cur.plus(signed);
    const increase = after.abs().minus(cur.abs());
    if (increase.lte(0)) return true;
    const lev = this.lev[inst.assetClass] ?? 1;
    const need = price.mul(increase).mul(this.cs(inst)).mul(this.fx(inst)).div(lev);
    const fee = price.mul(qty).mul(this.cs(inst)).mul(this.fx(inst)).mul(inst.takerFeeRate);
    const equity = this.cash.plus(this.unrealized());
    return equity.minus(this.usedMargin()).gte(need.plus(fee));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.results.get(req.clientId);
    if (prev) return prev;
    const inst = this.inst.get(req.symbol);
    if (!inst) return this.reject(req, `未知の銘柄: ${req.symbol}`);

    let qty: Decimal;
    try {
      qty = floorToStep(req.qty, inst.lotSize);
    } catch {
      return this.reject(req, `数量が不正: ${req.qty}`);
    }
    const pos = this.positions.get(req.symbol);
    const cur = pos?.qty ?? D(0);
    if (req.reduceOnly) {
      const closable = req.side === "buy" ? Decimal.max(cur.neg(), 0) : Decimal.max(cur, 0);
      if (closable.lte(0)) return this.reject(req, "reduceOnly だが決済対象のポジションがありません");
      qty = Decimal.min(qty, closable);
    }
    if (qty.lte(0)) return this.reject(req, "数量が 0 以下 (lotSize 未満)");
    if (qty.lt(inst.minQty) && !req.reduceOnly) return this.reject(req, `数量が最小未満: ${qty} < ${inst.minQty}`);
    if (!inst.allowShort && req.side === "sell" && qty.gt(Decimal.max(cur, 0))) {
      return this.reject(req, `${req.symbol} は空売り不可 (保有 ${cur} を超える売り)`);
    }
    const q = this.quoteOf(req.symbol);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return this.reject(req, "クオート未取得");

    const orderId = `paper-${++this.seq}`;
    const isBuy = req.side === "buy";

    if (req.type === "market") {
      const px = isBuy ? D(q.ask).mul(D(1).plus(this.slip)) : D(q.bid).mul(D(1).minus(this.slip));
      const price = roundToStep(px, inst.tickSize);
      return this.fillNow(req, orderId, inst, qty, price, "taker");
    }

    if (req.limitPrice === undefined || !(req.limitPrice > 0)) return this.reject(req, "指値価格が必要");
    const limit = roundToStep(req.limitPrice, inst.tickSize);
    const marketable = isBuy ? limit.gte(q.ask) : limit.lte(q.bid);
    if (marketable) {
      // 板を食う約定: 有利な側の現在値で約定 (taker)
      return this.fillNow(req, orderId, inst, qty, D(isBuy ? q.ask : q.bid), "taker");
    }
    if (req.tif === "IOC" || req.tif === "FOK") {
      const r: OrderResult = { orderId, clientId: req.clientId, status: "canceled", fills: [], reason: "価格が交差せず IOC/FOK 取消" };
      this.results.set(req.clientId, r);
      return r;
    }
    if (!this.canAfford(inst, req.side, qty, limit)) return this.reject(req, "残高不足");
    this.resting.set(orderId, { orderId, req, qty, limitPrice: limit, createdAt: this.clock.now() });
    const r: OrderResult = { orderId, clientId: req.clientId, status: "open", fills: [] };
    this.results.set(req.clientId, r);
    return r;
  }

  private fillNow(req: OrderRequest, orderId: string, inst: Instrument, qty: Decimal, price: Decimal, liq: "maker" | "taker"): OrderResult {
    if (!this.canAfford(inst, req.side, qty, price)) return this.reject(req, "残高不足");
    const fill = this.applyFill(req, orderId, inst, qty, price, liq);
    const r: OrderResult = { orderId, clientId: req.clientId, status: "filled", fills: [fill] };
    this.results.set(req.clientId, r);
    return r;
  }

  /** ネッティング付きの約定反映 */
  private applyFill(req: OrderRequest, orderId: string, inst: Instrument, qty: Decimal, price: Decimal, liq: "maker" | "taker"): Fill {
    const isBuy = req.side === "buy";
    const signed = isBuy ? qty : qty.neg();
    const pos = this.positions.get(inst.symbol);
    const cur = pos?.qty ?? D(0);
    const now = this.clock.now();
    const cs = this.cs(inst);
    let realizedQuote = D(0);

    if (!pos || cur.isZero() || cur.isPositive() === signed.isPositive()) {
      const newQty = cur.plus(signed);
      const avg = pos && !cur.isZero() ? cur.abs().mul(pos.avg).plus(qty.mul(price)).div(newQty.abs()) : price;
      this.positions.set(inst.symbol, { qty: newQty, avg, openedAt: pos && !cur.isZero() ? pos.openedAt : now });
    } else {
      const closeQty = Decimal.min(cur.abs(), qty);
      const dir = cur.isPositive() ? 1 : -1;
      realizedQuote = price.minus(pos.avg).mul(closeQty).mul(dir).mul(cs);
      const remaining = qty.minus(closeQty);
      const newQty = cur.plus(signed);
      if (newQty.isZero()) this.positions.delete(inst.symbol);
      else if (remaining.gt(0)) this.positions.set(inst.symbol, { qty: newQty, avg: price, openedAt: now }); // ドテン
      else this.positions.set(inst.symbol, { qty: newQty, avg: pos.avg, openedAt: pos.openedAt }); // 部分決済
    }

    const rate = liq === "maker" ? inst.makerFeeRate : inst.takerFeeRate;
    const feeQuote = price.mul(qty).mul(cs).mul(rate);
    const fx = this.fx(inst);
    this.cash = this.cash.plus(realizedQuote.mul(fx)).minus(feeQuote.mul(fx));
    this.realized = this.realized.plus(realizedQuote.mul(fx));

    const fill: Fill = { orderId, clientId: req.clientId, ts: now, price: price.toNumber(), qty: qty.toString(), fee: feeQuote.toString(), liquidity: liq };
    for (const l of this.listeners) l(fill, inst.symbol, req.side);
    return fill;
  }

  /** 新しいクオートを受けて、板に置いた指値の約定判定をする。約定した Fill を返す */
  onQuote(symbol: string, quote: Quote): Fill[] {
    this.quotes.set(symbol, quote);
    const inst = this.inst.get(symbol);
    const fills: Fill[] = [];
    if (!inst) return fills;
    for (const r of [...this.resting.values()]) {
      if (r.req.symbol !== symbol) continue;
      const isBuy = r.req.side === "buy";
      if (!(isBuy ? quote.ask <= r.limitPrice.toNumber() : quote.bid >= r.limitPrice.toNumber())) continue;
      this.resting.delete(r.orderId);
      // 売りでドテン防止: 空売り不可銘柄で保有が減っていたら取消
      const cur = this.positions.get(symbol)?.qty ?? D(0);
      if ((!inst.allowShort && !isBuy && r.qty.gt(Decimal.max(cur, 0))) || !this.canAfford(inst, r.req.side, r.qty, r.limitPrice)) {
        this.results.set(r.req.clientId, { orderId: r.orderId, clientId: r.req.clientId, status: "canceled", fills: [], reason: "約定時に条件を満たさず取消" });
        continue;
      }
      const fill = this.applyFill(r.req, r.orderId, inst, r.qty, r.limitPrice, "maker");
      this.results.set(r.req.clientId, { orderId: r.orderId, clientId: r.req.clientId, status: "filled", fills: [fill] });
      fills.push(fill);
    }
    return fills;
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<void> {
    const r = this.resting.get(orderId);
    if (!r) return;
    this.resting.delete(orderId);
    this.results.set(r.req.clientId, { orderId, clientId: r.req.clientId, status: "canceled", fills: [] });
  }

  // ───── 永続化 ─────

  snapshot(): PaperSnapshot {
    return {
      version: 1,
      cash: this.cash.toString(),
      realizedPnl: this.realized.toString(),
      seq: this.seq,
      positions: [...this.positions].map(([symbol, p]) => ({ symbol, qty: p.qty.toString(), avg: p.avg.toString(), openedAt: p.openedAt })),
      resting: [...this.resting.values()].map((r) => ({ orderId: r.orderId, req: r.req, qty: r.qty.toString(), limitPrice: r.limitPrice.toString(), createdAt: r.createdAt })),
      results: Object.fromEntries(this.results),
      quotes: Object.fromEntries(this.quotes),
    };
  }

  restore(s: PaperSnapshot): void {
    if (s.version !== 1) throw new Error(`未対応のスナップショット版: ${s.version}`);
    this.cash = D(s.cash);
    this.realized = D(s.realizedPnl);
    this.seq = s.seq;
    this.positions = new Map(s.positions.map((p) => [p.symbol, { qty: D(p.qty), avg: D(p.avg), openedAt: p.openedAt }]));
    this.resting = new Map(s.resting.map((r) => [r.orderId, { orderId: r.orderId, req: r.req, qty: D(r.qty), limitPrice: D(r.limitPrice), createdAt: r.createdAt }]));
    this.results = new Map(Object.entries(s.results));
    this.quotes = new Map(Object.entries(s.quotes));
  }

  toJSON(): PaperSnapshot {
    return this.snapshot();
  }
}
