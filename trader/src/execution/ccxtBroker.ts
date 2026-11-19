import { D, Decimal, floorToStep } from "../core/decimal";
import { createLogger } from "../core/logger";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, Instrument, OrderRequest, OrderResult, OrderStatus, Quote, Side } from "../core/types";

const log = createLogger("ccxt-broker");

/** ccxt の認証付き exchange のうち使う部分 (テストでモック可能) */
export interface CcxtTradeLike {
  id: string;
  has?: Record<string, unknown>;
  /** loadMarkets 済みなら市場情報 (現物かどうかの判定に使う) */
  markets?: Record<string, any>;
  fetchBalance(): Promise<any>;
  fetchPositions?(symbols?: string[]): Promise<any[]>;
  createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params?: Record<string, unknown>): Promise<any>;
  cancelOrder(id: string, symbol?: string): Promise<any>;
  fetchOrder?(id: string, symbol?: string, params?: Record<string, unknown>): Promise<any>;
  fetchOrderWithClientOrderId?(clientOrderId: string, symbol?: string, params?: Record<string, unknown>): Promise<any>;
  fetchOrderTrades?(id: string, symbol?: string, since?: number, limit?: number): Promise<any[]>;
  fetchMyTrades?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<any[]>;
}

export interface CcxtBrokerOptions extends LiveGuard {
  exchange: CcxtTradeLike;
  /** 口座通貨 (例: "JPY", "USDT") */
  accountCurrency: string;
  instruments: Instrument[];
  /** 最新気配 (現物の保有を評価額に含めるのに使う) */
  quoteProvider?: (symbol: string) => Quote | undefined;
  /** 通貨 -> 口座通貨の換算レート (換算できなければ NaN) */
  toAccount?: (ccy: string) => number;
  /**
   * 応答に手数料の通貨が無いときの扱い。
   * 既定: bitflyer は "base" (現物の取引手数料は暗号資産で徴収される)、それ以外は "quote"。
   */
  unknownFeeCurrency?: "base" | "quote";
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const dec = (v: unknown): Decimal | undefined => {
  const n = num(v);
  return n === undefined ? undefined : D(typeof v === "string" ? v : n);
};
const midOf = (q: Quote | undefined): number | undefined => {
  if (!q) return undefined;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last !== undefined && q.last > 0 ? q.last : undefined;
};
/** ccxt のエラー種別名 (クラス名 or name) */
const errName = (e: unknown): string => (e instanceof Error ? `${e.constructor.name} ${e.name}` : "");

/** 明確な拒否 (注文が成立していない) とみなす ccxt のエラー */
const DEFINITE_REJECT = /InvalidOrder|InsufficientFunds|BadSymbol|PermissionDenied|AuthenticationError/;

/**
 * ccxt の status → OrderStatus。
 * canceled / expired は約定があっても確定した状態なので "canceled" (fills に部分約定を載せる)。
 */
function mapStatus(raw: string, filled: Decimal): OrderStatus {
  switch (raw) {
    case "closed": return "filled";
    case "canceled":
    case "cancelled":
    case "expired": return "canceled";
    case "rejected": return "rejected";
    default: return filled.gt(0) ? "partially_filled" : "open";
  }
}

interface OrderCtx {
  clientId: string;
  symbol: string;
  side?: Side;
  type?: string;
}

interface FeeItem {
  cost: Decimal;
  currency?: string;
}

/** 約定を価格つきで集計した結果 */
interface TradeAgg {
  qty: Decimal;
  price: Decimal;
}

function aggregateTrades(trades: any[]): TradeAgg | undefined {
  let qty = D(0);
  let notional = D(0);
  for (const t of trades) {
    const a = dec(t?.amount);
    const p = dec(t?.price);
    if (!a || !p || a.lte(0) || p.lte(0)) continue;
    qty = qty.plus(a);
    notional = notional.plus(a.mul(p));
  }
  return qty.gt(0) ? { qty, price: notional.div(qty) } : undefined;
}

export class CcxtBroker implements Broker {
  readonly venue: string;
  readonly mode = "live" as const;
  private readonly ex: CcxtTradeLike;
  private readonly inst = new Map<string, Instrument>();
  private readonly done = new Map<string, OrderResult>();
  /** clientId -> 取引所の注文 ID (getOrder の照会用) */
  private readonly orderIds = new Map<string, string>();
  private readonly warned = new Set<string>();
  private readonly unknownFee: "base" | "quote";

  constructor(private readonly o: CcxtBrokerOptions) {
    assertLive("CcxtBroker", o);
    this.ex = o.exchange;
    this.venue = `ccxt:${o.exchange.id}`;
    for (const i of o.instruments) this.inst.set(i.symbol, i);
    this.unknownFee = o.unknownFeeCurrency ?? (o.exchange.id === "bitflyer" ? "base" : "quote");
  }

  private warnOnce(key: string, msg: string, data: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(msg, { venue: this.venue, ...data });
  }

  /**
   * 現物市場か。loadMarkets 済みなら market.spot / type、未ロードなら統一シンボルの形式で判定する
   * (ccxt の先物・スワップは "BTC/USDT:USDT" のように ":決済通貨" が付き、現物には付かない)。
   */
  private isSpot(symbol: string): boolean {
    const m = this.ex.markets?.[symbol];
    if (m && typeof m === "object") {
      if (m.spot === true || m.type === "spot") return true;
      if (m.spot === false || (typeof m.type === "string" && m.type !== "spot")) return false;
    }
    return !symbol.includes(":");
  }

  private ccys(symbol: string): { base: string; quote: string } {
    const i = this.inst.get(symbol);
    if (i) return { base: i.baseCurrency, quote: i.quoteCurrency };
    const m = this.ex.markets?.[symbol];
    if (m?.base && m?.quote) return { base: String(m.base), quote: String(m.quote) };
    const [pair = ""] = symbol.split(":");
    const [base = "", quote = ""] = pair.split("/");
    return { base, quote };
  }

  /** 1 単位の ccy が口座通貨でいくらか。分からなければ undefined */
  private rate(ccy: string): Decimal | undefined {
    if (ccy === this.o.accountCurrency) return D(1);
    const r = this.o.toAccount?.(ccy);
    return r !== undefined && Number.isFinite(r) && r > 0 ? D(r) : undefined;
  }

  /** 保有通貨 1 単位の口座通貨建て評価額: 取引対象の現物銘柄の気配 (口座通貨建てを優先) → 為替換算 */
  private priceInAccount(ccy: string): Decimal | undefined {
    const acct = this.o.accountCurrency;
    const cands = this.o.instruments
      .filter((i) => i.baseCurrency === ccy && this.isSpot(i.symbol))
      .sort((a, b) => Number(b.quoteCurrency === acct) - Number(a.quoteCurrency === acct));
    for (const i of cands) {
      const mid = midOf(this.o.quoteProvider?.(i.symbol));
      const r = this.rate(i.quoteCurrency);
      if (mid !== undefined && r) return D(mid).mul(r);
    }
    return this.rate(ccy);
  }

  /** from 建ての金額を to 建てへ換算するレート (口座通貨経由)。分からなければ undefined */
  private cross(from: string, to: string): Decimal | undefined {
    if (from === to) return D(1);
    const a = this.rate(from);
    const b = this.rate(to);
    return a && b ? a.div(b) : undefined;
  }

  /**
   * 評価額 = 口座通貨の現金 + 現物の保有 (取引対象の base / quote 通貨) × 現在値 × 為替。
   * 価格が分からない通貨は評価額に含めず、警告を一度だけ出す。余力は口座通貨の free。
   */
  async getBalance(): Promise<Balance> {
    const b = await this.ex.fetchBalance();
    const ccy = this.o.accountCurrency;
    const cash = dec(b?.total?.[ccy]) ?? D(0);
    const free = dec(b?.free?.[ccy]) ?? cash;
    let equity = cash;
    const held = new Set<string>();
    for (const i of this.o.instruments) {
      if (!this.isSpot(i.symbol)) continue;
      held.add(i.baseCurrency);
      held.add(i.quoteCurrency);
    }
    held.delete(ccy);
    for (const c of held) {
      const q = dec(b?.total?.[c]);
      if (!q || q.lte(0)) continue;
      const px = this.priceInAccount(c);
      if (!px) {
        this.warnOnce(`value:${c}`, "価格が分からない保有通貨を評価額から除外します", { currency: c, qty: q.toString() });
        continue;
      }
      equity = equity.plus(q.mul(px));
    }
    return { currency: ccy, equity: equity.toString(), available: free.toString() };
  }

  private canFetchPositions(): boolean {
    return Boolean(this.ex.has?.fetchPositions) && typeof this.ex.fetchPositions === "function";
  }

  /**
   * 1 銘柄の建玉 (符号付き数量・平均単価)。bitflyer は symbols 必須 (1 銘柄だけ) なので銘柄ごとに呼ぶ。
   * 統一形式 (contracts / side long|short / entryPrice) と bitflyer の生形式 (size / side BUY|SELL / price) の両方を読む。
   */
  private async fetchPosition(symbol: string): Promise<{ qty: Decimal; avg: number }> {
    const ps = (await this.ex.fetchPositions!([symbol])) ?? [];
    const legs: { q: Decimal; px?: number }[] = [];
    for (const p of ps) {
      if (p?.symbol !== undefined && p.symbol !== symbol) continue;
      const size = dec(p?.contracts) ?? dec(p?.size);
      if (!size || size.isZero()) continue;
      const side = String(p?.side ?? "").toLowerCase();
      const signed = side === "short" || side === "sell" ? size.abs().neg() : size.abs();
      legs.push({ q: signed, px: num(p?.entryPrice) ?? num(p?.price) });
    }
    const net = legs.reduce((s, l) => s.plus(l.q), D(0));
    // 平均単価は純建玉と同じ向きの建玉の加重平均
    let w = D(0);
    let wp = D(0);
    for (const l of legs) {
      if (net.isZero() || l.q.isPositive() !== net.isPositive() || l.px === undefined) continue;
      w = w.plus(l.q.abs());
      wp = wp.plus(l.q.abs().mul(l.px));
    }
    return { qty: net, avg: w.gt(0) ? wp.div(w).toNumber() : 0 };
  }

  /**
   * 建玉。現物は残高から導出 (平均取得単価は取得できないので 0)、fetchPositions は使わない
   * (bitflyer は symbols 無しだと ArgumentsRequired を投げる)。
   * デリバティブの銘柄があるときだけ symbols を渡して fetchPositions を呼び、失敗しても現物の分は返す。
   */
  async getPositions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    const spot = this.o.instruments.filter((i) => this.isSpot(i.symbol));
    const derivs = this.o.instruments.filter((i) => !this.isSpot(i.symbol));
    if (spot.length) {
      const b = await this.ex.fetchBalance();
      for (const i of spot) {
        if (i.baseCurrency === this.o.accountCurrency) continue;
        const q = dec(b?.total?.[i.baseCurrency]);
        if (q && q.gt(0)) out.push({ symbol: i.symbol, qty: q.toString(), avgPrice: 0 });
      }
    }
    if (derivs.length) {
      // 一部の建玉だけを返すと、呼び出し側が「建玉なし」と誤認して追跡を外しかねない。
      // デリバティブの建玉を取れなければ例外にして、照会全体を「状態不明」として扱わせる。
      if (!this.canFetchPositions()) {
        throw new Error(`${this.venue}: fetchPositions に未対応のためデリバティブの建玉を取得できません (${derivs.map((i) => i.symbol).join(", ")})`);
      }
      for (const i of derivs) {
        try {
          const p = await this.fetchPosition(i.symbol);
          if (!p.qty.isZero()) out.push({ symbol: i.symbol, qty: p.qty.toString(), avgPrice: p.avg });
        } catch (e) {
          throw new Error(`${this.venue}: デリバティブの建玉取得に失敗 (${i.symbol}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return out;
  }

  /**
   * reduceOnly 注文で決済できる数量。現物は base 通貨の残高 (free、無ければ total)、
   * デリバティブは建玉。デリバティブで建玉を照会できなければ undefined (取引所側の reduceOnly に任せる)。
   */
  private async closableQty(req: OrderRequest, spot: boolean): Promise<Decimal | undefined> {
    if (spot) {
      if (req.side === "buy") return D(0); // 現物に売り建ては無い
      const b = await this.ex.fetchBalance();
      const { base } = this.ccys(req.symbol);
      return dec(b?.free?.[base]) ?? dec(b?.total?.[base]) ?? D(0);
    }
    if (!this.canFetchPositions()) return undefined;
    const p = await this.fetchPosition(req.symbol);
    return req.side === "sell" ? Decimal.max(p.qty, 0) : Decimal.max(p.qty.neg(), 0);
  }

  private rejected(req: OrderRequest, reason: string, remember = true): OrderResult {
    const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason };
    if (remember) this.done.set(req.clientId, r);
    return r;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    const spot = this.isSpot(req.symbol);
    let qty: Decimal;
    try {
      qty = D(req.qty);
    } catch {
      return this.rejected(req, `数量が不正: ${req.qty}`);
    }
    if (!qty.gt(0)) return this.rejected(req, `数量が 0 以下: ${req.qty}`);

    if (req.reduceOnly) {
      // 決済の数量はブローカーの保有数量で上限にする (現物は reduceOnly を送れないので、ここが唯一の歯止め)
      let closable: Decimal | undefined;
      try {
        closable = await this.closableQty(req, spot);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 現物は保有を確認できないまま売ると新規の売り (または残高不足) になりうるので送らない。未送信なので記録しない
        if (spot) return this.rejected(req, `保有数量を照会できないため未送信: ${msg}`, false);
        log.warn("建玉の照会に失敗。取引所側の reduceOnly に任せて送信します", { venue: this.venue, symbol: req.symbol, error: msg });
      }
      if (closable !== undefined) {
        if (closable.lte(0)) return this.rejected(req, "reduceOnly だが決済対象の保有がありません");
        if (qty.gt(closable)) {
          const lot = this.inst.get(req.symbol)?.lotSize;
          qty = lot && lot > 0 ? floorToStep(closable, lot) : closable;
        }
        if (!qty.gt(0)) return this.rejected(req, `保有 ${closable} が数量の刻み未満のため決済できません`);
      }
    }

    const params: Record<string, unknown> = { clientOrderId: req.clientId };
    // 現物 (market.spot) には reduceOnly を送らない (未対応の取引所で拒否・無視される)。数量は上で保有数量にクランプ済み
    if (req.reduceOnly && !spot) params.reduceOnly = true;
    if (req.tif === "IOC" || req.tif === "FOK") params.timeInForce = req.tif;
    // protectiveStop は付けない: ccxt の多くの取引所では、エンジンが決済しても取引所側のストップ注文が自動で取り消されず、
    // 後で発動して意図しない新規建てになる危険がある (自動取消を保証できない)
    let order: any;
    try {
      order = await this.ex.createOrder(req.symbol, req.type, req.side, qty.toNumber(), req.type === "limit" ? req.limitPrice : undefined, params);
    } catch (e) {
      // 明確な拒否のみ rejected に変換。ネットワーク系は状態不明のため呼び出し側へ投げる (getOrder で確認する)
      if (DEFINITE_REJECT.test(errName(e))) return this.rejected(req, e instanceof Error ? e.message : String(e));
      throw e;
    }
    const orderId = String(order?.id ?? "");
    if (orderId) this.orderIds.set(req.clientId, orderId);
    const res = await this.normalize(order, { clientId: req.clientId, symbol: req.symbol, side: req.side, type: req.type }, false);
    this.done.set(req.clientId, res);
    return res;
  }

  /**
   * 注文の最新状態。orderId (無ければ発注時に記録した ID) で fetchOrder、ID が無ければ
   * 取引所が対応していれば clientOrderId で照会する。
   * - 取引所が「注文なし」(OrderNotFound) と答えたときだけ undefined。
   * - 照会手段が無い・通信失敗は例外 (状態不明。呼び出し側は未約定とみなして再送しないこと)。
   */
  async getOrder(clientId: string, symbol: string, orderId?: string): Promise<OrderResult | undefined> {
    const cached = this.done.get(clientId);
    // 取引所へ届かずに拒否された注文 (orderId 無し) は確定済み
    if (cached && !cached.orderId && cached.status === "rejected") return cached;
    const id = orderId || this.orderIds.get(clientId) || cached?.orderId || "";
    let order: any;
    try {
      if (id) {
        if (typeof this.ex.fetchOrder !== "function") throw new Error(`${this.venue}: fetchOrder に未対応のため注文を照会できません`);
        order = await this.ex.fetchOrder(id, symbol);
      } else if (this.ex.has?.fetchOrderWithClientOrderId && typeof this.ex.fetchOrderWithClientOrderId === "function") {
        order = await this.ex.fetchOrderWithClientOrderId(clientId, symbol);
      } else {
        throw new Error(`${this.venue}: orderId が無く、clientOrderId での照会にも未対応のため注文を照会できません`);
      }
    } catch (e) {
      if (/OrderNotFound/.test(errName(e))) return undefined;
      throw e;
    }
    if (!order) return undefined;
    const side = order.side === "buy" || order.side === "sell" ? (order.side as Side) : undefined;
    const res = await this.normalize(order, { clientId, symbol, side, type: order.type }, true);
    if (res.orderId) this.orderIds.set(clientId, res.orderId);
    this.done.set(clientId, res);
    return res;
  }

  /** 約定価格: average → 約定明細の加重平均 → price (指値など)。分からなければ undefined (0 は不明扱い) */
  private priceOf(o: any, trades: any[]): Decimal | undefined {
    const avg = dec(o?.average);
    if (avg && avg.gt(0)) return avg;
    const agg = aggregateTrades(trades);
    if (agg) return agg.price;
    const px = dec(o?.price);
    return px && px.gt(0) ? px : undefined;
  }

  /** 約定価格が応答に無いとき、約定明細を照会して加重平均を求める (照会できなければ undefined) */
  private async lookupTradePrice(orderId: string, symbol: string): Promise<Decimal | undefined> {
    try {
      let trades: any[] | undefined;
      if (this.ex.has?.fetchOrderTrades && typeof this.ex.fetchOrderTrades === "function") {
        trades = await this.ex.fetchOrderTrades(orderId, symbol);
      } else if (this.ex.has?.fetchMyTrades && typeof this.ex.fetchMyTrades === "function") {
        trades = (await this.ex.fetchMyTrades(symbol)).filter((t) => String(t?.order ?? "") === orderId);
      }
      return trades ? aggregateTrades(trades)?.price : undefined;
    } catch (e) {
      log.warn("約定明細の照会に失敗", { venue: this.venue, orderId, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /** 手数料の一覧 (fees があればそれ、無ければ fee、どちらも無ければ約定明細の fee)。負の値はリベート */
  private feesOf(o: any, trades: any[]): FeeItem[] {
    const conv = (arr: any[]): FeeItem[] => {
      const out: FeeItem[] = [];
      for (const f of arr) {
        const cost = dec(f?.cost);
        if (!cost) continue;
        out.push({ cost, ...(typeof f?.currency === "string" && f.currency ? { currency: f.currency as string } : {}) });
      }
      return out;
    };
    if (Array.isArray(o?.fees) && o.fees.length) return conv(o.fees);
    if (o?.fee && dec(o.fee.cost) !== undefined) return conv([o.fee]);
    const out: FeeItem[] = [];
    for (const t of trades) {
      if (Array.isArray(t?.fees) && t.fees.length) out.push(...conv(t.fees));
      else if (t?.fee) out.push(...conv([t.fee]));
    }
    return out;
  }

  /**
   * ccxt の order → OrderResult (fills は累計を 1 件にまとめたもの)。
   * - 約定があるのに価格が分からない場合は約定を含めず "open" (照会に回す。価格 0 で記帳しない)。
   * - 手数料: クオート通貨はそのまま。ベース通貨は現物なら数量を補正 (買い: qty − fee、売り: qty + fee) し、
   *   fee × price でクオート換算。それ以外の通貨は換算できればクオートへ、できなければ feeCurrency を付ける。
   */
  private async normalize(o: any, ctx: OrderCtx, lookupTrades: boolean): Promise<OrderResult> {
    const orderId = String(o?.id ?? "");
    const base = { orderId, clientId: ctx.clientId };
    const trades: any[] = Array.isArray(o?.trades) ? o.trades : [];
    const filled = dec(o?.filled) ?? aggregateTrades(trades)?.qty ?? D(0);
    const status = mapStatus(String(o?.status ?? ""), filled);
    if (!filled.gt(0)) {
      // closed なのに約定数量が無い応答は確定させない (照会し直す)
      if (status === "filled") return { ...base, status: "open", fills: [], reason: "約定数量が不明 (照会待ち)" };
      return { ...base, status, fills: [] };
    }
    let price = this.priceOf(o, trades);
    if (!price && lookupTrades && orderId) price = await this.lookupTradePrice(orderId, ctx.symbol);
    if (!price) return { ...base, status: "open", fills: [], reason: "約定数量はあるが約定価格が不明 (照会待ち)" };

    const spot = this.isSpot(ctx.symbol);
    const { base: baseCcy, quote } = this.ccys(ctx.symbol);
    let qty = filled;
    let feeQuote = D(0);
    const others = new Map<string, Decimal>();
    for (const f of this.feesOf(o, trades)) {
      const c = f.currency ?? (this.unknownFee === "base" ? baseCcy : quote);
      if (c === quote) {
        feeQuote = feeQuote.plus(f.cost);
      } else if (c === baseCcy) {
        if (spot) {
          if (!ctx.side) this.warnOnce(`side:${ctx.symbol}`, "売買方向が不明のため、ベース通貨の手数料は買いとして数量を補正します", { symbol: ctx.symbol });
          qty = ctx.side === "sell" ? qty.plus(f.cost) : qty.minus(f.cost);
        }
        feeQuote = feeQuote.plus(f.cost.mul(price));
      } else {
        const r = this.cross(c, quote);
        if (r) feeQuote = feeQuote.plus(f.cost.mul(r));
        else others.set(c, (others.get(c) ?? D(0)).plus(f.cost));
      }
    }

    const ts = num(o?.lastTradeTimestamp) ?? num(o?.timestamp) ?? Date.now();
    const roles = new Set(trades.map((t) => t?.takerOrMaker).filter((x) => x === "maker" || x === "taker"));
    const liquidity: Fill["liquidity"] = roles.size === 1 ? ([...roles][0] as Fill["liquidity"]) : ctx.type === "limit" ? "maker" : "taker";
    const main: Fill = { orderId, clientId: ctx.clientId, ts, price: price.toNumber(), qty: qty.toString(), fee: feeQuote.toString(), liquidity };
    const fills: Fill[] = [main];
    let mainFeeTaken = !feeQuote.isZero();
    for (const [c, cost] of others) {
      if (!mainFeeTaken) {
        // クオート建ての手数料が無ければ、換算できない通貨の手数料を本体の約定に載せる
        main.fee = cost.toString();
        main.feeCurrency = c;
        mainFeeTaken = true;
      } else {
        // 通貨が混在する場合は数量 0 の明細で手数料だけを載せる (エンジンが feeCurrency を換算する)
        fills.push({ orderId, clientId: ctx.clientId, ts, price: price.toNumber(), qty: "0", fee: cost.toString(), feeCurrency: c, liquidity });
      }
    }
    return { ...base, status, fills };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.ex.cancelOrder(orderId, symbol);
  }
}
