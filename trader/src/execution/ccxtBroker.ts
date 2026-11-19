import { createRequire } from "node:module";
import { D, Decimal, floorToStep } from "../core/decimal";
import { createLogger } from "../core/logger";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, Instrument, OrderLookupHint, OrderRequest, OrderResult, OrderStatus, Quote, Side } from "../core/types";

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
  fetchOpenOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<any[]>;
  fetchClosedOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<any[]>;
  fetchOrders?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<any[]>;
  /** bitFlyer Lightning FX の証拠金 (getcollateral)。bitflyer の ccxt インスタンスだけが持つ */
  privateGetGetcollateral?(params?: Record<string, unknown>): Promise<any>;
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
/**
 * ccxt のエラークラス (router と同じ createRequire で読む CJS 版)。
 * ESM 版 (import "ccxt") とはクラスが別物なので、instanceof に加えてプロトタイプ連鎖のクラス名でも判定する
 * (クラス階層は node_modules/ccxt/js/src/base/errors.js)。
 */
let ccxtErrors: Record<string, unknown> | undefined | null;
function ccxtErrorClasses(): Record<string, unknown> | undefined {
  if (ccxtErrors === undefined) {
    try {
      ccxtErrors = createRequire(import.meta.url)("ccxt") as Record<string, unknown>;
    } catch {
      ccxtErrors = null;
    }
  }
  return ccxtErrors ?? undefined;
}

/** e が ccxt のエラークラス name (またはその派生) か */
function isA(e: unknown, name: string): boolean {
  if (!(e instanceof Error)) return false;
  const C = ccxtErrorClasses()?.[name];
  if (typeof C === "function" && e instanceof (C as new (...a: any[]) => Error)) return true;
  for (let p: any = Object.getPrototypeOf(e); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    if (p.constructor?.name === name) return true;
  }
  return false;
}

/**
 * createOrder の例外の分類。
 * - "rejected": 注文が成立していないと確実に言える (ExchangeError 全般、RateLimitExceeded / DDoSProtection、OnMaintenance)。
 * - "unknown": 成立したか分からない (NetworkError / RequestTimeout / ExchangeNotAvailable、BadResponse / NullResponse、
 *   CancelPending、その他の OperationFailed、ccxt 以外の例外)。呼び出し側へ投げる。
 * OnMaintenance は ExchangeNotAvailable (= NetworkError) の子だが、メンテ中は受け付けられていないので先に rejected とする。
 */
export function classifyCcxtError(e: unknown): "rejected" | "unknown" {
  if (isA(e, "OnMaintenance")) return "rejected";
  if (isA(e, "RateLimitExceeded") || isA(e, "DDoSProtection")) return "rejected";
  if (isA(e, "OperationFailed")) return "unknown";
  if (isA(e, "ExchangeError")) return "rejected";
  return "unknown";
}

/** 同じ clientOrderId の再送で取引所が返す「重複」のエラーか (不成立ではなく、既存の注文の状態を返す) */
function isDuplicateOrder(e: unknown): boolean {
  if (isA(e, "DuplicateOrderId")) return true;
  if (!isA(e, "ExchangeError")) return false;
  return /duplicat\w*\W+(client|order)|(client|order)\W*(id)?\W*(is |was )?(already|duplicat)|already exist|must be unique/i.test(e instanceof Error ? e.message : "");
}

/** clientOrderId を発注に載せない取引所 (bitflyer の sendchildorder には該当項目が無い) */
const NO_CLIENT_ORDER_ID = new Set(["bitflyer"]);
/** reduceOnly を送れない取引所。デリバティブの決済は建玉の照会で数量を上限にし、照会できなければ送らない */
export const REDUCE_ONLY_UNSUPPORTED = new Set(["bitflyer"]);
/** fetchOrder("", symbol, { clientOrderId }) を ccxt が変換する取引所 (OrderNotFound を「注文なし」として信用してよい。実 API 未検証) */
const CLIENT_ID_FETCH_EXCHANGES = new Set(["binance", "binanceusdm", "binancecoinm", "okx", "bybit"]);

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
  /** clientId -> 実際に送った数量 (reduceOnly で丸めた後。getOrder の突き合わせ用) */
  private readonly sentQty = new Map<string, string>();
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
    equity = equity.plus(await this.bitflyerFxEquity());
    return { currency: ccy, equity: equity.toString(), available: free.toString() };
  }

  /**
   * bitFlyer Lightning FX の証拠金 + 未実現損益 (口座通貨建て)。ccxt の bitflyer.fetchBalance は現物口座 (getbalance) しか
   * 見ないので、デリバティブの銘柄を扱うときだけ privateGetGetcollateral で補う。
   * 注意: 実 API では未検証 (応答の collateral / open_position_pnl は JPY 建てという前提)。
   * 失敗したら例外 (評価額が欠けたまま返さない。エンジンは失敗時に前回の値を使う)。
   */
  private async bitflyerFxEquity(): Promise<Decimal> {
    if (this.ex.id !== "bitflyer") return D(0);
    if (!this.o.instruments.some((i) => !this.isSpot(i.symbol))) return D(0);
    if (typeof this.ex.privateGetGetcollateral !== "function") throw new Error(`${this.venue}: privateGetGetcollateral に未対応のため FX 証拠金を取得できません`);
    const r = await this.ex.privateGetGetcollateral();
    const collateral = dec(r?.collateral);
    const pnl = dec(r?.open_position_pnl);
    if (!collateral || !pnl) throw new Error(`${this.venue}: getcollateral の応答が不正です`);
    const rate = this.rate("JPY");
    if (!rate) throw new Error(`${this.venue}: FX 証拠金 (JPY) を口座通貨 ${this.o.accountCurrency} に換算できません`);
    return collateral.plus(pnl).mul(rate);
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
    if (!this.canFetchPositions()) {
      if (REDUCE_ONLY_UNSUPPORTED.has(this.ex.id)) throw new Error(`${this.venue}: reduceOnly 未対応で建玉も照会できません`);
      return undefined;
    }
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
        if (spot || REDUCE_ONLY_UNSUPPORTED.has(this.ex.id)) return this.rejected(req, `保有数量を照会できないため未送信: ${msg}`, false);
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

    // bitflyer には clientOrderId / reduceOnly の項目が無く、ccxt が params をそのまま本文に入れてしまうので送らない
    const params: Record<string, unknown> = NO_CLIENT_ORDER_ID.has(this.ex.id) ? {} : { clientOrderId: req.clientId };
    // 現物 (market.spot) と reduceOnly 未対応の取引所には reduceOnly を送らない。数量は上で建玉・保有数量にクランプ済み
    if (req.reduceOnly && !spot && !REDUCE_ONLY_UNSUPPORTED.has(this.ex.id)) params.reduceOnly = true;
    this.sentQty.set(req.clientId, qty.toString());
    if (req.tif === "IOC" || req.tif === "FOK") {
      // ccxt の bitflyer は params をそのまま sendchildorder の本文に入れるので、bitFlyer API の項目名 time_in_force で渡す
      if (this.ex.id === "bitflyer") params.time_in_force = req.tif;
      else params.timeInForce = req.tif;
    }
    // protectiveStop は付けない: ccxt の多くの取引所では、エンジンが決済しても取引所側のストップ注文が自動で取り消されず、
    // 後で発動して意図しない新規建てになる危険がある (自動取消を保証できない)
    let order: any;
    try {
      order = await this.ex.createOrder(req.symbol, req.type, req.side, qty.toNumber(), req.type === "limit" ? req.limitPrice : undefined, params);
    } catch (e) {
      // 重複 clientId: 前回の送信が届いていた。不成立ではないので既存の注文の状態を返す (照会できなければ例外)
      if (isDuplicateOrder(e)) {
        const existing = await this.getOrder(req.clientId, req.symbol, undefined, { createdAt: Date.now(), side: req.side, qty: req.qty });
        if (existing) return existing;
        throw e;
      }
      // 不成立と確実に言えるものだけ rejected。ネットワーク系・不明な例外は状態不明のため投げる (getOrder で確認する)
      if (classifyCcxtError(e) === "rejected") return this.rejected(req, e instanceof Error ? e.message : String(e));
      throw e;
    }
    const orderId = String(order?.id ?? "");
    if (orderId) this.orderIds.set(req.clientId, orderId);
    const res = await this.normalize(order, { clientId: req.clientId, symbol: req.symbol, side: req.side, type: req.type }, false);
    this.done.set(req.clientId, res);
    return res;
  }

  /**
   * 注文の最新状態。orderId (無ければ発注時に記録した ID) で fetchOrder、ID が無ければ clientId で探す (lookupByClientId)。
   * - 取引所が「注文なし」と答えたときだけ undefined。
   * - 照会手段が無い・通信失敗・突き合わせが曖昧なときは例外 (状態不明。呼び出し側は未約定とみなして再送しないこと)。
   */
  async getOrder(clientId: string, symbol: string, orderId?: string, hint?: OrderLookupHint): Promise<OrderResult | undefined> {
    const cached = this.done.get(clientId);
    // 取引所へ届かずに拒否された注文 (orderId 無し) は確定済み
    if (cached && !cached.orderId && cached.status === "rejected") return cached;
    const id = orderId || this.orderIds.get(clientId) || cached?.orderId || "";
    let order: any;
    try {
      if (id) {
        if (typeof this.ex.fetchOrder !== "function") throw new Error(`${this.venue}: fetchOrder に未対応のため注文を照会できません`);
        order = await this.ex.fetchOrder(id, symbol);
      } else {
        order = await this.lookupByClientId(clientId, symbol, hint);
      }
    } catch (e) {
      if (isA(e, "OrderNotFound")) return undefined;
      throw e;
    }
    if (!order) return undefined;
    const side = order.side === "buy" || order.side === "sell" ? (order.side as Side) : undefined;
    const res = await this.normalize(order, { clientId, symbol, side, type: order.type }, true);
    if (res.orderId) this.orderIds.set(clientId, res.orderId);
    this.done.set(clientId, res);
    return res;
  }

  /** 一覧系の API を呼ぶ。未対応 (has が偽・NotSupported) なら undefined、それ以外の失敗は例外 */
  private async listOrders(name: "fetchOpenOrders" | "fetchClosedOrders" | "fetchOrders", symbol: string, since?: number): Promise<any[] | undefined> {
    const fn = this.ex[name];
    if (!this.ex.has?.[name] || typeof fn !== "function") return undefined;
    try {
      const r = name === "fetchOpenOrders" ? await fn.call(this.ex, symbol) : await fn.call(this.ex, symbol, since);
      if (!Array.isArray(r)) throw new Error(`${this.venue}: ${name} の応答が配列ではありません`);
      return r;
    } catch (e) {
      if (isA(e, "NotSupported")) return undefined;
      throw e;
    }
  }

  /**
   * orderId が無いときの照会。順に (1) fetchOrderWithClientOrderId (2) fetchOrder("", symbol, { clientOrderId })
   * (3) 未決済・決済済みの一覧から clientOrderId 一致 (4) 一覧から hint (side・数量・時刻) で突き合わせ。
   * 見つかれば ccxt の order、取引所が「無い」と確実に言えるときは undefined、それ以外は例外。
   */
  private async lookupByClientId(clientId: string, symbol: string, hint?: OrderLookupHint): Promise<any | undefined> {
    const ex = this.ex;
    if (ex.has?.fetchOrderWithClientOrderId && typeof ex.fetchOrderWithClientOrderId === "function") {
      return ex.fetchOrderWithClientOrderId(clientId, symbol); // OrderNotFound は呼び出し側で undefined
    }
    let notFoundByParam = false;
    if (typeof ex.fetchOrder === "function") {
      try {
        const o = await ex.fetchOrder("", symbol, { clientOrderId: clientId });
        if (o && o.clientOrderId === clientId) return o;
        // params を無視する取引所が別の注文を返すことがあるので、clientOrderId が一致しない応答は採用しない
      } catch (e) {
        if (isA(e, "OrderNotFound")) notFoundByParam = true;
        else if (!(isA(e, "ArgumentsRequired") || isA(e, "NotSupported") || isA(e, "BadRequest"))) throw e;
      }
    }

    const since = hint ? hint.createdAt - 60_000 : undefined;
    const open = await this.listOrders("fetchOpenOrders", symbol);
    const closed = await this.listOrders("fetchClosedOrders", symbol, since);
    let all: any[] | undefined;
    if (!closed) all = await this.listOrders("fetchOrders", symbol, since);
    const pool = [...(open ?? []), ...(closed ?? []), ...(all ?? [])];
    // 未決済と決済済みの両方 (または全件) を見られたときだけ「無い」と言える
    const covered = Boolean((open && closed) || all);
    if (!open && !closed && !all) {
      // 一覧が一つも使えない。パラメーター照会が「無い」と答え、その変換が分かっている取引所だけ信用する
      if (notFoundByParam && CLIENT_ID_FETCH_EXCHANGES.has(ex.id)) return undefined;
      throw new Error(`${this.venue}: orderId が無く、clientOrderId での照会にも未対応のため注文を照会できません`);
    }

    const hit = pool.find((o) => o?.clientOrderId === clientId);
    if (hit) return hit;
    if (!covered) throw new Error(`${this.venue}: 注文の一覧を全て取得できないため、clientId の注文の有無を確定できません`);
    // 注文に clientOrderId を持つ取引所なら、一覧に無い = 注文なし
    if (pool.some((o) => typeof o?.clientOrderId === "string" && o.clientOrderId)) return undefined;
    if (!hint) throw new Error(`${this.venue}: 注文に clientOrderId が無く、hint も無いため注文を特定できません`);
    return this.matchByHint(clientId, symbol, pool, hint);
  }

  /** clientOrderId を持たない取引所向け。side・数量 (lotSize の誤差内)・時刻で突き合わせ、ちょうど 1 件のときだけ採用する */
  private matchByHint(clientId: string, symbol: string, pool: any[], hint: OrderLookupHint): any | undefined {
    const lot = this.inst.get(symbol)?.lotSize;
    const tol = D(lot && lot > 0 ? lot : 1e-8);
    const wants = [D(hint.qty)];
    const sent = this.sentQty.get(clientId);
    if (sent) wants.push(D(sent)); // reduceOnly で丸めた後の数量
    const claimed = new Set([...this.orderIds].filter(([cid]) => cid !== clientId).map(([, oid]) => oid));
    const cands: any[] = [];
    let unknownTime = 0;
    for (const o of pool) {
      if (!o || o.side !== hint.side || claimed.has(String(o.id ?? ""))) continue;
      const amt = dec(o.amount);
      if (!amt || !wants.some((w) => amt.minus(w).abs().lte(tol))) continue;
      const ts = num(o.timestamp);
      if (ts === undefined) {
        unknownTime++;
        continue;
      }
      if (ts >= hint.createdAt - 10_000 && ts <= hint.createdAt + 120_000) cands.push(o);
    }
    if (unknownTime > 0) throw new Error(`${this.venue}: 時刻の無い注文があり、clientId の注文を特定できません`);
    if (cands.length > 1) throw new Error(`${this.venue}: 条件に合う注文が ${cands.length} 件あり、clientId の注文を特定できません`);
    return cands[0];
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
