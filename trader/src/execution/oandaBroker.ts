import { D, Decimal } from "../core/decimal";
import { fetchJson, HttpError, redactSecrets, type FetchOptions } from "../core/http";
import { createLogger } from "../core/logger";
import { OANDA_HOSTS, toOandaSymbol, fromOandaSymbol, parseOandaTime } from "../market/feeds/oanda";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, Instrument, OrderLookupHint, OrderRequest, OrderResult } from "../core/types";

const log = createLogger("oanda-broker");

export interface OandaBrokerOptions extends LiveGuard {
  token: string;
  accountId: string;
  env?: "practice" | "live";
  fetchImpl?: typeof fetch;
  /** 価格の丸め (tickSize = displayPrecision) に使う。無い銘柄は JPY クロス 3 桁・それ以外 5 桁 */
  instruments?: Instrument[];
}

const dec = (v: unknown): Decimal | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? D(typeof v === "string" ? v : n) : undefined;
};

export class OandaBroker implements Broker {
  readonly venue = "oanda";
  readonly mode = "live" as const;
  private readonly base: string;
  private readonly done = new Map<string, OrderResult>();
  private readonly inst = new Map<string, Instrument>();
  /** 口座通貨 (commission の通貨)。getBalance か発注前に取得してキャッシュする */
  private homeCcy?: string;

  constructor(private readonly o: OandaBrokerOptions) {
    assertLive("OandaBroker", o);
    this.base = OANDA_HOSTS[o.env ?? "practice"];
    for (const i of o.instruments ?? []) this.inst.set(i.symbol, i);
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

  private get acct(): string {
    return `/v3/accounts/${this.o.accountId}`;
  }

  async getBalance(): Promise<Balance> {
    const r = await this.req<{ account: any }>("GET", `${this.acct}/summary`);
    if (typeof r.account?.currency === "string") this.homeCcy = r.account.currency;
    return { currency: r.account.currency, equity: String(r.account.NAV), available: String(r.account.marginAvailable) };
  }

  private async homeCurrency(): Promise<string | undefined> {
    if (!this.homeCcy) await this.getBalance();
    return this.homeCcy;
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const r = await this.req<{ positions: any[] }>("GET", `${this.acct}/openPositions`);
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

  /** 価格を銘柄の表示精度 (displayPrecision) に丸めた文字列。精度超過は OANDA が拒否する */
  private formatPrice(symbol: string, price: number): string {
    const tick = this.inst.get(symbol)?.tickSize;
    const dp = tick && tick > 0 ? D(tick).decimalPlaces() : symbol.includes("JPY") ? 3 : 5;
    return D(price).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
  }

  /** reduceOnly で決済できる units (ヘッジ口座では long / short を別々に持つ)。建玉が無ければ 0 */
  private async closableUnits(req: OrderRequest): Promise<Decimal> {
    let r: { position?: any };
    try {
      // 決済を遅らせないよう再試行しない (失敗時は REDUCE_ONLY に任せて送る)
      r = await this.req<{ position?: any }>("GET", `${this.acct}/positions/${toOandaSymbol(req.symbol)}`, undefined, 0);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return D(0);
      throw e;
    }
    const long = dec(r.position?.long?.units) ?? D(0);
    const short = dec(r.position?.short?.units) ?? D(0); // 負
    return req.side === "sell" ? Decimal.max(long, 0) : Decimal.max(short.neg(), 0);
  }

  private rejected(req: OrderRequest, reason: string): OrderResult {
    const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason };
    this.done.set(req.clientId, r);
    return r;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    let qty: Decimal;
    try {
      qty = D(req.qty);
    } catch {
      return this.rejected(req, `数量が不正: ${req.qty}`);
    }
    if (req.reduceOnly) {
      // REDUCE_ONLY は OANDA 側でも効くが、数量も建玉で上限にしておく。照会に失敗したら OANDA 側に任せる
      try {
        const closable = await this.closableUnits(req);
        if (closable.lte(0)) return this.rejected(req, "reduceOnly だが決済対象の建玉がありません");
        qty = Decimal.min(qty, closable);
      } catch (e) {
        log.warn("建玉の照会に失敗。REDUCE_ONLY に任せて送信します", { symbol: req.symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!qty.gt(0)) return this.rejected(req, `数量が 0 以下: ${req.qty}`);
    // commission の通貨 (口座通貨) を先に確定しておく (失敗しても発注は続ける)
    await this.homeCurrency().catch(() => undefined);

    const units = `${req.side === "buy" ? "" : "-"}${qty.toFixed()}`;
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
      order.price = this.formatPrice(req.symbol, req.limitPrice);
    }
    // 保護ストップ: 約定で開いたトレードに従属するストップ注文を付ける。OANDA ではトレードが決済されると
    // 従属する注文 (stopLossOnFill で作られた SL) も自動で取り消されるため、エンジンが先に決済しても SL が残って
    // 新規建てになることはない。決済 (reduceOnly) の注文には付けない
    if (!req.reduceOnly && req.protectiveStop !== undefined && Number.isFinite(req.protectiveStop) && req.protectiveStop > 0) {
      order.stopLossOnFill = { price: this.formatPrice(req.symbol, req.protectiveStop), timeInForce: "GTC" };
    }
    let r: any;
    try {
      r = await this.req<any>("POST", `${this.acct}/orders`, { order }, 0);
    } catch (e) {
      // 同じ clientExtensions.id の注文が既にある (前回の送信が届いていた) → 既存の注文の状態を返す
      if (e instanceof HttpError && /CLIENT_ORDER_ID_ALREADY_EXISTS/.test(e.body)) {
        const existing = await this.getOrder(req.clientId, req.symbol);
        if (existing) return existing;
        throw e; // 状態不明
      }
      // 4xx (429 を含む) は受け付けられていない明確な拒否 (証拠金不足など)。5xx/タイムアウト/通信断は状態不明なので投げる
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408) {
        return this.rejected(req, redactSecrets(e.body.slice(0, 200)));
      }
      throw e;
    }
    // 約定に手数料があるのに口座通貨が未取得なら、summary を取り直してから通貨を付ける
    if (!this.homeCcy && !(dec(r?.orderFillTransaction?.commission) ?? D(0)).isZero()) await this.homeCurrency().catch(() => undefined);
    const res = this.parse(r, req.clientId, req.type);
    this.done.set(req.clientId, res);
    return res;
  }

  /** ORDER_FILL トランザクション → Fill。価格が無ければ undefined */
  private fillFrom(f: any, clientId: string, type?: string): Fill | undefined {
    const price = dec(f?.fullVWAP) ?? dec(f?.price);
    const units = dec(f?.units);
    if (!price || !price.gt(0) || !units || units.isZero()) return undefined;
    const commission = dec(f?.commission) ?? D(0);
    return {
      orderId: String(f.orderID ?? f.id),
      clientId,
      ts: f.time ? parseOandaTime(f.time) : Date.now(),
      price: price.toNumber(),
      qty: units.abs().toString(),
      // OANDA はスプレッド型。commission (口座通貨建て・正の値で表される) があれば計上
      fee: commission.abs().toString(),
      // 口座通貨が分からず commission があるときは "UNKNOWN" (クオート通貨建てと誤認させない。エンジンが警告して 0 として記録する)
      ...(this.homeCcy ? { feeCurrency: this.homeCcy } : !commission.isZero() ? { feeCurrency: "UNKNOWN" } : {}),
      liquidity: type === "limit" ? "maker" : "taker",
    };
  }

  private parse(r: any, clientId: string, type?: string): OrderResult {
    const f = r.orderFillTransaction;
    const cancel = r.orderCancelTransaction;
    const reject = r.orderRejectTransaction;
    if (f) {
      const fill = this.fillFrom(f, clientId, type);
      const orderId = String(f.orderID ?? f.id);
      if (!fill) return { orderId, clientId, status: "open", fills: [], reason: "約定価格が不明 (照会待ち)" };
      if (!this.homeCcy && !D(fill.fee).isZero()) log.warn("口座通貨が不明のため commission の通貨を付けられません", { orderId });
      // 約定後に残りが取り消された場合は確定した部分約定
      return { orderId, clientId, status: cancel ? "canceled" : "filled", fills: [fill] };
    }
    if (cancel || reject) {
      const c = cancel ?? reject;
      return {
        orderId: String(c.orderID ?? c.id ?? ""),
        clientId,
        status: reject ? "rejected" : "canceled",
        fills: [],
        reason: c.reason ?? c.rejectReason,
      };
    }
    const c = r.orderCreateTransaction;
    return { orderId: String(c?.id ?? ""), clientId, status: "open", fills: [] };
  }

  /**
   * 注文の最新状態。clientExtensions.id で照会する (GET /orders/@{clientId})。
   * - FILLED: fillingTransactionID のトランザクションから約定を作る。
   * - CANCELLED: canceled。PENDING / TRIGGERED: open。
   * - 404 は orderId でも照会し、それでも無ければ undefined。
   *   OANDA の成行 (FOK) は即時に約定か取消になり、拒否された注文は記録が残らない (404 になる)。
   *   約定済みの注文も通常は照会できる想定だが、見つからない場合にトランザクション履歴を
   *   clientId で検索する手段は無いので undefined を返す (呼び出し側は建玉と突き合わせること)。
   */
  async getOrder(clientId: string, _symbol: string, orderId?: string, _hint?: OrderLookupHint): Promise<OrderResult | undefined> {
    const cached = this.done.get(clientId);
    if (cached && !cached.orderId && cached.status === "rejected") return cached;
    const get = async (spec: string): Promise<any | undefined> => {
      try {
        return (await this.req<{ order?: any }>("GET", `${this.acct}/orders/${spec}`)).order;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return undefined;
        throw e;
      }
    };
    let o = await get(`@${encodeURIComponent(clientId.slice(0, 128))}`);
    const id = orderId || cached?.orderId;
    if (!o && id) o = await get(encodeURIComponent(id));
    if (!o) return undefined;
    const oid = String(o.id ?? id ?? "");
    const type = o.type === "LIMIT" ? "limit" : "market";
    let res: OrderResult;
    switch (o.state) {
      case "FILLED": {
        const txId = o.fillingTransactionID;
        if (!txId) {
          res = { orderId: oid, clientId, status: "open", fills: [], reason: "約定トランザクションが不明 (照会待ち)" };
          break;
        }
        await this.homeCurrency().catch(() => undefined);
        const tx = (await this.req<{ transaction?: any }>("GET", `${this.acct}/transactions/${encodeURIComponent(String(txId))}`)).transaction;
        const fill = this.fillFrom(tx, clientId, type);
        res = fill
          ? { orderId: oid, clientId, status: "filled", fills: [fill] }
          : { orderId: oid, clientId, status: "open", fills: [], reason: "約定価格が不明 (照会待ち)" };
        break;
      }
      case "CANCELLED":
        res = { orderId: oid, clientId, status: "canceled", fills: [], ...(o.cancellingTransactionID ? { reason: `取消 (transaction ${o.cancellingTransactionID})` } : {}) };
        break;
      default: // PENDING / TRIGGERED
        res = { orderId: oid, clientId, status: "open", fills: [] };
    }
    this.done.set(clientId, res);
    return res;
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    await this.req("PUT", `${this.acct}/orders/${orderId}/cancel`, undefined, 0);
  }
}
