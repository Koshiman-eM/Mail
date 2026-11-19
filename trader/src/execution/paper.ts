import { D, floorToStep, roundToStep, Decimal } from "../core/decimal";
import { TerminalMap, isTerminalOrder } from "../core/sweep";
import { createLogger } from "../core/logger";
import { canShort, DEFAULT_SHORT_BORROW_RATE_DAILY } from "../core/short";
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
  /**
   * クオート通貨 -> 口座通貨の換算レート (省略時は全て 1)。
   * 換算できない通貨は NaN を返す: その銘柄の新規発注は拒否し、評価には最後に分かったレートを使う。
   */
  toAccount?: (ccy: string) => number;
  /** 資産クラス別レバレッジ (証拠金計算)。既定: crypto/meme 1, fx 10, stock 2 */
  leverage?: Partial<Record<Instrument["assetClass"], number>>;
  clock?: Clock;
  /** quote が未受信のときの取得元 */
  quoteProvider?: (symbol: string) => Quote | undefined;
  /**
   * 空売りを再現する銘柄 (simulatedShort。allowShort=false の現物) の借入コストの日率 (既定 0.0004 = 0.04%/日)。
   * 建玉代金 (平均建値 × 数量) × 日率 × 経過日数 (日割り) を、買い戻しの約定の手数料に加えて計上する
   */
  shortBorrowRateDaily?: number;
}

interface Pos {
  qty: Decimal;
  avg: Decimal;
  openedAt: number;
  /**
   * 再現した空売り (allowShort=false の銘柄の負の建玉) の借入コストの計算の起点 (この時刻までの分は borrowAccrued に積んだ)。
   * 取引所で空売りできる銘柄 (FX・株) と買いの建玉には付けない (従来の会計のまま)
   */
  borrowFrom?: number;
  /** borrowFrom までに積んだ未払いの借入コスト (クオート通貨建て) */
  borrowAccrued?: Decimal;
}

const DAY_MS = 86_400_000;

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
  positions: { symbol: string; qty: string; avg: string; openedAt: number; borrowFrom?: number; borrowAccrued?: string }[];
  resting: { orderId: string; req: OrderRequest; qty: string; limitPrice: string; createdAt: number }[];
  results: Record<string, OrderResult>;
  quotes: Record<string, Quote>;
  /** 建玉・指値の銘柄定義 (restore 時に未登録なら自動登録する)。古いスナップショットには無い */
  instruments?: Instrument[];
  /** 最後に分かった換算レート (クオート通貨 -> 口座通貨)。古いスナップショットには無い */
  fxRates?: Record<string, string>;
}

const DEFAULT_LEVERAGE = { crypto: 1, meme: 1, fx: 10, stock: 2 };
const log = createLogger("paper");

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
  private results = new TerminalMap<OrderResult>({ isTerminal: isTerminalOrder }); // clientId -> 結果 (冪等性)
  private quotes = new Map<string, Quote>();
  /** 最後に分かった換算レート (クオート通貨 -> 口座通貨) */
  private lastRates = new Map<string, Decimal>();
  private readonly warned = new Set<string>();
  private listeners: ((f: Fill, symbol: string, side: "buy" | "sell") => void)[] = [];
  private readonly borrowRate: Decimal;

  constructor(private readonly o: PaperBrokerOptions) {
    for (const i of o.instruments) this.inst.set(i.symbol, i);
    this.base = o.baseCurrency;
    this.cash = D(o.initialEquity);
    this.slip = D(o.slippageBps ?? 2).div(10_000);
    this.toAcct = o.toAccount ?? (() => 1);
    this.clock = o.clock ?? systemClock;
    this.lev = { ...DEFAULT_LEVERAGE, ...(o.leverage ?? {}) };
    const br = o.shortBorrowRateDaily;
    this.borrowRate = D(br !== undefined && Number.isFinite(br) && br >= 0 ? br : DEFAULT_SHORT_BORROW_RATE_DAILY);
  }

  /** 空売りできるか (取引所で可能、または paper で再現する銘柄)。PaperBroker は paper 専用なので mode は paper */
  private shortable(inst: Instrument): boolean {
    return canShort(inst, this.mode);
  }

  /** 再現した空売りの、now までの未払いの借入コスト (クオート通貨建て)。対象外の建玉は 0 */
  private borrowOwed(p: Pos, inst: Instrument, now: number): Decimal {
    if (p.borrowFrom === undefined) return D(0);
    const days = D(Math.max(0, now - p.borrowFrom)).div(DAY_MS);
    return (p.borrowAccrued ?? D(0)).plus(p.avg.mul(p.qty.abs()).mul(this.cs(inst)).mul(this.borrowRate).mul(days));
  }

  addInstrument(i: Instrument): void {
    this.inst.set(i.symbol, i);
  }

  /** 約定通知 (指値が後から約定したときなど) */
  onFill(cb: (f: Fill, symbol: string, side: "buy" | "sell") => void): void {
    this.listeners.push(cb);
  }

  private warnOnce(key: string, msg: string, data: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(msg, data);
  }

  /** 現在の換算レート。換算できなければ undefined (1 とみなさない)。分かったレートは記録する */
  private currentFx(inst: Instrument): Decimal | undefined {
    if (inst.quoteCurrency === this.base) return D(1);
    const r = this.toAcct(inst.quoteCurrency);
    if (!(Number.isFinite(r) && r > 0)) return undefined;
    const d = D(r);
    this.lastRates.set(inst.quoteCurrency, d);
    this.warned.delete(`fx:${inst.quoteCurrency}`);
    return d;
  }

  /** 評価・決済用のレート: 現在値、無ければ最後に分かった値 */
  private fx(inst: Instrument): Decimal | undefined {
    const r = this.currentFx(inst) ?? this.lastRates.get(inst.quoteCurrency);
    if (!r) this.warnOnce(`fx:${inst.quoteCurrency}`, "口座通貨へ換算できない通貨の建玉を評価から除外します", { currency: inst.quoteCurrency, base: this.base });
    return r;
  }

  /** 建玉の銘柄定義。無ければ (古いスナップショット由来など) 警告して undefined */
  private instOf(symbol: string): Instrument | undefined {
    const i = this.inst.get(symbol);
    if (!i) this.warnOnce(`inst:${symbol}`, "銘柄定義の無い建玉を平均単価で評価します (含み損益 0・証拠金 0 とみなす)", { symbol });
    return i;
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
      const inst = this.instOf(sym);
      if (!inst) continue; // 平均単価で評価 = 含み損益 0
      const fx = this.fx(inst);
      if (!fx) continue;
      const m = marks?.[sym] !== undefined ? D(marks[sym]) : this.mark(sym, p.avg);
      // 再現した空売りの未払いの借入コストは負債として評価額から引く (決済時に手数料として現金から引く)
      u = u.plus(m.minus(p.avg).mul(p.qty).mul(this.cs(inst)).mul(fx)).minus(this.borrowOwed(p, inst, this.clock.now()).mul(fx));
    }
    return u;
  }

  private usedMargin(): Decimal {
    let m = D(0);
    for (const [sym, p] of this.positions) {
      const inst = this.instOf(sym);
      if (!inst) continue;
      const fx = this.fx(inst);
      if (!fx) continue;
      const lev = this.lev[inst.assetClass] ?? 1;
      m = m.plus(this.mark(sym, p.avg).mul(p.qty.abs()).mul(this.cs(inst)).mul(fx).div(lev));
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

  /** 注文の最新状態 (Broker 契約)。ペーパーは全量を一度に約定させるので fills がそのまま累計 */
  async getOrder(clientId: string, _symbol?: string, orderId?: string): Promise<OrderResult | undefined> {
    const r = this.results.get(clientId);
    if (r || orderId === undefined) return r;
    for (const x of this.results.values()) if (x.orderId === orderId) return x;
    return undefined;
  }

  // ───── 発注 ─────

  private reject(req: OrderRequest, reason: string): OrderResult {
    const r: OrderResult = { orderId: `paper-${++this.seq}`, clientId: req.clientId, status: "rejected", fills: [], reason };
    this.results.set(req.clientId, r);
    return r;
  }

  /** 約定後に増える建玉の必要証拠金が余力内か (換算レートが分からなければ false) */
  private canAfford(inst: Instrument, side: "buy" | "sell", qty: Decimal, price: Decimal): boolean {
    const fx = this.fx(inst);
    if (!fx) return false;
    const pos = this.positions.get(inst.symbol);
    const signed = side === "buy" ? qty : qty.neg();
    const cur = pos?.qty ?? D(0);
    const after = cur.plus(signed);
    const increase = after.abs().minus(cur.abs());
    if (increase.lte(0)) return true;
    const lev = this.lev[inst.assetClass] ?? 1;
    const need = price.mul(increase).mul(this.cs(inst)).mul(fx).div(lev);
    const fee = price.mul(qty).mul(this.cs(inst)).mul(fx).mul(inst.takerFeeRate);
    const equity = this.cash.plus(this.unrealized());
    return equity.minus(this.usedMargin()).gte(need.plus(fee));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.results.get(req.clientId);
    if (prev) return prev;
    const inst = this.inst.get(req.symbol);
    if (!inst) return this.reject(req, `未知の銘柄: ${req.symbol}`);
    // 換算できない通貨の銘柄は新規発注しない (1 とみなすと損益・証拠金を誤る)。
    // 決済 (reduceOnly) だけは最後に分かったレートで受け付ける (リスクを減らす方向なので止めない)
    const fxNow = this.currentFx(inst) ?? (req.reduceOnly ? this.lastRates.get(inst.quoteCurrency) : undefined);
    if (!fxNow) return this.reject(req, `為替レートが不明: ${inst.quoteCurrency} → ${this.base}`);

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
    if (!this.shortable(inst) && req.side === "sell" && qty.gt(Decimal.max(cur, 0))) {
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
    const fx = this.fx(inst);
    if (!fx || !this.canAfford(inst, req.side, qty, price)) return this.reject(req, "残高不足");
    const fill = this.applyFill(req, orderId, inst, qty, price, liq, fx);
    const r: OrderResult = { orderId, clientId: req.clientId, status: "filled", fills: [fill] };
    this.results.set(req.clientId, r);
    return r;
  }

  /** ネッティング付きの約定反映 (fx は呼び出し側で確認済みの換算レート) */
  private applyFill(req: OrderRequest, orderId: string, inst: Instrument, qty: Decimal, price: Decimal, liq: "maker" | "taker", fx: Decimal): Fill {
    const isBuy = req.side === "buy";
    const signed = isBuy ? qty : qty.neg();
    const pos = this.positions.get(inst.symbol);
    const cur = pos?.qty ?? D(0);
    const now = this.clock.now();
    const cs = this.cs(inst);
    let realizedQuote = D(0);
    /** 再現した空売りの借入コスト (買い戻した分。クオート通貨建て) */
    let borrowFee = D(0);
    // 取引所で空売りできない銘柄の負の建玉 (= paper で再現した空売り) だけ借入コストを積む
    const simulated = (q: Decimal) => q.isNegative() && !inst.allowShort;

    if (!pos || cur.isZero() || cur.isPositive() === signed.isPositive()) {
      const newQty = cur.plus(signed);
      const avg = pos && !cur.isZero() ? cur.abs().mul(pos.avg).plus(qty.mul(price)).div(newQty.abs()) : price;
      const next: Pos = { qty: newQty, avg, openedAt: pos && !cur.isZero() ? pos.openedAt : now };
      if (simulated(newQty)) {
        // 増し玉: それまでの建玉の分を積んでから、平均建値 × 新しい数量で起点を取り直す
        next.borrowAccrued = pos && !cur.isZero() ? this.borrowOwed(pos, inst, now) : D(0);
        next.borrowFrom = now;
      }
      this.positions.set(inst.symbol, next);
    } else {
      const closeQty = Decimal.min(cur.abs(), qty);
      const dir = cur.isPositive() ? 1 : -1;
      realizedQuote = price.minus(pos.avg).mul(closeQty).mul(dir).mul(cs);
      const remaining = qty.minus(closeQty);
      const newQty = cur.plus(signed);
      // 再現した空売りの買い戻し: 未払いの借入コストのうち買い戻した数量の分を手数料として払う (残りは持ち越す)
      let owedLeft = D(0);
      if (pos.borrowFrom !== undefined) {
        const owed = this.borrowOwed(pos, inst, now);
        borrowFee = owed.mul(closeQty).div(cur.abs());
        owedLeft = owed.minus(borrowFee);
      }
      if (newQty.isZero()) this.positions.delete(inst.symbol);
      else if (remaining.gt(0)) this.positions.set(inst.symbol, { qty: newQty, avg: price, openedAt: now, ...(simulated(newQty) ? { borrowFrom: now, borrowAccrued: D(0) } : {}) }); // ドテン
      else {
        const next: Pos = { qty: newQty, avg: pos.avg, openedAt: pos.openedAt }; // 部分決済
        if (pos.borrowFrom !== undefined) {
          next.borrowFrom = now;
          next.borrowAccrued = owedLeft;
        }
        this.positions.set(inst.symbol, next);
      }
    }

    const rate = liq === "maker" ? inst.makerFeeRate : inst.takerFeeRate;
    const feeQuote = price.mul(qty).mul(cs).mul(rate).plus(borrowFee);
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
      const fx = this.fx(inst);
      if (!fx || (!this.shortable(inst) && !isBuy && r.qty.gt(Decimal.max(cur, 0))) || !this.canAfford(inst, r.req.side, r.qty, r.limitPrice)) {
        this.results.set(r.req.clientId, { orderId: r.orderId, clientId: r.req.clientId, status: "canceled", fills: [], reason: "約定時に条件を満たさず取消" });
        continue;
      }
      const fill = this.applyFill(r.req, r.orderId, inst, r.qty, r.limitPrice, "maker", fx);
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
    // 建玉・指値で参照している銘柄の定義だけを残す (restore 先で未登録でも評価・決済できるように)
    const used = new Set<string>([...this.positions.keys(), ...[...this.resting.values()].map((r) => r.req.symbol)]);
    const instruments = [...used].map((sym) => this.inst.get(sym)).filter((i): i is Instrument => i !== undefined);
    return {
      version: 1,
      cash: this.cash.toString(),
      realizedPnl: this.realized.toString(),
      seq: this.seq,
      positions: [...this.positions].map(([symbol, p]) => ({
        symbol, qty: p.qty.toString(), avg: p.avg.toString(), openedAt: p.openedAt,
        ...(p.borrowFrom !== undefined ? { borrowFrom: p.borrowFrom, borrowAccrued: (p.borrowAccrued ?? D(0)).toString() } : {}),
      })),
      resting: [...this.resting.values()].map((r) => ({ orderId: r.orderId, req: r.req, qty: r.qty.toString(), limitPrice: r.limitPrice.toString(), createdAt: r.createdAt })),
      results: Object.fromEntries(this.results),
      quotes: Object.fromEntries(this.quotes),
      instruments,
      fxRates: Object.fromEntries([...this.lastRates].map(([c, r]) => [c, r.toString()])),
    };
  }

  /**
   * スナップショットから復元する。保存された銘柄定義のうち未登録のものは自動登録する (現在の登録を優先)。
   * 定義の無い古いスナップショットでも例外にせず、該当銘柄は平均単価で評価して警告する。
   */
  restore(s: PaperSnapshot): void {
    if (s.version !== 1) throw new Error(`未対応のスナップショット版: ${s.version}`);
    this.cash = D(s.cash);
    this.realized = D(s.realizedPnl);
    this.seq = s.seq;
    this.positions = new Map(
      s.positions.map((p) => [
        p.symbol,
        {
          qty: D(p.qty), avg: D(p.avg), openedAt: p.openedAt,
          // 再現した空売りの借入コストの起点・未払い分 (古いスナップショットには無い)
          ...(typeof p.borrowFrom === "number" && Number.isFinite(p.borrowFrom) ? { borrowFrom: p.borrowFrom, borrowAccrued: D(p.borrowAccrued ?? 0) } : {}),
        },
      ]),
    );
    this.resting = new Map(s.resting.map((r) => [r.orderId, { orderId: r.orderId, req: r.req, qty: D(r.qty), limitPrice: D(r.limitPrice), createdAt: r.createdAt }]));
    this.results = new TerminalMap<OrderResult>({ isTerminal: isTerminalOrder });
    for (const [k, v] of Object.entries(s.results)) this.results.set(k, v);
    this.quotes = new Map(Object.entries(s.quotes));
    for (const i of s.instruments ?? []) {
      if (i && typeof i.symbol === "string" && !this.inst.has(i.symbol)) this.inst.set(i.symbol, i);
    }
    for (const [c, r] of Object.entries(s.fxRates ?? {})) {
      try {
        const d = D(r);
        if (d.gt(0) && !this.lastRates.has(c)) this.lastRates.set(c, d);
      } catch {
        // 壊れた値は無視
      }
    }
    for (const p of s.positions) this.instOf(p.symbol); // 定義が無ければここで警告を出す
  }

  toJSON(): PaperSnapshot {
    return this.snapshot();
  }
}
