import { D, Decimal } from "../core/decimal";
import { fetchJson, fetchWithRetry, HttpError, redactSecrets, type FetchOptions } from "../core/http";
import { assertLive, type LiveGuard } from "./guard";
import type { Balance, Broker, BrokerPosition, Fill, OrderLookupHint, OrderRequest, OrderResult, OrderStatus } from "../core/types";

export const ALPACA_LIVE_URL = "https://api.alpaca.markets";
export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";

export interface AlpacaBrokerOptions extends LiveGuard {
  keyId: string;
  secretKey: string;
  /** ALPACA_PAPER=true なら paper-api を使う (それでも live ガードは必須) */
  paper?: boolean;
  fetchImpl?: typeof fetch;
}

const dec = (v: unknown): Decimal | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? D(typeof v === "string" ? v : n) : undefined;
};

/**
 * Alpaca の注文 status → OrderStatus。
 * canceled / expired / replaced は約定があっても確定した状態なので "canceled" (fills に部分約定を載せる)。
 * done_for_day は当日分の執行が終わっただけで翌営業日に続く場合があるため未確定として扱う。
 */
const mapStatus = (s: string, filled: Decimal): OrderStatus => {
  switch (s) {
    case "filled": return "filled";
    case "canceled":
    case "expired":
    case "replaced": return "canceled";
    case "rejected":
    case "suspended": return "rejected";
    // new / accepted / pending_new / accepted_for_bidding / partially_filled / done_for_day /
    // pending_cancel / pending_replace / stopped / calculated
    default: return filled.gt(0) ? "partially_filled" : "open";
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

  /**
   * reduceOnly 注文で決済できる数量 (Alpaca の株式には reduce_only が無いので、ここで保有数量を上限にする)。
   * 他の注文で拘束されていない qty_available があればそれを使う (決済注文の二重発注で新規の売り建てにならないように)。
   */
  private async closableQty(req: OrderRequest): Promise<Decimal> {
    let p: any;
    try {
      // 決済を長く遅らせないよう再試行は 1 回まで (失敗時は送らずに次の機会で再試行される)
      p = await this.req<any>("GET", `/v2/positions/${encodeURIComponent(req.symbol)}`, undefined, 1);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return D(0); // 建玉なし
      throw e;
    }
    const qty = dec(p?.qty);
    if (!qty || qty.isZero()) return D(0);
    const short = p?.side === "short" || qty.isNegative();
    const avail = dec(p?.qty_available);
    const held = avail !== undefined ? Decimal.min(qty.abs(), avail.abs()) : qty.abs();
    if (req.side === "sell") return short ? D(0) : held;
    return short ? held : D(0);
  }

  private rejected(req: OrderRequest, reason: string, remember = true): OrderResult {
    const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason };
    if (remember) this.done.set(req.clientId, r);
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
      let closable: Decimal;
      try {
        closable = await this.closableQty(req);
      } catch (e) {
        // 保有を確認できないまま売ると新規の売り建てになりうるので送らない。未送信なので記録しない
        return this.rejected(req, `保有数量を照会できないため未送信: ${e instanceof Error ? e.message : String(e)}`, false);
      }
      if (closable.lte(0)) return this.rejected(req, "reduceOnly だが決済対象の保有がありません");
      qty = Decimal.min(qty, closable);
    }
    if (!qty.gt(0)) return this.rejected(req, `数量が 0 以下: ${req.qty}`);
    // reduce_only は送らない (株式の注文 API に無い)。protectiveStop も付けない:
    // Alpaca のブラケット/OTO の子注文は、エンジンが別の注文で決済しても自動で取り消されず、残った売りストップが
    // 後で発動して意図しない新規の売り建てになる危険がある
    const body: Record<string, unknown> = {
      symbol: req.symbol,
      qty: qty.toFixed(), // 指数表記にしない
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
      // 同じ client_order_id の二重送信は 422 ("client_order_id must be unique")。既存注文を返して冪等にする
      // (照会が 404 / 失敗なら例外 = 状態不明)
      if (e instanceof HttpError && e.status === 422 && /client_order_id[^"]*(unique|exist|duplicat)|(duplicat|already)[^"]*client_order_id/i.test(e.body)) {
        o = await this.req<any>("GET", `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(req.clientId)}`);
      } else if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408) {
        // 4xx (429 を含む) は受け付けられていない。5xx / タイムアウト / 通信断は状態不明なので投げる
        return this.rejected(req, redactSecrets(e.body.slice(0, 200)));
      } else throw e;
    }
    const res = this.normalize(o, req.clientId, req.type);
    this.done.set(req.clientId, res);
    return res;
  }

  /**
   * 注文の最新状態。client_order_id で照会し、見つからなければ orderId で照会する。
   * 404 のときだけ undefined (それ以外の失敗は例外 = 状態不明)。
   */
  async getOrder(clientId: string, _symbol: string, orderId?: string, _hint?: OrderLookupHint): Promise<OrderResult | undefined> {
    const cached = this.done.get(clientId);
    if (cached && !cached.orderId && cached.status === "rejected") return cached;
    let o: any;
    try {
      o = await this.req<any>("GET", `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
      const id = orderId || cached?.orderId;
      if (!id) return undefined;
      try {
        o = await this.req<any>("GET", `/v2/orders/${encodeURIComponent(id)}`);
      } catch (e2) {
        if (e2 instanceof HttpError && e2.status === 404) return undefined;
        throw e2;
      }
    }
    if (!o) return undefined;
    const res = this.normalize(o, clientId);
    this.done.set(clientId, res);
    return res;
  }

  /**
   * Alpaca の order → OrderResult (fills は累計を 1 件にまとめたもの)。手数料は 0 (株式は手数料無料)。
   * 約定数量があるのに filled_avg_price が無ければ約定を含めず "open" (照会に回す)。
   */
  private normalize(o: any, clientId: string, type?: string): OrderResult {
    const orderId = String(o?.id ?? "");
    const filled = dec(o?.filled_qty) ?? D(0);
    const status = mapStatus(String(o?.status ?? ""), filled);
    if (!filled.gt(0)) {
      if (status === "filled") return { orderId, clientId, status: "open", fills: [], reason: "約定数量が不明 (照会待ち)" };
      return { orderId, clientId, status, fills: [] };
    }
    const price = dec(o?.filled_avg_price);
    if (!price || !price.gt(0)) return { orderId, clientId, status: "open", fills: [], reason: "約定数量はあるが約定価格が不明 (照会待ち)" };
    const t = Date.parse(o?.filled_at ?? o?.updated_at ?? "");
    const fill: Fill = {
      orderId,
      clientId,
      ts: Number.isFinite(t) ? t : Date.now(),
      price: price.toNumber(),
      qty: filled.toString(),
      fee: "0",
      liquidity: (type ?? o?.type) === "limit" ? "maker" : "taker",
    };
    return { orderId, clientId, status, fills: [fill] };
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
