/**
 * GMOコイン「取引所 レバレッジ取引」の実口座アダプター (live 専用)。
 *
 * 安全のための約束:
 * - コンストラクタの assertLive で、paper / test モードでの生成を拒否する。POST (発注・決済・取消) を許可した
 *   クライアント (allowPost) は、assertLive の後にこのクラスの中でだけ作る。
 * - レバレッジ銘柄では、反対側の建玉があるときに通常の /v1/order を出すと決済ではなく両建てになる。そのため
 *   - reduceOnly の注文は必ず /v1/closeBulkOrder (建玉の一括決済。新規建てにはならない) に送る。
 *   - reduceOnly でない注文は、送る前に次を確かめ、どれか一つでも当てはまれば送らない (両建てさせない):
 *     反対側の建玉がある / positionSummary と openPositions の建玉数量が食い違う / 反対方向の新規注文 (settleType OPEN) が
 *     未約定で残っている / どれかを照会できない。
 *   - 確認と送信は銘柄ごとに直列化する (プロセス内の mutex)。確認の後に別の発注が割り込まない。
 * - 応答の形が想定と違う (要求と違う銘柄の要素を含む・必須の項目が無い・未知のキー) ときは読み飛ばさずに例外。
 * - protectiveStop (取引所側の逆指値) は付けない: GMO の逆指値 (STOP) は新規注文として扱われ、エンジンが決済しても
 *   取引所側で自動的に取り消される保証が無い。残ると後で発動して意図しない新規建て (両建て) になる。
 * - 取引所が status ≠ 0 で答えた発注と HTTP 400/401/403/404/429 は不成立 (rejected)。それ以外 (通信エラー・タイムアウト・
 *   408 などその他の 4xx・5xx・応答の形の違い) は成立したか分からないので例外を投げる
 *   (エンジンの「状態不明」の経路で getOrder により確かめる)。
 * - clientOrderId は無い (要確認)。orderId が無い照会は、hint (発注時刻・方向・数量) で有効注文と最近の約定を突き合わせ、
 *   候補がちょうど 1 件のときだけ採用する。
 * - 指値 (maker):
 *   - 新規の指値は /v1/order の LIMIT。timeInForce は送らない (取引所の既定 = FAS (GTC) の想定)。
 *     post-only (timeInForce "SOK") は使わない: 公式資料では SOK は取引所現物だけ (要確認・未照合) で、ここで扱うのは
 *     すべてレバレッジ銘柄のため (capabilities.postOnly = false。OrderRequest.postOnly が付いていても SOK を送らない)。
 *     レバレッジ取引の手数料は maker / taker とも 0 の想定なので、post-only でなくてもコストは変わらない (要確認)。
 *   - 利確の指値の板置き (restingTakeProfit) はエンジンが live では使わない (LIMIT_TAKE_PROFIT は paper 専用) ので、能力も false にする。
 *     reduceOnly の LIMIT を受けた場合は /v1/closeBulkOrder の LIMIT (新規建てにならない) で送る。板にある間は positionSummary の
 *     sumOrderQuantity (決済注文中の数量) に数えられる (要確認) ので、決済できる数量は「建玉 − sumOrderQuantity」。
 *   - 新規の前の反対方向の注文の確認 (activeOrders) では、決済注文 (settleType CLOSE。自分の利確の指値を含む) を
 *     反対方向の新規と数えない (決済注文は両建てを作らない)。
 *   - 約定の liquidity は executionType が LIMIT なら maker とみなす (要確認: post-only でない指値が即時に約定した場合は taker)。
 *     手数料は executions の fee (正が支払い、負が受け取り = maker のリベートの想定。要確認)。
 */
import { D, Decimal, floorToStep } from "../core/decimal";
import { HttpError } from "../core/http";
import { createLogger } from "../core/logger";
import { TerminalMap, isTerminalOrder } from "../core/sweep";
import type {
  Balance, Broker, BrokerCapabilities, BrokerPosition, Fill, Instrument, OrderLookupHint, OrderRequest, OrderResult, OrderStatus,
} from "../core/types";
import { GmoApiError, GmoClient, GMO_ERROR_KIND_LABEL, unifiedToGmo, type GmoClientOptions, type GmoOrder, type GmoOrderBody } from "../market/gmo/client";
import { assertLive, type LiveGuard } from "./guard";

const log = createLogger("gmo-broker");

export interface GmoBrokerOptions extends LiveGuard {
  /** API キーなど (POST の許可はここでは渡さない。assertLive の後にこのクラスが付ける) */
  clientOptions: Omit<GmoClientOptions, "allowPost">;
  instruments: Instrument[];
  /** 口座通貨 (GMO は JPY) */
  accountCurrency?: string;
}

/** 一覧 API のページ数の上限 (100 件 × 5 ページ)。超えたら照会をあきらめて例外 (曖昧なまま採用しない) */
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
/** hint の時刻窓 (注文の時刻は発注時刻の 10 秒前〜120 秒後。ccxtBroker と同じ) */
const HINT_BEFORE_MS = 10_000;
const HINT_AFTER_MS = 120_000;
/** hint 照会で約定から候補にする時刻窓の後ろ側 (発注時刻 + 5 分)。これより後の約定は見ない */
const HINT_EXEC_AFTER_MS = 5 * 60_000;
/** hint 照会で約定から注文を確かめる (/v1/orders を呼ぶ) 上限。超えたら例外 */
const HINT_MAX_ORDER_LOOKUPS = 20;
/** 「不成立」とみなす HTTP ステータス (GMO 形式のエラー本文が無いとき) */
const REJECTED_HTTP_STATUS = new Set([400, 401, 403, 404, 429]);

function mapStatus(o: GmoOrder, executed: Decimal): OrderStatus {
  switch (o.status) {
    case "EXECUTED":
      return "filled";
    case "CANCELED":
    case "EXPIRED":
      return "canceled";
    default:
      return executed.gt(0) ? "partially_filled" : "open";
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 発注の例外の分類。rejected = 取引所に受け付けられていないと言える。unknown = 成立したか分からない */
export function classifyGmoError(e: unknown): "rejected" | "unknown" {
  if (e instanceof GmoApiError) return "rejected";
  // GMO 形式でない HTTP エラーは、処理されていないと言えるものだけ不成立。408 などその他は分からない
  if (e instanceof HttpError) return REJECTED_HTTP_STATUS.has(e.status) ? "rejected" : "unknown";
  return "unknown";
}

/** 方向別の建玉 (positionSummary) */
interface SideSummary {
  qty: Decimal;
  /** 決済注文が出ている数量 (sumOrderQuantity。要確認) */
  ordered: Decimal;
  avg: number;
}
interface PositionState {
  buy: SideSummary;
  sell: SideSummary;
}

export class GmoBroker implements Broker {
  readonly venue = "gmo";
  readonly mode = "live" as const;
  /**
   * post-only は不可 (SOK は現物だけの想定。要確認)。利確の板置きも使わない (live では LIMIT_TAKE_PROFIT を無視する)。
   * 指値のエントリーは通常の LIMIT で送る
   */
  readonly capabilities: BrokerCapabilities = { postOnly: false, restingTakeProfit: false };
  private readonly client: GmoClient;
  private readonly inst = new Map<string, Instrument>();
  private readonly ccy: string;
  private readonly done = new TerminalMap<OrderResult>({
    isTerminal: isTerminalOrder,
    onEvict: (cid) => {
      this.orderIds.delete(cid);
      this.sent.delete(cid);
    },
  });
  /** clientId -> orderId */
  private readonly orderIds = new Map<string, string>();
  /** clientId -> 実際に送った数量と決済か (hint 照会の突き合わせ用) */
  private readonly sent = new Map<string, { qty: string; close: boolean }>();
  /** 銘柄ごとの発注の直列化 (確認と送信を不可分にする) */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly o: GmoBrokerOptions) {
    assertLive("GmoBroker", o);
    // assertLive を通った後でだけ、POST を許可したクライアントを作る
    this.client = new GmoClient({ ...o.clientOptions, allowPost: true });
    this.ccy = o.accountCurrency ?? "JPY";
    for (const i of o.instruments) this.inst.set(i.symbol, i);
  }

  private gmoSymbol(symbol: string): string {
    const g = this.inst.get(symbol)?.meta?.gmoSymbol;
    return typeof g === "string" ? g : unifiedToGmo(symbol);
  }

  /** 口座の評価額 = actualProfitLoss (時価評価総額)、余力 = availableAmount (取引余力)。要確認 */
  async getBalance(): Promise<Balance> {
    const m = await this.client.getMargin();
    return { currency: this.ccy, equity: D(m.actualProfitLoss).toString(), available: D(m.availableAmount).toString() };
  }

  /** 一覧の要素の銘柄が要求と同じか確かめる (違えば読み飛ばさずに例外) */
  private assertSymbol(api: string, want: string, got: string): void {
    if (got !== want) throw new Error(`GMO: ${api} の応答に要求と違う銘柄 (${got}) が含まれます (要求 ${want})。応答の形が想定と違うため中止します`);
  }

  /** positionSummary (方向別の建玉)。要素の銘柄が違えば例外 */
  private async summary(symbol: string): Promise<PositionState> {
    const g = this.gmoSymbol(symbol);
    const r = await this.client.getPositionSummary(g);
    const empty = (): SideSummary => ({ qty: D(0), ordered: D(0), avg: 0 });
    const out: PositionState = { buy: empty(), sell: empty() };
    for (const p of r.list) {
      this.assertSymbol("positionSummary", g, p.symbol);
      const s = p.side === "BUY" ? out.buy : out.sell;
      s.qty = s.qty.plus(D(p.sumPositionQuantity));
      s.ordered = s.ordered.plus(D(p.sumOrderQuantity));
      s.avg = Number(p.averagePositionRate);
    }
    return out;
  }

  /** 一覧 API を最後のページまで取る (MAX_PAGES を超えたら例外) */
  private async allPages<T>(fetchPage: (page: number) => Promise<{ list: T[] }>, name: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await fetchPage(page);
      out.push(...r.list);
      if (r.list.length < PAGE_SIZE) return out;
    }
    throw new Error(`GMO: ${name} が ${MAX_PAGES * PAGE_SIZE} 件を超えるため照会を中止します`);
  }

  /**
   * 建玉を positionSummary と openPositions の両方で確かめる (方向別の合計数量が食い違えば例外)。
   * 新規の前の反対建玉の確認と getPositions で使う
   */
  private async verifiedPositions(symbol: string): Promise<PositionState> {
    const g = this.gmoSymbol(symbol);
    const sum = await this.summary(symbol);
    const open = await this.allPages((p) => this.client.getOpenPositions(g, p, PAGE_SIZE), "openPositions");
    let buy = D(0);
    let sell = D(0);
    for (const p of open) {
      this.assertSymbol("openPositions", g, p.symbol);
      if (p.side === "BUY") buy = buy.plus(D(p.size));
      else sell = sell.plus(D(p.size));
    }
    if (!buy.eq(sum.buy.qty) || !sell.eq(sum.sell.qty)) {
      throw new Error(
        `GMO: ${g} の建玉数量が positionSummary (買い ${sum.buy.qty} / 売り ${sum.sell.qty}) と openPositions (買い ${buy} / 売り ${sell}) で食い違います`,
      );
    }
    return sum;
  }

  /** 有効注文 (未約定) の一覧。要素の銘柄が違えば例外 */
  private async activeOrders(symbol: string): Promise<GmoOrder[]> {
    const g = this.gmoSymbol(symbol);
    const list = await this.allPages((p) => this.client.getActiveOrders(g, p, PAGE_SIZE), "activeOrders");
    for (const o of list) this.assertSymbol("activeOrders", g, o.symbol);
    return list;
  }

  /**
   * 建玉 (銘柄ごとに買い − 売りでネット。BUY は正、SELL は負)。
   * 1 銘柄でも照会に失敗した・positionSummary と openPositions が食い違う・両建て (買いと売りの両方がある) なら例外
   */
  async getPositions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const i of this.inst.values()) {
      const s = await this.verifiedPositions(i.symbol);
      if (s.buy.qty.gt(0) && s.sell.qty.gt(0)) {
        throw new Error(`GMO: ${i.symbol} が両建て (買い ${s.buy.qty} / 売り ${s.sell.qty}) になっています。取引所で確認してください`);
      }
      const net = s.buy.qty.minus(s.sell.qty);
      if (net.isZero()) continue;
      out.push({ symbol: i.symbol, qty: net.toString(), avgPrice: net.isPositive() ? s.buy.avg : s.sell.avg });
    }
    return out;
  }

  private rejected(req: OrderRequest, reason: string, remember = true): OrderResult {
    const r: OrderResult = { orderId: "", clientId: req.clientId, status: "rejected", fills: [], reason };
    if (remember) this.done.set(req.clientId, r);
    return r;
  }

  /** 指値の価格を刻みにそろえる (買いは切り捨て、売りは切り上げ = 指定より不利にしない) */
  private priceStr(inst: Instrument, side: OrderRequest["side"], price: number): string {
    const tick = D(inst.tickSize > 0 ? inst.tickSize : 1);
    const units = D(price).div(tick);
    return (side === "buy" ? units.floor() : units.ceil()).mul(tick).toFixed();
  }

  /** 銘柄ごとに直列化して fn を実行する */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    return this.withLock(this.gmoSymbol(req.symbol), () => this.placeLocked(req));
  }

  private async placeLocked(req: OrderRequest): Promise<OrderResult> {
    const prev = this.done.get(req.clientId);
    if (prev) return prev;
    const inst = this.inst.get(req.symbol);
    if (!inst) return this.rejected(req, `未知の銘柄: ${req.symbol}`);
    let qty: Decimal;
    try {
      qty = floorToStep(req.qty, inst.lotSize);
    } catch {
      return this.rejected(req, `数量が不正: ${req.qty}`);
    }
    if (!qty.isFinite() || !qty.gt(0)) return this.rejected(req, `数量が 0 以下 (刻み ${inst.lotSize} 未満): ${req.qty}`);
    if (req.type === "limit" && !(req.limitPrice !== undefined && req.limitPrice > 0)) return this.rejected(req, "指値価格が必要");
    const side = req.side === "buy" ? "BUY" : "SELL";

    if (req.reduceOnly) {
      const r = await this.closeQty(req, inst, qty);
      if (typeof r === "string") return this.rejected(req, r);
      qty = r;
    } else {
      if (qty.lt(inst.minQty)) return this.rejected(req, `数量が最小未満: ${qty} < ${inst.minQty}`);
      // 確かめられないまま送ると両建てになりうるので、照会の失敗は送らない (未送信なので記録しない)
      let pos: PositionState;
      let active: GmoOrder[];
      try {
        pos = await this.verifiedPositions(req.symbol);
        active = await this.activeOrders(req.symbol);
      } catch (e) {
        return this.rejected(req, `建玉・未約定の注文を確かめられないため未送信: ${errMsg(e)}`, false);
      }
      const opposite = req.side === "buy" ? pos.sell.qty : pos.buy.qty;
      if (opposite.gt(0)) {
        return this.rejected(req, `反対側の建玉 (${req.side === "buy" ? "売り" : "買い"} ${opposite}) があるため新規注文を送りません (両建て防止)`);
      }
      const oppSide = req.side === "buy" ? "SELL" : "BUY";
      // 決済注文 (CLOSE。自分の利確の指値を含む) は建玉を減らすだけなので数えない。反対方向の「新規」(OPEN) だけが両建ての原因
      const pendingOpen = active.filter((o) => o.side === oppSide && o.settleType === "OPEN");
      if (pendingOpen.length) {
        return this.rejected(req, `反対方向の新規注文 (未約定 ${pendingOpen.length} 件: ${pendingOpen.map((o) => o.orderId).join(", ")}) があるため新規注文を送りません (両建て防止)`);
      }
    }

    const body: GmoOrderBody = {
      symbol: this.gmoSymbol(req.symbol),
      side,
      executionType: req.type === "limit" ? "LIMIT" : "MARKET",
      size: qty.toFixed(),
      ...(req.type === "limit" ? { price: this.priceStr(inst, req.side, req.limitPrice!) } : {}),
      // 要確認: GMO の timeInForce は FAK (= IOC) / FAS (= GTC) / FOK / SOK (= Post-only)。SOK は取引所現物だけの想定で、
      // レバレッジ銘柄 (ここで扱うすべて) には送らない (postOnly は無視して通常の LIMIT)。GTC は既定に任せて送らない
      ...(req.type === "limit" && req.tif === "IOC" ? { timeInForce: "FAK" } : {}),
      ...(req.type === "limit" && req.tif === "FOK" ? { timeInForce: "FOK" } : {}),
    };
    // protectiveStop は付けない (ファイル冒頭の説明を参照)
    this.sent.set(req.clientId, { qty: qty.toString(), close: Boolean(req.reduceOnly) });
    let orderId: string;
    try {
      orderId = req.reduceOnly ? await this.client.postCloseBulkOrder(body) : await this.client.postOrder(body);
    } catch (e) {
      if (classifyGmoError(e) === "rejected") {
        const label = e instanceof GmoApiError ? GMO_ERROR_KIND_LABEL[e.kind] : "取引所が拒否";
        return this.rejected(req, `${label}: ${errMsg(e)}`);
      }
      throw e; // 状態不明 (getOrder で確かめる)
    }
    this.orderIds.set(req.clientId, orderId);
    const res: OrderResult = { orderId, clientId: req.clientId, status: "open", fills: [] };
    this.done.set(req.clientId, res);
    return res;
  }

  /**
   * reduceOnly (closeBulkOrder) で送る数量。送れないときは拒否の理由 (文字列)。
   * - 売りの決済は買い建玉、買いの決済は売り建玉が対象。
   * - 決済できる数量は「建玉 − 決済注文中 (sumOrderQuantity)」。これが 0 以下でも、有効注文に同じ方向の決済 (CLOSE) の注文が
   *   無ければ sumOrderQuantity の意味が想定と違う可能性があるので、差し引かずに建玉の数量で送る
   *   (多すぎれば取引所が拒否するだけで、closeBulkOrder は新規建てにならない)。
   * - 建玉を照会できなければ要求の数量のまま送る (同じ理由で新規建てにはならない)。
   */
  private async closeQty(req: OrderRequest, inst: Instrument, qty: Decimal): Promise<Decimal | string> {
    let pos: PositionState | undefined;
    try {
      pos = await this.summary(req.symbol);
    } catch (e) {
      log.warn("建玉の照会に失敗。closeBulkOrder (決済専用) に任せて送信します", { symbol: req.symbol, error: errMsg(e) });
    }
    let out = qty;
    if (pos) {
      const s = req.side === "sell" ? pos.buy : pos.sell;
      if (s.qty.lte(0)) return "reduceOnly だが決済対象の建玉がありません";
      let closable = Decimal.max(s.qty.minus(s.ordered), 0);
      if (closable.lte(0)) {
        const reqSide = req.side === "buy" ? "BUY" : "SELL";
        let hasClose: boolean | undefined;
        try {
          hasClose = (await this.activeOrders(req.symbol)).some((o) => o.side === reqSide && o.settleType === "CLOSE");
        } catch (e) {
          log.warn("有効注文の照会に失敗。建玉の数量で決済を送ります (closeBulkOrder は新規建てにならない)", { symbol: req.symbol, error: errMsg(e) });
        }
        if (hasClose) return `決済注文が既に出ているため、追加で決済できる建玉がありません (建玉 ${s.qty} / 決済注文中 ${s.ordered})`;
        closable = s.qty;
      }
      if (out.gt(closable)) out = floorToStep(closable, inst.lotSize);
      if (!out.gt(0)) return `建玉 ${closable} が数量の刻み未満のため決済できません`;
    }
    if (out.lt(inst.minQty)) {
      log.error("決済数量が最小発注数量未満のため取引所で決済できません。手動で決済が必要です", { symbol: req.symbol, qty: out.toString(), minQty: inst.minQty });
      return `決済数量 ${out} が最小発注数量 ${inst.minQty} 未満のため決済できません (手動で決済が必要)`;
    }
    return out;
  }

  /**
   * 注文の最新状態。orderId (無ければ発注時に記録した ID) で /v1/orders、約定があれば /v1/executions で数量・平均価格・手数料を集計する。
   * orderId が無ければ hint で突き合わせる。取引所が「無い」と答えたときだけ undefined、それ以外の失敗・曖昧さは例外。
   */
  async getOrder(clientId: string, symbol: string, orderId?: string, hint?: OrderLookupHint): Promise<OrderResult | undefined> {
    const cached = this.done.get(clientId);
    if (cached && !cached.orderId && cached.status === "rejected") return cached;
    let id = orderId || this.orderIds.get(clientId) || cached?.orderId || "";
    if (!id) {
      const found = await this.lookupByHint(clientId, symbol, hint);
      if (!found) return undefined;
      id = found;
    }
    const r = await this.client.getOrders(id);
    for (const x of r.list) this.assertSymbol("orders", this.gmoSymbol(symbol), x.symbol);
    const o = r.list.find((x) => x.orderId === id);
    if (!o) return undefined;
    const res = await this.normalize(clientId, o);
    this.orderIds.set(clientId, id);
    this.done.set(clientId, res);
    return res;
  }

  private async normalize(clientId: string, o: GmoOrder): Promise<OrderResult> {
    const base = { orderId: o.orderId, clientId };
    const executed = D(o.executedSize);
    const status = mapStatus(o, executed);
    if (!executed.gt(0)) {
      if (status === "filled") return { ...base, status: "open", fills: [], reason: "約定数量が不明 (照会待ち)" };
      return { ...base, status, fills: [] };
    }
    const ex = await this.client.getExecutions(o.orderId);
    let qty = D(0);
    let notional = D(0);
    let fee = D(0);
    let ts = 0;
    for (const e of ex.list) {
      if (e.orderId !== o.orderId) throw new Error(`GMO: executions の応答に別の注文 (${e.orderId}) の約定が含まれます (要求 ${o.orderId})`);
      const q = D(e.size);
      qty = qty.plus(q);
      notional = notional.plus(q.mul(D(e.price)));
      // 要確認: fee は正が支払い、負が受け取り (maker のリベート) の想定
      fee = fee.plus(D(e.fee));
      ts = Math.max(ts, e.timestamp);
    }
    // 約定明細が注文の約定数量に届かない (反映遅れ) なら確定させない
    if (qty.lt(executed)) return { ...base, status: "open", fills: [], reason: `約定明細の反映待ち (${qty} / ${executed})` };
    const fill: Fill = {
      orderId: o.orderId,
      clientId,
      ts: ts || o.timestamp,
      price: notional.div(qty).toNumber(),
      qty: qty.toString(),
      fee: fee.toString(),
      liquidity: o.executionType === "LIMIT" ? "maker" : "taker",
    };
    return { ...base, status, fills: [fill] };
  }

  /**
   * orderId が無い注文の照会 (clientOrderId が無いため)。有効注文と最近の約定から、方向・数量・時刻 (と決済かどうか) が合う注文を探す。
   * - ちょうど 1 件: その orderId。0 件: undefined (取引所に無い)。2 件以上: 例外。
   * - 約定は発注時刻の 10 秒前〜5 分後のものだけを見て、そこから確かめる注文 (/v1/orders) が 20 件を超えたら例外。
   * 最近の約定は /v1/latestExecutions (要確認: 直近 1 日分)。約定せずに取消・失効した注文は見つからない (undefined)。
   */
  private async lookupByHint(clientId: string, symbol: string, hint?: OrderLookupHint): Promise<string | undefined> {
    if (!hint) throw new Error("GMO: orderId が無く、hint も無いため注文を特定できません");
    const g = this.gmoSymbol(symbol);
    const lot = this.inst.get(symbol)?.lotSize;
    const tol = D(lot && lot > 0 ? lot : 1e-8).div(2);
    const sent = this.sent.get(clientId);
    const wants = [D(hint.qty), ...(sent ? [D(sent.qty)] : [])];
    const side = hint.side === "buy" ? "BUY" : "SELL";
    const inWindow = (ts: number) => ts >= hint.createdAt - HINT_BEFORE_MS && ts <= hint.createdAt + HINT_AFTER_MS;
    const sizeOk = (s: string) => wants.some((w) => D(s).minus(w).abs().lte(tol));
    const settleOk = (st: "OPEN" | "CLOSE") => !sent || (sent.close ? st === "CLOSE" : st === "OPEN");
    const claimed = new Set([...this.orderIds].filter(([cid]) => cid !== clientId).map(([, oid]) => oid));

    const active = await this.activeOrders(symbol);
    const execs = await this.allPages((p) => this.client.getLatestExecutions(g, p, PAGE_SIZE), "latestExecutions");
    const cands = new Set<string>();
    for (const o of active) {
      if (o.side !== side || claimed.has(o.orderId)) continue;
      if (sizeOk(o.size) && inWindow(o.timestamp) && settleOk(o.settleType)) cands.add(o.orderId);
    }
    // 約定から候補の注文を集め (時刻窓で先に絞る)、注文の照会で数量・時刻を確かめる
    const execIds = new Set<string>();
    for (const e of execs) {
      this.assertSymbol("latestExecutions", g, e.symbol);
      if (e.side !== side || claimed.has(e.orderId) || cands.has(e.orderId)) continue;
      if (e.timestamp < hint.createdAt - HINT_BEFORE_MS || e.timestamp > hint.createdAt + HINT_EXEC_AFTER_MS) continue;
      if (!settleOk(e.settleType)) continue;
      execIds.add(e.orderId);
    }
    if (execIds.size > HINT_MAX_ORDER_LOOKUPS) {
      throw new Error(`GMO: 発注時刻の前後の約定から確かめる注文が ${execIds.size} 件 (上限 ${HINT_MAX_ORDER_LOOKUPS}) あり、注文を特定できません`);
    }
    for (const id of execIds) {
      const r = await this.client.getOrders(id);
      for (const x of r.list) this.assertSymbol("orders", g, x.symbol);
      const o = r.list.find((x) => x.orderId === id);
      if (o && o.side === side && sizeOk(o.size) && inWindow(o.timestamp) && settleOk(o.settleType)) cands.add(id);
    }
    if (cands.size > 1) throw new Error(`GMO: 条件に合う注文が ${cands.size} 件あり、注文を特定できません`);
    return [...cands][0];
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    await this.client.postCancelOrder(orderId);
  }
}
