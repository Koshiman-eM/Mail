import { D, Decimal } from "../core/decimal";
import { createLogger, type Logger } from "../core/logger";
import type {
  Broker, BrokerPosition, ExitReason, Fill, Instrument, OrderRequest, OrderResult, PositionView, Quote, Store, TradeRecord,
} from "../core/types";
import type { OpenTrade, OpenTradeInput, TradeJournal } from "../learning/journal";
import { normalizeCurrency } from "./fx";
import { isFinalStatus, PendingOrders, type PendingEntry, type PendingOrder } from "./orders";

/** エントリー時に決まる決済ルール (TradeJournal に無い分) */
export interface ExitPlan {
  /** トレーリング幅 (0.01 = 1%) */
  trailingStopPct?: number;
  /** 最大保有時間 (0 / 未設定なら時間切れなし) */
  maxHoldMs?: number;
  /** 一部約定で残った分は、決済判定に該当しなくても次のティックで同じ理由で決済する */
  retryExit?: { reason: ExitReason; intendedPrice: number };
}

export interface ExitDecision {
  reason: ExitReason;
  /** 意図した決済価格 (ストップ価格・利確価格・判定時点の価格) */
  intendedPrice: number;
}

export interface CloseResult {
  /**
   * closed: 全量を決済 / reduced: 一部約定 (残りは追跡を続ける) / pending: 保留中 (照会で確定させる) /
   * throttled: 決済注文の発注レート上限 / rejected: 不成立 / error: 発注できなかった / none: 何もしていない
   */
  status: "closed" | "reduced" | "pending" | "rejected" | "error" | "throttled" | "none";
  trade?: TradeRecord;
  reason?: string;
}

export interface EntryResult {
  status: "opened" | "pending" | "rejected";
  position?: OpenTrade;
  reason?: string;
}

/** 保留中の注文の照会結果 */
export interface SyncResult {
  opened: OpenTrade[];
  /** 決済 (一部決済を含む) した TradeRecord */
  closed: TradeRecord[];
  rejected: number;
  pending: number;
}

export interface OrderPolicy {
  /** 成行がこの時間を過ぎても確定しなければ取消してから再照会する */
  cancelAfterMs: number;
  /** 状態不明がこの回数続いたら kill switch (onUnknown) */
  maxUnknownCount: number;
  /** 状態不明がこの時間続いたら kill switch (onUnknown) */
  maxUnknownMs: number;
  /** 決済注文の 1 分あたりの上限 (エントリーの上限とは別枠。損切りを止めないため) */
  maxExitOrdersPerMinute: number;
  /** 決済が約定せずに終わった後の再試行間隔 (初回。以後は倍々で maxExitRetryMs まで) */
  exitRetryMs: number;
  maxExitRetryMs: number;
}

export const DEFAULT_ORDER_POLICY: OrderPolicy = {
  cancelAfterMs: 30_000,
  maxUnknownCount: 5,
  maxUnknownMs: 120_000,
  maxExitOrdersPerMinute: 30,
  exitRetryMs: 5_000,
  maxExitRetryMs: 60_000,
};

/** 決済が約定しなかった後に建玉を確認し、無い (少ない) と何回確認したら追跡を外すか */
export const EXIT_REJECT_CONFIRMATIONS = 2;

/** reconcile で「ブローカーの建玉が追跡数量より少ない」とみなす相対誤差 */
export const RECONCILE_QTY_TOLERANCE = 0.001;
/** 決済が保有数量をこの割合以上超えて約定したら異常 (逆方向の建玉の可能性) */
const OVERFILL_TOLERANCE = 0.01;

export interface PositionManagerDeps {
  journal: TradeJournal;
  /** 銘柄の発注先 */
  brokerFor: (symbol: string) => Broker;
  /** 決済したトレードを学習へ渡す (learning.onTradeClosed) */
  onTradeClosed?: (t: TradeRecord) => unknown;
  /** 発注の記録 (risk.recordOrder) */
  onOrder?: (now: number) => void;
  store?: Store;
  logger?: Logger;
  /** 注文 clientId の接頭辞 */
  clientIdPrefix?: string;
  /** 決済時点の口座通貨換算 (監査ログに残し、レポートで使う) */
  toAccount?: (ccy: string) => number;
  quoteCurrencyOf?: (symbol: string) => string | undefined;
  /** 銘柄情報 (手数料の通貨換算・端数の判定) */
  instrumentOf?: (symbol: string) => Pick<Instrument, "baseCurrency" | "quoteCurrency" | "minQty"> | undefined;
  /** 通貨換算 (1 from = ? to)。換算できなければ NaN */
  fxRate?: (from: string, to: string) => number;
  /** 注文状態の不明が続いたとき (engine は risk.trip で kill switch を発動する) */
  onUnknown?: (reason: string, now: number) => void;
  orderPolicy?: Partial<OrderPolicy>;
}

/** 旧キー (mode なし)。paper 用として扱う */
const LEGACY_PLANS_KEY = "positions:exitPlans";
const plansKey = (mode: string) => `${LEGACY_PLANS_KEY}:${mode}`;
const AUDIT_THROTTLE_MS = 60_000;

const midOf = (q: Quote) => (q.bid + q.ask) / 2;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 銘柄ごとの符号付き数量の合計 (不正な値は無視) */
function sumPositions(list: BrokerPosition[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const b of list) {
    let q: Decimal;
    try {
      q = D(b.qty);
    } catch {
      continue;
    }
    if (!q.isFinite()) continue;
    out.set(b.symbol, (out.get(b.symbol) ?? D(0)).plus(q));
  }
  return out;
}

interface FillSummary {
  qty: Decimal;
  /** 加重平均の約定価格 */
  price: number;
  /** クオート通貨建ての手数料 */
  fee: Decimal;
  invalid?: string;
}

type Applied =
  | { kind: "pending"; reason?: string; unknown?: boolean }
  | { kind: "rejected"; reason: string }
  | { kind: "opened"; position: OpenTrade }
  | { kind: "closed" | "reduced"; trade: TradeRecord }
  | { kind: "none"; reason: string };

/**
 * 保有ポジションの管理。1 銘柄 1 ポジション (PaperBroker が銘柄単位でネッティングするため)。
 * - 毎ティック: 価格を journal に反映し、損切り → 利確 → トレーリング → 時間切れ の順で決済を判定する。
 * - 戦略の flat シグナル・kill switch でも決済する。
 * - 発注は成行。結果が確定 (filled / canceled / rejected) したら約定数量で journal に反映する。
 *   受付済み・未約定 (open / partially_filled) や例外で状態不明の注文は「保留中」(PendingOrders) として記録し、
 *   syncPending で照会して確定させる。保留中の注文がある銘柄には新たな注文を出さない (再送しない)。
 * - 決済の一部約定は journal.reduce で約定分だけ記録し、残りは追跡を続けて次のティックで決済する。
 */
export class PositionManager {
  private plans: Record<string, ExitPlan>;
  private seq = 0;
  private readonly closing = new Set<string>();
  private readonly lastAudit = new Map<string, number>();
  private readonly log: Logger;
  private readonly plansKey: string;
  private readonly policy: OrderPolicy;
  private exitOrderTs: number[] = [];
  /** 決済が約定しなかった銘柄の再試行待ち */
  private readonly exitBackoff = new Map<string, { rejects: number; until: number }>();
  /** ブローカーの建玉が追跡と一致しなかった連続回数 (trade id ごと。照会の一時的な欠落で外さないため) */
  private readonly mismatchObs = new Map<string, number>();
  readonly pending: PendingOrders;

  constructor(private readonly deps: PositionManagerDeps) {
    this.log = deps.logger ?? createLogger("positions");
    const mode = deps.journal.mode;
    this.plansKey = plansKey(mode);
    let saved = deps.store?.kvGet<Record<string, ExitPlan>>(this.plansKey);
    if (saved === undefined && mode === "paper") saved = deps.store?.kvGet<Record<string, ExitPlan>>(LEGACY_PLANS_KEY);
    const open = new Set(deps.journal.list().map((p) => p.id));
    this.plans = Object.fromEntries(Object.entries(saved ?? {}).filter(([id]) => open.has(id)));
    this.pending = new PendingOrders({ ...(deps.store ? { store: deps.store } : {}), mode });
    this.policy = { ...DEFAULT_ORDER_POLICY, ...(deps.orderPolicy ?? {}) };
  }

  private persist(): void {
    this.deps.store?.kvSet(this.plansKey, this.plans);
  }

  get(symbol: string): OpenTrade | undefined {
    return this.deps.journal.find(symbol);
  }

  has(symbol: string): boolean {
    return this.get(symbol) !== undefined;
  }

  list(): OpenTrade[] {
    return this.deps.journal.list();
  }

  /** 銘柄に保留中の注文があるか (あれば新たな注文を出さない) */
  hasPending(symbol: string): boolean {
    return this.pending.hasSymbol(symbol);
  }

  pendingOrders(): PendingOrder[] {
    return this.pending.list();
  }

  planOf(id: string): ExitPlan {
    return { ...(this.plans[id] ?? {}) };
  }

  /** 注文の clientId (再起動後の重複を避けるため短い乱数を付ける) */
  newClientId(kind: "e" | "x", now: number): string {
    const rand = Math.random().toString(36).slice(2, 6);
    return `${this.deps.clientIdPrefix ?? "eng"}-${kind}-${now}-${++this.seq}-${rand}`;
  }

  /** トレーリングストップ価格 (当初ストップより有利な場合のみ) */
  trailingStop(p: OpenTrade): number | undefined {
    const pct = this.plans[p.id]?.trailingStopPct;
    if (!(pct !== undefined && pct > 0)) return undefined;
    if (p.direction === "long") {
      const s = p.highWater * (1 - pct);
      return s > p.initialStop ? s : undefined;
    }
    const s = p.lowWater * (1 + pct);
    return s < p.initialStop ? s : undefined;
  }

  /** 現在の実効ストップ (トレーリング込み) */
  currentStop(p: OpenTrade): number {
    return this.trailingStop(p) ?? p.initialStop;
  }

  /** 戦略へ渡すポジション情報 */
  view(p: OpenTrade): PositionView {
    return {
      symbol: p.symbol,
      qty: p.direction === "long" ? p.qty : -p.qty,
      avgPrice: p.entryPrice,
      openedAt: p.entryTs,
      strategyId: p.strategyId,
      stopLoss: this.currentStop(p),
      ...(p.takeProfit !== undefined ? { takeProfit: p.takeProfit } : {}),
      highWater: p.highWater,
      lowWater: p.lowWater,
    };
  }

  /** エントリーの約定後に登録する */
  open(input: OpenTradeInput, plan: ExitPlan): OpenTrade {
    if (this.has(input.symbol)) throw new Error(`${input.symbol} は既にポジションがあります (1 銘柄 1 ポジション)`);
    const p = this.deps.journal.open(input);
    this.plans[p.id] = {
      ...(plan.trailingStopPct !== undefined && plan.trailingStopPct > 0 ? { trailingStopPct: plan.trailingStopPct } : {}),
      ...(plan.maxHoldMs !== undefined && plan.maxHoldMs > 0 ? { maxHoldMs: plan.maxHoldMs } : {}),
    };
    this.persist();
    return p;
  }

  // ───────── エントリー ─────────

  /**
   * エントリーの成行を発注する。約定すれば約定数量・平均価格で journal に登録する。
   * 未約定・状態不明は保留中として記録し、syncPending で確定させる (その間この銘柄には発注しない)。
   */
  async enter(req: OrderRequest, entry: PendingEntry, now: number): Promise<EntryResult> {
    const symbol = req.symbol;
    if (this.has(symbol)) return { status: "rejected", reason: "既にポジションがあります" };
    if (this.hasPending(symbol)) return { status: "rejected", reason: "保留中の注文があります" };
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(symbol);
    } catch (e) {
      return { status: "rejected", reason: errMsg(e) };
    }
    const o: PendingOrder = {
      clientId: req.clientId, symbol, side: req.side, qty: req.qty, kind: "entry", createdAt: now, status: "submitting", unknownCount: 0, entry,
    };
    // 発注前に書き込む (発注中に停止しても再起動後に clientId で照会できる)
    this.pending.upsert(o);
    let res: OrderResult;
    try {
      res = await broker.placeOrder(req);
    } catch (e) {
      this.deps.onOrder?.(now);
      const msg = errMsg(e);
      this.log.error("発注の結果が不明です (保留中として照会を続けます)", { symbol, clientId: req.clientId, error: msg });
      this.deps.store?.audit({ ts: now, type: "engine.order_error", data: { symbol, strategyId: req.strategyId, clientId: req.clientId, error: msg, pending: true } });
      this.markUnknown(o, now, `発注で例外: ${msg}`);
      return { status: "pending", reason: msg };
    }
    this.deps.onOrder?.(now);
    const a = this.applyResult(o, res, now);
    if (a.kind === "opened") return { status: "opened", position: a.position };
    if (a.kind === "pending") return { status: "pending", ...(a.reason ? { reason: a.reason } : {}) };
    return { status: "rejected", reason: "reason" in a ? a.reason : a.kind };
  }

  // ───────── 決済 ─────────

  /** 決済判定 (副作用なし)。損切り → 利確 → トレーリング → 時間切れ の順 */
  checkExit(p: OpenTrade, quote: Quote, now: number): ExitDecision | undefined {
    const long = p.direction === "long";
    const { bid, ask } = quote;
    if (!(bid > 0) || !(ask > 0)) return undefined;
    const trail = this.trailingStop(p);
    const hit = (stop: number) => (long ? bid <= stop : ask >= stop);
    if (hit(p.initialStop)) {
      // 引き上げ済みのトレーリングストップを飛び越えて当初ストップまで動いた場合は、先に触れたトレーリング側で記録する
      return trail !== undefined ? { reason: "trailing", intendedPrice: trail } : { reason: "stop", intendedPrice: p.initialStop };
    }
    if (p.takeProfit !== undefined && (long ? bid >= p.takeProfit : ask <= p.takeProfit)) {
      return { reason: "take_profit", intendedPrice: p.takeProfit };
    }
    if (trail !== undefined && hit(trail)) return { reason: "trailing", intendedPrice: trail };
    const maxHold = this.plans[p.id]?.maxHoldMs;
    if (maxHold !== undefined && maxHold > 0 && now - p.entryTs >= maxHold) {
      return { reason: "time", intendedPrice: long ? bid : ask };
    }
    return undefined;
  }

  /** 毎ティックの処理: 価格反映 → 決済判定 → 必要なら決済 (保留中の注文がある銘柄は照会の結果を待つ) */
  async onQuote(symbol: string, quote: Quote, now: number): Promise<CloseResult> {
    const p0 = this.get(symbol);
    if (!p0) return { status: "none" };
    if (quote.bid > 0 && quote.ask > 0) this.deps.journal.mark(symbol, midOf(quote), now);
    if (this.hasPending(symbol)) return { status: "pending", reason: "保留中の注文があります" };
    const p = this.get(symbol)!;
    const d = this.checkExit(p, quote, now);
    if (d) return this.close(symbol, d.reason, d.intendedPrice, now);
    // 一部約定で残った分
    const retry = this.plans[p.id]?.retryExit;
    if (retry) return this.close(symbol, retry.reason, retry.intendedPrice, now);
    return { status: "none" };
  }

  private allowExitOrder(now: number): boolean {
    this.exitOrderTs = this.exitOrderTs.filter((t) => now - t < 60_000);
    return this.exitOrderTs.length < this.policy.maxExitOrdersPerMinute;
  }

  /** ポジションを成行 (reduceOnly) で決済する。保留中の注文がある銘柄には発注しない */
  async close(symbol: string, reason: ExitReason, intendedPrice: number, now: number): Promise<CloseResult> {
    const p = this.get(symbol);
    if (!p) return { status: "none", reason: "ポジションがありません" };
    if (this.closing.has(p.id)) return { status: "none", reason: "決済中" };
    if (this.hasPending(symbol)) return { status: "pending", reason: "保留中の注文があります (照会で確定させます)" };
    const backoff = this.exitBackoff.get(symbol);
    if (backoff && now < backoff.until) return { status: "throttled", reason: "決済の再試行待ち" };
    if (!this.allowExitOrder(now)) {
      this.auditThrottled(`thr|${symbol}`, now, "engine.exit_throttled", { symbol, reason, maxPerMinute: this.policy.maxExitOrdersPerMinute });
      this.log.warn("決済注文の発注レート上限のため次のティックへ持ち越します", { symbol, reason });
      return { status: "throttled", reason: "決済注文の発注レート上限" };
    }
    this.closing.add(p.id);
    try {
      let broker: Broker;
      try {
        broker = this.deps.brokerFor(symbol);
      } catch (e) {
        const msg = errMsg(e);
        this.auditThrottled(`err|${symbol}`, now, "engine.exit_error", { symbol, reason, error: msg });
        this.log.error("決済の発注先が見つかりません", { symbol, reason, error: msg });
        return { status: "error", reason: msg };
      }
      const long = p.direction === "long";
      const req: OrderRequest = {
        clientId: this.newClientId("x", now),
        symbol,
        side: long ? "sell" : "buy",
        type: "market",
        qty: D(p.qty).toString(),
        reduceOnly: true,
        strategyId: p.strategyId,
      };
      const o: PendingOrder = {
        clientId: req.clientId, symbol, side: req.side, qty: req.qty, kind: "exit", createdAt: now, status: "submitting", unknownCount: 0,
        exit: { tradeId: p.id, reason, intendedPrice },
      };
      this.pending.upsert(o);
      this.exitOrderTs.push(now);
      let res: OrderResult;
      try {
        res = await broker.placeOrder(req);
      } catch (e) {
        this.deps.onOrder?.(now);
        const msg = errMsg(e);
        this.auditThrottled(`err|${symbol}`, now, "engine.exit_error", { symbol, reason, error: msg, pending: true });
        this.log.error("決済注文の結果が不明です (保留中として照会を続けます)", { symbol, reason, error: msg });
        this.markUnknown(o, now, `発注で例外: ${msg}`);
        return { status: "pending", reason: msg };
      }
      this.deps.onOrder?.(now);
      const a = this.applyResult(o, res, now);
      switch (a.kind) {
        case "closed":
        case "reduced":
          return { status: a.kind, trade: a.trade };
        case "pending":
          return { status: "pending", ...(a.reason ? { reason: a.reason } : {}) };
        case "rejected": {
          // 建玉が既に無い (取引所側のストップ・手動決済・保有数量で減らされた決済の残り) なら追跡を整理する
          const v = await this.verifyAfterReject(broker, p.id, now);
          return { status: "rejected", reason: v ? `${a.reason} (${v})` : a.reason };
        }
        case "none":
          return { status: "none", reason: a.reason };
        default:
          return { status: "none" };
      }
    } finally {
      this.closing.delete(p.id);
    }
  }

  /** 全ポジションを決済 (kill switch 等)。保留中の注文がある銘柄は pending を返す */
  async closeAll(reason: ExitReason, now: number, quoteOf: (symbol: string) => Quote | undefined): Promise<CloseResult[]> {
    const out: CloseResult[] = [];
    for (const p of this.list()) {
      const q = quoteOf(p.symbol);
      const intended = q ? (p.direction === "long" ? q.bid : q.ask) : p.lastPrice;
      try {
        out.push(await this.close(p.symbol, reason, intended, now));
      } catch (e) {
        out.push({ status: "error", reason: errMsg(e) });
      }
    }
    return out;
  }

  // ───────── 保留中の注文 ─────────

  /** 保留中の注文を照会し、確定したものを journal に反映する (銘柄ごとに失敗を分離) */
  async syncPending(now: number): Promise<SyncResult> {
    const out: SyncResult = { opened: [], closed: [], rejected: 0, pending: 0 };
    for (const o of this.pending.list()) {
      let a: Applied;
      try {
        a = await this.syncOne(o, now);
      } catch (e) {
        this.markUnknown(o, now, `照会の処理に失敗: ${errMsg(e)}`);
        a = { kind: "pending", unknown: true };
      }
      if (a.kind === "opened") out.opened.push(a.position);
      else if (a.kind === "closed" || a.kind === "reduced") out.closed.push(a.trade);
      else if (a.kind === "rejected") out.rejected++;
      else if (a.kind === "pending") out.pending++;
    }
    return out;
  }

  private async query(broker: Broker, o: PendingOrder, now: number): Promise<OrderResult | undefined> {
    let res: OrderResult | undefined;
    try {
      res = await broker.getOrder(o.clientId, o.symbol, o.orderId);
    } catch (e) {
      this.markUnknown(o, now, `照会に失敗: ${errMsg(e)}`);
      return undefined;
    }
    if (!res) {
      this.markUnknown(o, now, "注文が見つかりません");
      return undefined;
    }
    if (res.orderId) o.orderId = String(res.orderId);
    return res;
  }

  private async syncOne(o: PendingOrder, now: number): Promise<Applied> {
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(o.symbol);
    } catch (e) {
      this.markUnknown(o, now, `発注先が見つかりません: ${errMsg(e)}`);
      return { kind: "pending", unknown: true };
    }
    let res = await this.query(broker, o, now);
    if (!res) return { kind: "pending", unknown: true };
    let stuckAfterCancel = false;
    // 成行が一定時間を過ぎても確定しない: 取消してから再照会する (取消の間に約定した分も累計の約定で反映される)
    if (!isFinalStatus(res.status) && now - o.createdAt >= this.policy.cancelAfterMs && o.orderId) {
      const first = o.cancelRequestedAt === undefined;
      try {
        await broker.cancelOrder(o.orderId, o.symbol);
      } catch (e) {
        this.log.warn("注文の取消に失敗 (約定済みの可能性があるため再照会します)", { symbol: o.symbol, clientId: o.clientId, error: errMsg(e) });
      }
      if (first) {
        o.cancelRequestedAt = now;
        this.deps.store?.audit({
          ts: now, type: "engine.order_cancel",
          data: { symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, ageMs: now - o.createdAt, status: res.status },
        });
      }
      const again = await this.query(broker, o, now);
      if (!again) return { kind: "pending", unknown: true };
      res = again;
      stuckAfterCancel = !first && !isFinalStatus(res.status);
    }
    const a = this.applyResult(o, res, now);
    if (a.kind === "pending" && !a.unknown && stuckAfterCancel) this.markUnknown(o, now, `取消後も確定しません (${res.status})`);
    return a;
  }

  /** 発注・照会の結果を反映する。確定していれば journal へ、未確定・不正な約定は保留中のまま */
  private applyResult(o: PendingOrder, res: OrderResult, now: number): Applied {
    if (res.orderId) o.orderId = String(res.orderId);
    o.status = res.status;
    o.lastCheckedAt = now;
    const sum = this.summarize(o.symbol, Array.isArray(res.fills) ? res.fills : [], now);
    if (sum.invalid) {
      this.markUnknown(o, now, sum.invalid);
      return { kind: "pending", reason: sum.invalid, unknown: true };
    }
    if (!isFinalStatus(res.status)) {
      // 受付済み・未約定 (状態は分かっている)。取消後に未確定なのは異常なので不明の回数は戻さない
      if (o.cancelRequestedAt === undefined) {
        o.unknownCount = 0;
        delete o.unknownSince;
        delete o.lastError;
      }
      this.pending.upsert(o);
      return { kind: "pending", reason: res.status };
    }
    if (res.status === "filled" && sum.qty.lte(0)) {
      const why = "約定済みだが約定明細がありません";
      this.markUnknown(o, now, why);
      return { kind: "pending", reason: why, unknown: true };
    }
    // 反映に失敗した場合は保留中に残す (次の照会で再試行し、続けば kill switch)
    const out = sum.qty.gt(0) ? this.settle(o, sum, now) : this.onNoFill(o, res, now);
    this.pending.remove(o.clientId);
    return out;
  }

  private onNoFill(o: PendingOrder, res: OrderResult, now: number): Applied {
    const reason = res.reason ?? res.status;
    if (o.kind === "entry") {
      this.deps.store?.audit({
        ts: now, type: "engine.order_rejected",
        data: { symbol: o.symbol, strategyId: o.entry?.input.strategyId, clientId: o.clientId, status: res.status, reason: res.reason },
      });
    } else {
      this.auditThrottled(`rej|${o.symbol}`, now, "engine.exit_rejected", { symbol: o.symbol, reason: o.exit?.reason, status: res.status, detail: res.reason });
      this.log.warn("決済注文が約定しませんでした", { symbol: o.symbol, reason: o.exit?.reason, status: res.status, detail: res.reason });
      // 同じ銘柄の決済は間隔を空けて再試行する (無限に連打しない)
      const rejects = (this.exitBackoff.get(o.symbol)?.rejects ?? 0) + 1;
      const wait = Math.min(this.policy.maxExitRetryMs, this.policy.exitRetryMs * 2 ** (rejects - 1));
      this.exitBackoff.set(o.symbol, { rejects, until: now + wait });
    }
    return { kind: "rejected", reason };
  }

  /** 約定を journal に反映する */
  private settle(o: PendingOrder, sum: FillSummary, now: number): Applied {
    const delayed = o.createdAt !== now;
    if (o.kind === "entry") {
      const e = o.entry;
      if (!e) throw new Error(`エントリー情報がありません: ${o.clientId}`);
      if (this.has(o.symbol)) {
        const msg = `${o.symbol}: 追跡中のポジションがある銘柄でエントリーが約定しました (qty ${sum.qty.toString()})。建玉を確認してください`;
        this.log.error(msg);
        this.deps.store?.audit({ ts: now, type: "engine.entry_conflict", data: { symbol: o.symbol, clientId: o.clientId, qty: sum.qty.toString(), price: sum.price } });
        this.deps.onUnknown?.(msg, now);
        return { kind: "none", reason: msg };
      }
      const opened = this.open({ ...e.input, qty: sum.qty.toNumber(), entryPrice: sum.price, entryFees: sum.fee.toNumber() }, e.plan);
      this.deps.store?.audit({
        ts: now,
        type: "engine.entry",
        data: {
          ...e.audit,
          tradeId: opened.id,
          symbol: o.symbol,
          strategyId: e.input.strategyId,
          qty: sum.qty.toString(),
          requestedQty: o.qty,
          price: sum.price,
          ...(delayed ? { delayed: true, orderedAt: o.createdAt } : {}),
        },
      });
      return { kind: "opened", position: opened };
    }

    const x = o.exit;
    if (!x) throw new Error(`決済情報がありません: ${o.clientId}`);
    this.exitBackoff.delete(o.symbol);
    const p = this.deps.journal.get(x.tradeId);
    if (!p) {
      this.log.warn("追跡していないポジションの決済が約定しました", { symbol: o.symbol, tradeId: x.tradeId, qty: sum.qty.toString() });
      this.deps.store?.audit({ ts: now, type: "engine.exit_untracked", data: { symbol: o.symbol, tradeId: x.tradeId, clientId: o.clientId, qty: sum.qty.toString(), price: sum.price } });
      return { kind: "none", reason: "追跡していないポジション" };
    }
    const tracked = D(p.qty);
    const remain = tracked.minus(sum.qty);
    const minQty = this.deps.instrumentOf?.(o.symbol)?.minQty ?? 0;
    // 最小数量未満の残りは決済できない端数なので全量決済として扱う
    const dust = remain.gt(0) && minQty > 0 && remain.lt(minQty);
    const input = { exitPrice: sum.price, intendedExitPrice: x.intendedPrice, exitTs: now, exitReason: x.reason, fees: sum.fee.toNumber() };
    let trade: TradeRecord;
    let kind: "closed" | "reduced";
    if (remain.lte(tracked.mul(1e-9)) || dust) {
      if (sum.qty.minus(tracked).gt(tracked.mul(OVERFILL_TOLERANCE))) {
        const msg = `${o.symbol}: 決済が保有数量を超えて約定しました (${sum.qty.toString()} > ${tracked.toString()})。逆方向の建玉が無いか確認してください`;
        this.log.error(msg);
        this.deps.store?.audit({ ts: now, type: "engine.exit_overfill", data: { symbol: o.symbol, tradeId: p.id, filled: sum.qty.toString(), tracked: tracked.toString() } });
        this.deps.onUnknown?.(msg, now);
      }
      if (dust) this.deps.store?.audit({ ts: now, type: "engine.exit_dust", data: { symbol: o.symbol, tradeId: p.id, remaining: remain.toString(), minQty } });
      trade = this.deps.journal.close({ id: p.id, ...input });
      delete this.plans[p.id];
      this.mismatchObs.delete(p.id);
      kind = "closed";
    } else {
      trade = this.deps.journal.reduce(p.id, { qty: sum.qty.toNumber(), ...input });
      this.plans[p.id] = { ...(this.plans[p.id] ?? {}), retryExit: { reason: x.reason, intendedPrice: x.intendedPrice } };
      this.log.warn("決済が一部約定のみ。残りは次のティックで決済します", { symbol: o.symbol, filled: sum.qty.toString(), remaining: remain.toString() });
      kind = "reduced";
    }
    this.persist();
    this.deps.onTradeClosed?.(trade);
    const ccy = this.deps.quoteCurrencyOf?.(o.symbol);
    const fxRate = ccy && this.deps.toAccount ? this.deps.toAccount(ccy) : NaN;
    this.deps.store?.audit({
      ts: now,
      type: "engine.exit",
      data: {
        tradeId: trade.id,
        symbol: o.symbol,
        strategyId: trade.strategyId,
        direction: trade.direction,
        reason: x.reason,
        exitPrice: sum.price,
        intendedExitPrice: x.intendedPrice,
        qty: sum.qty.toString(),
        netPnl: trade.netPnl,
        rMultiple: Number(trade.rMultiple.toFixed(3)),
        ...(kind === "reduced" ? { partial: true, remaining: remain.toString() } : {}),
        ...(delayed ? { delayed: true, orderedAt: o.createdAt } : {}),
        ...(Number.isFinite(fxRate) && fxRate > 0 ? { fxRate, netPnlAccount: D(trade.netPnl).mul(fxRate).toNumber() } : {}),
      },
    });
    return { kind, trade };
  }

  /** 約定の集計。数量・価格が不正な約定があれば invalid (状態不明として扱う) */
  private summarize(symbol: string, fills: Fill[], now: number): FillSummary {
    let qty = D(0);
    let notional = D(0);
    let fee = D(0);
    const bad = (why: string): FillSummary => ({ qty: D(0), price: 0, fee: D(0), invalid: why });
    for (const f of fills) {
      let q: Decimal;
      try {
        q = D(f.qty);
      } catch {
        return bad(`約定数量が不正 (${String(f.qty)})`);
      }
      if (!q.isFinite() || q.isNegative()) return bad(`約定数量が不正 (${String(f.qty)})`);
      if (q.isZero()) {
        // 数量 0・手数料だけの明細 (別通貨の手数料など) も手数料は計上する
        fee = fee.plus(this.feeInQuote(symbol, f, now));
        continue;
      }
      if (typeof f.price !== "number" || !Number.isFinite(f.price) || f.price <= 0) return bad(`約定価格が不正 (${String(f.price)})`);
      qty = qty.plus(q);
      notional = notional.plus(q.mul(f.price));
      fee = fee.plus(this.feeInQuote(symbol, f, now));
    }
    return { qty, price: qty.gt(0) ? notional.div(qty).toNumber() : 0, fee };
  }

  /** 手数料をクオート通貨建てにする。換算できなければ 0 (警告と監査ログを残す) */
  private feeInQuote(symbol: string, f: Fill, now: number): Decimal {
    let fee: Decimal;
    try {
      fee = D(f.fee ?? 0);
    } catch {
      fee = D(NaN);
    }
    const unconverted = (why: string): Decimal => {
      this.log.warn("手数料をクオート通貨へ換算できないため 0 として扱います", { symbol, fee: f.fee, feeCurrency: f.feeCurrency, why });
      this.auditThrottled(`fee|${symbol}|${f.feeCurrency ?? ""}`, now, "engine.fee_unconverted", {
        symbol, orderId: f.orderId, fee: f.fee, feeCurrency: f.feeCurrency, why,
      });
      return D(0);
    };
    if (!fee.isFinite()) return unconverted("手数料が数値ではありません");
    const ccy = f.feeCurrency;
    if (!ccy || fee.isZero()) return fee;
    const inst = this.deps.instrumentOf?.(symbol);
    const quote = inst?.quoteCurrency ?? this.deps.quoteCurrencyOf?.(symbol);
    if (quote && normalizeCurrency(ccy) === normalizeCurrency(quote)) return fee;
    // ベース通貨建ての手数料は約定価格で換算する
    if (inst && normalizeCurrency(ccy) === normalizeCurrency(inst.baseCurrency) && Number.isFinite(f.price) && f.price > 0) return fee.mul(f.price);
    const r = quote && this.deps.fxRate ? this.deps.fxRate(ccy, quote) : NaN;
    if (Number.isFinite(r) && r > 0) return fee.mul(r);
    return unconverted(`${ccy} → ${quote ?? "?"} の為替が不明`);
  }

  /** 状態不明の記録。続いたら onUnknown (kill switch) */
  private markUnknown(o: PendingOrder, now: number, why: string): void {
    o.unknownCount = (o.unknownCount ?? 0) + 1;
    o.unknownSince ??= now;
    o.lastError = why;
    o.lastCheckedAt = now;
    if (o.status === "submitting") o.status = "unknown";
    this.auditThrottled(`unk|${o.clientId}`, now, "engine.order_unknown", {
      symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, count: o.unknownCount, error: why,
    });
    const tooLong = now - o.unknownSince >= this.policy.maxUnknownMs;
    if (!o.escalated && (o.unknownCount >= this.policy.maxUnknownCount || tooLong)) {
      o.escalated = true;
      const msg =
        `注文状態不明: ${o.symbol} ${o.kind === "entry" ? "エントリー" : "決済"} clientId=${o.clientId}` +
        `${o.orderId ? ` orderId=${o.orderId}` : ""} (${why})。取引所で注文と建玉を確認してください`;
      this.log.error(msg, { unknownCount: o.unknownCount, sinceMs: now - o.unknownSince });
      this.deps.store?.audit({
        ts: now, type: "engine.order_unknown_escalated",
        data: { symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, count: o.unknownCount, sinceMs: now - o.unknownSince, error: why },
      });
      this.pending.upsert(o);
      this.deps.onUnknown?.(msg, now);
      return;
    }
    this.pending.upsert(o);
  }

  // ───────── 突き合わせ ─────────

  /**
   * 決済が約定せずに終わった後、ブローカーの建玉を確認する。照会に失敗したら何もしない (迷ったら外さない)。
   * 建玉が無い・少ないことを EXIT_REJECT_CONFIRMATIONS 回確認したら、追跡を manual として整理する。
   */
  private async verifyAfterReject(broker: Broker, tradeId: string, now: number): Promise<string | undefined> {
    let list: BrokerPosition[];
    try {
      list = await broker.getPositions();
    } catch (e) {
      this.log.warn("決済が約定しなかった後の建玉の確認に失敗 (追跡は続けます)", { tradeId, error: errMsg(e) });
      return undefined;
    }
    const p = this.deps.journal.get(tradeId);
    if (!p) return undefined;
    const r = this.reconcileOne(p, sumPositions(list).get(p.symbol) ?? D(0), now, {
      price: p.lastPrice, confirmations: EXIT_REJECT_CONFIRMATIONS, phase: "exit_rejected",
    });
    if (r.kind === "orphaned" || r.kind === "reduced") {
      this.exitBackoff.delete(p.symbol);
      this.persist();
      return r.kind === "orphaned" ? "ブローカーに建玉が無いため追跡を外しました" : "ブローカーの建玉に合わせて追跡数量を減らしました";
    }
    return r.kind === "waiting" ? "建玉の不一致を確認中" : undefined;
  }

  /**
   * ブローカーの建玉との整合チェック (起動時・定期)。保留中の注文がある銘柄は対象外。
   * - ブローカーに建玉が無い (または方向が逆の) 追跡中ポジションは、現在値で手仕舞い済み (manual) として journal から外す。
   * - ブローカーの建玉が追跡数量より少なければ、差分を一部決済 (manual) として記録する。
   * いずれも TradeRecord は保存するが学習には渡さない。
   * confirmations (既定 1) 回続けて不一致を確認するまでは外さない (照会の一時的な欠落と建玉ゼロを区別できないため)。
   */
  reconcile(
    brokerPositions: BrokerPosition[],
    now: number,
    opts: { priceOf?: (symbol: string) => number | undefined; minAgeMs?: number; phase?: string; confirmations?: number } = {},
  ): { orphaned: string[]; reduced: string[]; waiting: string[]; untracked: string[]; trades: TradeRecord[] } {
    const bySymbol = sumPositions(brokerPositions);
    const orphaned: string[] = [];
    const reduced: string[] = [];
    const waiting: string[] = [];
    const trades: TradeRecord[] = [];
    const phase = opts.phase ?? "startup";
    for (const p of this.list()) {
      if (this.hasPending(p.symbol)) continue;
      if (opts.minAgeMs !== undefined && now - p.entryTs < opts.minAgeMs) continue;
      const px = opts.priceOf?.(p.symbol);
      const price = px !== undefined && Number.isFinite(px) && px > 0 ? px : p.lastPrice;
      const r = this.reconcileOne(p, bySymbol.get(p.symbol) ?? D(0), now, { price, confirmations: opts.confirmations ?? 1, phase });
      if (r.kind === "orphaned") orphaned.push(p.symbol);
      else if (r.kind === "reduced") reduced.push(p.symbol);
      else if (r.kind === "waiting") waiting.push(p.symbol);
      if (r.trade) trades.push(r.trade);
    }
    if (orphaned.length || reduced.length) this.persist();
    const tracked = new Set(this.list().map((p) => p.symbol));
    const untracked = [...bySymbol]
      .filter(([sym, q]) => !q.isZero() && !tracked.has(sym) && !this.hasPending(sym) && q.abs().gte(this.deps.instrumentOf?.(sym)?.minQty ?? 0))
      .map(([sym]) => sym);
    return { orphaned, reduced, waiting, untracked, trades };
  }

  /** 1 ポジションの突き合わせ。不一致が confirmations 回続いたら manual として外す (または減らす) */
  private reconcileOne(
    p: OpenTrade,
    brokerQty: Decimal,
    now: number,
    o: { price: number; confirmations: number; phase: string },
  ): { kind: "ok" | "waiting" | "orphaned" | "reduced"; trade?: TradeRecord } {
    const held = p.direction === "long" ? brokerQty : brokerQty.neg();
    const minQty = this.deps.instrumentOf?.(p.symbol)?.minQty ?? 0;
    const shortfall = D(p.qty).minus(Decimal.max(held, 0));
    const missing = held.lte(0);
    const short = !missing && shortfall.gt(Decimal.max(D(p.qty).mul(RECONCILE_QTY_TOLERANCE), minQty));
    if (!missing && !short) {
      this.mismatchObs.delete(p.id);
      return { kind: "ok" };
    }
    const n = (this.mismatchObs.get(p.id) ?? 0) + 1;
    const base = { tradeId: p.id, symbol: p.symbol, direction: p.direction, trackedQty: p.qty, brokerQty: brokerQty.toString(), phase: o.phase };
    if (n < o.confirmations) {
      this.mismatchObs.set(p.id, n);
      this.log.warn("ブローカーの建玉が追跡と一致しません (再確認まで追跡を続けます)", { ...base, observations: n, required: o.confirmations });
      this.deps.store?.audit({ ts: now, type: "reconcile.mismatch", data: { ...base, observations: n, required: o.confirmations } });
      return { kind: "waiting" };
    }
    this.mismatchObs.delete(p.id);
    const exit = { exitPrice: o.price, intendedExitPrice: o.price, exitTs: now, exitReason: "manual" as const };
    if (missing) {
      const t = this.deps.journal.close({ id: p.id, ...exit });
      delete this.plans[p.id];
      this.log.warn("ブローカーに建玉が無い追跡ポジションを外しました (外部で決済された可能性)", base);
      this.deps.store?.audit({ ts: now, type: "reconcile.external_close", data: { ...base, price: o.price, netPnl: t.netPnl } });
      return { kind: "orphaned", trade: t };
    }
    const t = this.deps.journal.reduce(p.id, { qty: shortfall.toNumber(), ...exit });
    this.log.warn("ブローカーの建玉が追跡数量より少ないため差分を外しました", { ...base, reducedQty: shortfall.toString() });
    this.deps.store?.audit({ ts: now, type: "reconcile.external_reduce", data: { ...base, reducedQty: shortfall.toString(), price: o.price } });
    return { kind: "reduced", trade: t };
  }

  private auditThrottled(key: string, now: number, type: string, data: Record<string, unknown>) {
    const last = this.lastAudit.get(key);
    if (last !== undefined && now - last < AUDIT_THROTTLE_MS) return;
    this.lastAudit.set(key, now);
    this.deps.store?.audit({ ts: now, type, data });
  }
}
