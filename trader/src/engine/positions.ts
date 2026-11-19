import { D, Decimal } from "../core/decimal";
import { redactSecrets } from "../core/http";
import { sweepOld } from "../core/sweep";
import { createLogger, type Logger } from "../core/logger";
import type {
  Broker, BrokerPosition, ExitReason, Fill, Instrument, OrderRequest, OrderResult, PositionView, Quote, Store, TradeRecord,
} from "../core/types";
import type { OpenTrade, OpenTradeInput, TradeJournal } from "../learning/journal";
import { runGrouped, withDeadline } from "./deadline";
import { normalizeCurrency } from "./fx";
import { isFinalStatus, PendingOrders, type PendingEntry, type PendingOrder, type PositionVerdict, type ResolveRequest } from "./orders";

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
  /** closed のときの TradeRecord (一部決済は最後の決済でまとめて 1 件にする) */
  trade?: TradeRecord;
  /** reduced のときの残りのポジション */
  position?: OpenTrade;
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
  /** 全量を決済した TradeRecord */
  closed: TradeRecord[];
  /** 一部決済 (残りは追跡中) の件数 */
  reduced: number;
  rejected: number;
  pending: number;
  /** 建玉の照会で確定した注文の件数 (約定なしを含む) */
  resolved: number;
  /** 決済の拒否後の建玉確認で追跡を外した・減らした件数 */
  reconciled: number;
}

export interface OrderPolicy {
  /** 成行がこの時間を過ぎても確定しなければ取消してから再照会する */
  cancelAfterMs: number;
  /** 状態不明がこの回数続いたら escalated (新規エントリーを止め、建玉で確定させる) */
  maxUnknownCount: number;
  /** 状態不明がこの時間続いたら escalated */
  maxUnknownMs: number;
  /** 決済注文の 1 分あたりの上限 (エントリーの上限とは別枠。損切りを止めないため) */
  maxExitOrdersPerMinute: number;
  /** 決済が約定せずに終わった後の再試行間隔 (初回。以後は倍々で maxExitRetryMs まで) */
  exitRetryMs: number;
  maxExitRetryMs: number;
  /** orderId が分かっている注文が「見つからない」とき、作成からこの時間は不明として数えない (照会の反映遅れ) */
  notFoundGraceMs: number;
  /** escalated の注文を建玉で確定させるための getPositions の間隔 */
  positionCheckMs: number;
  /** 建玉による判定の許容差 (数量に対する割合。minQty と大きい方を使う) */
  positionTolerance: number;
  /** ブローカー呼び出し (発注・照会・取消・建玉) の締め切り。0 で無効 */
  brokerTimeoutMs: number;
}

export const DEFAULT_ORDER_POLICY: OrderPolicy = {
  cancelAfterMs: 30_000,
  maxUnknownCount: 5,
  maxUnknownMs: 120_000,
  maxExitOrdersPerMinute: 30,
  exitRetryMs: 5_000,
  maxExitRetryMs: 60_000,
  notFoundGraceMs: 60_000,
  positionCheckMs: 30_000,
  positionTolerance: 0.005,
  brokerTimeoutMs: 8_000,
};

/** 決済が約定しなかった後に建玉を確認し、無い (少ない) と何回確認したら追跡を外すか */
export const EXIT_REJECT_CONFIRMATIONS = 2;
/** 建玉による判定を何回続けて確認したら確定するか (一覧の反映遅れ対策) */
export const POSITION_RESOLVE_CONFIRMATIONS = 2;

/** reconcile で「ブローカーの建玉が追跡数量より少ない」とみなす相対誤差 */
export const RECONCILE_QTY_TOLERANCE = 0.001;
/** 決済が保有数量をこの割合以上超えて約定したら異常 (逆方向の建玉の可能性) */
const OVERFILL_TOLERANCE = 0.01;

export interface PositionManagerDeps {
  journal: TradeJournal;
  /** 銘柄の発注先 */
  brokerFor: (symbol: string) => Broker;
  /** 決済したトレードを学習へ渡す (learning.onTradeClosed)。推定・manual の決済では呼ばない */
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
  /** 現在値 (建玉による確定の推定価格)。無ければ追跡中の最終価格 */
  priceOf?: (symbol: string) => number | undefined;
  /**
   * 建玉の不整合が確実な異常 (追跡中の銘柄でエントリーが約定・決済が保有数量を超えて約定)。
   * engine は risk.trip で kill switch を発動する
   */
  onAnomaly?: (reason: string, now: number) => void;
  /**
   * 注文状態の不明が続いた (escalated)。kill switch は発動しない
   * (engine は新規エントリーだけを止め、建玉で確定すれば自動で再開する)
   */
  onEscalated?: (o: PendingOrder, now: number) => void;
  orderPolicy?: Partial<OrderPolicy>;
}

/** 旧キー (mode なし)。paper 用として扱う */
const LEGACY_PLANS_KEY = "positions:exitPlans";
const plansKey = (mode: string) => `${LEGACY_PLANS_KEY}:${mode}`;
const AUDIT_THROTTLE_MS = 60_000;

const midOf = (q: Quote) => (q.bid + q.ask) / 2;
/** エラー文 (ccxt は URL・署名を含みうる) は伏せてから記録する */
const errMsg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e));

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
  | { kind: "closed"; trade: TradeRecord }
  | { kind: "reduced"; position: OpenTrade }
  | { kind: "none"; reason: string };

/** 建玉 (または手動の申告) による確定の内容 */
interface Resolution {
  verdict: PositionVerdict;
  /** 約定したとみなす数量 (none なら 0) */
  qty: Decimal;
  /** 推定の約定価格 (none なら 0) */
  price: number;
  /** 判定に使った取引所の建玉 (符号付き) と追跡数量 */
  brokerQty?: string;
  trackedQty?: string;
}

/** 決済の拒否後に建玉を確認する予定 (trade id ごと。次のティックで確認する) */
interface VerifyItem {
  tradeId: string;
  symbol: string;
  at: number;
}

/**
 * 保有ポジションの管理。1 銘柄 1 ポジション (PaperBroker が銘柄単位でネッティングするため)。
 * - 毎ティック: 価格を journal に反映し、損切り → 利確 → トレーリング → 時間切れ の順で決済を判定する。
 * - 戦略の flat シグナル・kill switch でも決済する。
 * - 発注は成行。結果が確定 (filled / canceled / rejected) したら約定数量で journal に反映する。
 *   受付済み・未約定 (open / partially_filled) や例外で状態不明の注文は「保留中」(PendingOrders) として記録し、
 *   syncPending で照会して確定させる。保留中の注文がある銘柄には新たな注文を出さない (再送しない)。
 * - 状態不明が続いた注文 (escalated) は、ブローカーの建玉で確定させる (同じ判定が 2 回続いたら)。
 *   kill switch は発動しない (engine が新規エントリーだけを止める)。
 * - 決済の一部約定は journal.reduce で累計し、残りは追跡を続けて次のティックで決済する
 *   (TradeRecord は全量を決済したときに 1 件だけ作る)。
 * - ブローカー呼び出しには締め切り (brokerTimeoutMs) を設け、venue ごとに並列で処理する。
 */
export class PositionManager {
  private plans: Record<string, ExitPlan>;
  private seq = 0;
  private readonly closing = new Set<string>();
  private readonly lastAudit = new Map<string, number>();
  private lastAuditSweep = 0;
  private readonly log: Logger;
  private readonly plansKey: string;
  readonly policy: OrderPolicy;
  private exitOrderTs: number[] = [];
  /** 決済が約定しなかった銘柄の再試行待ち */
  private readonly exitBackoff = new Map<string, { rejects: number; until: number }>();
  /** ブローカーの建玉が追跡と一致しなかった連続回数 (trade id ごと。照会の一時的な欠落で外さないため) */
  private readonly mismatchObs = new Map<string, number>();
  /** 決済の拒否後の建玉確認 (その場で待たずに次のティックへ回す) */
  private readonly verifyQueue = new Map<string, VerifyItem>();
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

  /** journal・保留中の注文・決済ルールの書き込みをまとめて確定する (途中で停止しても同じ約定を二重に反映しない) */
  private tx<T>(fn: () => T): T {
    const s = this.deps.store;
    return s?.transaction ? s.transaction(fn) : fn();
  }

  /** ブローカー呼び出し (同期の例外も Promise の失敗にし、締め切りを設ける) */
  private call<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return withDeadline((async () => fn())(), this.policy.brokerTimeoutMs, label);
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

  /** 状態不明が続いている (escalated) 保留中の注文 */
  escalatedOrders(): PendingOrder[] {
    return this.pending.escalated();
  }

  /** 次のティックへ回した確認 (決済の拒否後の建玉確認) があるか */
  hasDeferredChecks(): boolean {
    return this.verifyQueue.size > 0;
  }

  planOf(id: string): ExitPlan {
    return { ...(this.plans[id] ?? {}) };
  }

  /** 注文の clientId (再起動後の重複を避けるため短い乱数を付ける) */
  newClientId(kind: "e" | "x", now: number): string {
    const rand = Math.random().toString(36).slice(2, 6);
    return `${this.deps.clientIdPrefix ?? "eng"}-${kind}-${now}-${++this.seq}-${rand}`;
  }

  /** ブローカーのキー (venue ごとの並列処理用)。発注先が無い銘柄は銘柄ごとに分ける */
  brokerKey(symbol: string): unknown {
    try {
      return this.deps.brokerFor(symbol);
    } catch {
      return `no-broker:${symbol}`;
    }
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
   * 未約定・状態不明 (締め切り超過を含む) は保留中として記録し、syncPending で確定させる (その間この銘柄には発注しない)。
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
      res = await this.call(() => broker.placeOrder(req), "placeOrder");
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

  /**
   * ポジションを成行 (reduceOnly) で決済する。保留中の注文がある銘柄には発注しない。
   * 発注が締め切りを過ぎたら状態不明の保留として扱う (保留は発注前に書き込み済み)。
   * 拒否された場合の建玉の確認は、その場で待たずに次のティック (syncPending) へ回す。
   */
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
        res = await this.call(() => broker.placeOrder(req), "placeOrder");
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
          return { status: "closed", trade: a.trade };
        case "reduced":
          return { status: "reduced", position: a.position };
        case "pending":
          return { status: "pending", ...(a.reason ? { reason: a.reason } : {}) };
        case "rejected":
          // 建玉が既に無い (取引所側のストップ・手動決済・保有数量で減らされた決済の残り) かは次のティックで確認する
          if (!this.verifyQueue.has(p.id)) this.verifyQueue.set(p.id, { tradeId: p.id, symbol, at: now });
          return { status: "rejected", reason: `${a.reason} (建玉は次のティックで確認します)` };
        case "none":
          return { status: "none", reason: a.reason };
        default:
          return { status: "none" };
      }
    } finally {
      this.closing.delete(p.id);
    }
  }

  /** 全ポジションを決済 (kill switch 等)。保留中の注文がある銘柄は pending を返す。venue ごとに並列 */
  async closeAll(reason: ExitReason, now: number, quoteOf: (symbol: string) => Quote | undefined): Promise<CloseResult[]> {
    const list = this.list();
    const out = new Map<string, CloseResult>();
    await runGrouped(list, (p) => this.brokerKey(p.symbol), async (p) => {
      const q = quoteOf(p.symbol);
      const intended = q ? (p.direction === "long" ? q.bid : q.ask) : p.lastPrice;
      try {
        out.set(p.id, await this.close(p.symbol, reason, intended, now));
      } catch (e) {
        out.set(p.id, { status: "error", reason: errMsg(e) });
      }
    });
    return list.map((p) => out.get(p.id) ?? { status: "none" });
  }

  // ───────── 保留中の注文 ─────────

  /**
   * 保留中の注文を照会し、確定したものを journal に反映する。venue (ブローカー) ごとに並列、同じ venue の中は順番どおり。
   * - 同じティック (createdAt === now) で作った注文はこのティックでは照会しない。
   * - 照会で状態が分からず、escalated (または不明が maxUnknownMs 以上) の注文は、positionCheckMs ごとに
   *   ブローカーの建玉で判定し、同じ判定が 2 回続いたら確定する。
   * - 決済が拒否された後の建玉の確認 (前のティックで予定したもの) もここで行う。
   */
  async syncPending(now: number): Promise<SyncResult> {
    const out: SyncResult = { opened: [], closed: [], reduced: 0, rejected: 0, pending: 0, resolved: 0, reconciled: 0 };
    const memo = new Map<unknown, Promise<BrokerPosition[] | undefined>>();
    type Item = { order: PendingOrder } | { verify: VerifyItem };
    const items: Item[] = [
      ...this.pending.list().filter((o) => o.createdAt < now).map((order) => ({ order })),
      ...[...this.verifyQueue.values()].filter((v) => v.at < now).map((verify) => ({ verify })),
    ];
    await runGrouped(items, (it) => this.brokerKey("order" in it ? it.order.symbol : it.verify.symbol), async (it) => {
      if ("verify" in it) {
        try {
          if (await this.runVerify(it.verify, now, memo)) out.reconciled++;
        } catch (e) {
          this.log.warn("決済が約定しなかった後の建玉の確認に失敗", { symbol: it.verify.symbol, error: errMsg(e) });
        }
        return;
      }
      const o = it.order;
      let a: Applied;
      try {
        a = await this.syncOne(o, now);
      } catch (e) {
        this.markUnknown(o, now, `照会の処理に失敗: ${errMsg(e)}`);
        a = { kind: "pending", unknown: true };
      }
      if (a.kind === "pending" && a.unknown) {
        const cur = this.pending.get(o.clientId);
        if (cur && this.positionCheckDue(cur, now)) {
          try {
            const r = await this.resolveByPosition(cur, now, memo);
            if (r) {
              a = r;
              out.resolved++;
            }
          } catch (e) {
            this.log.warn("建玉による注文の確定に失敗 (次回に再試行)", { symbol: o.symbol, clientId: o.clientId, error: errMsg(e) });
          }
        }
      }
      if (a.kind === "opened") out.opened.push(a.position);
      else if (a.kind === "closed") out.closed.push(a.trade);
      else if (a.kind === "reduced") out.reduced++;
      else if (a.kind === "rejected") out.rejected++;
      else if (a.kind === "pending") out.pending++;
    });
    return out;
  }

  private positionCheckDue(o: PendingOrder, now: number): boolean {
    const stuck = o.escalated || (o.unknownSince !== undefined && now - o.unknownSince >= this.policy.maxUnknownMs);
    return stuck && (o.positionCheckAt === undefined || now - o.positionCheckAt >= this.policy.positionCheckMs);
  }

  /** ブローカーの建玉 (同じ syncPending の中では 1 回だけ照会する)。失敗したら undefined */
  private positionsOf(broker: Broker, memo: Map<unknown, Promise<BrokerPosition[] | undefined>>): Promise<BrokerPosition[] | undefined> {
    let p = memo.get(broker);
    if (!p) {
      p = this.call(() => broker.getPositions(), "getPositions").catch((e) => {
        this.log.warn("建玉の照会に失敗 (次回に再試行)", { venue: broker.venue, error: errMsg(e) });
        return undefined;
      });
      memo.set(broker, p);
    }
    return p;
  }

  /** 照会の結果: 注文 / 状態不明 (数えた) / 反映待ち (数えない) */
  private async query(broker: Broker, o: PendingOrder, now: number): Promise<OrderResult | "unknown" | "waiting"> {
    let res: OrderResult | undefined;
    try {
      res = await this.call(
        () => broker.getOrder(o.clientId, o.symbol, o.orderId, { createdAt: o.createdAt, side: o.side, qty: o.qty }),
        "getOrder",
      );
    } catch (e) {
      this.markUnknown(o, now, `照会に失敗: ${errMsg(e)}`);
      return "unknown";
    }
    if (!res) {
      // orderId が分かっている注文は、照会の反映遅れの間は「見つからない」を不明として数えない
      if (o.orderId && now - o.createdAt < this.policy.notFoundGraceMs) {
        o.lastCheckedAt = now;
        this.pending.upsert(o);
        return "waiting";
      }
      this.markUnknown(o, now, "注文が見つかりません");
      return "unknown";
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
    if (res === "unknown") return { kind: "pending", unknown: true };
    if (res === "waiting") return { kind: "pending", reason: "注文の反映待ち" };
    let stuckAfterCancel = false;
    // 成行が一定時間を過ぎても確定しない: 取消してから再照会する (取消の間に約定した分も累計の約定で反映される)
    if (!isFinalStatus(res.status) && now - o.createdAt >= this.policy.cancelAfterMs && o.orderId) {
      const first = o.cancelRequestedAt === undefined;
      try {
        const orderId = o.orderId;
        await this.call(() => broker.cancelOrder(orderId, o.symbol), "cancelOrder");
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
      if (again === "unknown") return { kind: "pending", unknown: true };
      if (again === "waiting") return { kind: "pending", reason: "注文の反映待ち" };
      res = again;
      stuckAfterCancel = !first && !isFinalStatus(res.status);
    }
    const a = this.applyResult(o, res, now);
    if (a.kind === "pending" && !a.unknown && stuckAfterCancel) {
      this.markUnknown(o, now, `取消後も確定しません (${res.status})`);
      return { kind: "pending", reason: a.reason, unknown: true };
    }
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
    // journal・保留中の注文の書き込みを 1 つのトランザクションで確定する (途中で停止しても二重に反映しない)。
    // 反映に失敗した場合は保留中に残す (次の照会で再試行し、続けば escalated)
    return this.tx(() => {
      const out = sum.qty.gt(0) ? this.settle(o, sum, now) : this.onNoFill(o, res, now);
      this.pending.remove(o.clientId);
      return out;
    });
  }

  private onNoFill(o: PendingOrder, res: OrderResult, now: number): Applied {
    const reason = res.reason !== undefined ? redactSecrets(res.reason) : res.status;
    if (o.kind === "entry") {
      this.deps.store?.audit({
        ts: now, type: "engine.order_rejected",
        data: { symbol: o.symbol, strategyId: o.entry?.input.strategyId, clientId: o.clientId, status: res.status, reason: res.reason !== undefined ? reason : undefined },
      });
    } else {
      this.auditThrottled(`rej|${o.symbol}`, now, "engine.exit_rejected", {
        symbol: o.symbol, reason: o.exit?.reason, status: res.status, detail: res.reason !== undefined ? reason : undefined,
      });
      this.log.warn("決済注文が約定しませんでした", { symbol: o.symbol, reason: o.exit?.reason, status: res.status, detail: reason });
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
      if (this.has(o.symbol)) return this.entryConflict(o, sum.qty, sum.price, now);
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
    const full = remain.lte(tracked.mul(1e-9)) || dust;
    if (full && sum.qty.minus(tracked).gt(tracked.mul(OVERFILL_TOLERANCE))) {
      const msg = `${o.symbol}: 決済が保有数量を超えて約定しました (${sum.qty.toString()} > ${tracked.toString()})。逆方向の建玉が無いか確認してください`;
      this.log.error(msg);
      this.deps.store?.audit({ ts: now, type: "engine.exit_overfill", data: { symbol: o.symbol, tradeId: p.id, filled: sum.qty.toString(), tracked: tracked.toString() } });
      this.deps.onAnomaly?.(msg, now);
    }
    if (full && dust) this.deps.store?.audit({ ts: now, type: "engine.exit_dust", data: { symbol: o.symbol, tradeId: p.id, remaining: remain.toString(), minQty } });
    return this.recordExit(o, p, {
      qty: sum.qty, price: sum.price, fee: sum.fee, full, now,
      ...(delayed ? { orderedAt: o.createdAt } : {}),
    });
  }

  /**
   * 決済の約定 (または推定) を journal に記録する。全量なら TradeRecord を 1 件作り (推定・manual でなければ学習へ)、
   * 一部ならポジションに累計して残りは次のティックで同じ理由で決済する
   */
  private recordExit(
    o: PendingOrder,
    p: OpenTrade,
    f: { qty: Decimal; price: number; fee?: Decimal; full: boolean; now: number; orderedAt?: number; estimated?: boolean; source?: string },
  ): Applied {
    const x = o.exit!;
    const { now } = f;
    const remain = D(p.qty).minus(f.qty);
    const input = {
      exitPrice: f.price, intendedExitPrice: x.intendedPrice, exitTs: now, exitReason: x.reason, fees: (f.fee ?? D(0)).toNumber(),
      ...(f.estimated ? { estimated: true } : {}),
    };
    let trade: TradeRecord | undefined;
    let rest: OpenTrade | undefined;
    if (f.full) {
      trade = this.deps.journal.close({ id: p.id, ...input });
      delete this.plans[p.id];
      this.mismatchObs.delete(p.id);
      this.verifyQueue.delete(p.id);
    } else {
      const r = this.deps.journal.reduce(p.id, { qty: f.qty.toNumber(), ...input });
      if (r.kind === "closed") {
        trade = r.trade;
        delete this.plans[p.id];
        this.mismatchObs.delete(p.id);
        this.verifyQueue.delete(p.id);
      } else {
        rest = r.position;
        this.plans[p.id] = { ...(this.plans[p.id] ?? {}), retryExit: { reason: x.reason, intendedPrice: x.intendedPrice } };
        this.log.warn("決済が一部約定のみ。残りは次のティックで決済します", { symbol: o.symbol, filled: f.qty.toString(), remaining: remain.toString() });
      }
    }
    this.persist();
    // 推定を含むトレードは学習に渡さない (数量・価格が推定のため)
    if (trade && !trade.estimated) this.deps.onTradeClosed?.(trade);
    const ccy = this.deps.quoteCurrencyOf?.(o.symbol);
    const fxRate = ccy && this.deps.toAccount ? this.deps.toAccount(ccy) : NaN;
    this.deps.store?.audit({
      ts: now,
      type: "engine.exit",
      data: {
        tradeId: p.id,
        symbol: o.symbol,
        strategyId: p.strategyId,
        direction: p.direction,
        reason: x.reason,
        exitPrice: f.price,
        intendedExitPrice: x.intendedPrice,
        qty: f.qty.toString(),
        ...(trade
          ? {
              netPnl: trade.netPnl,
              rMultiple: Number(trade.rMultiple.toFixed(3)),
              ...(trade.qty !== f.qty.toNumber() ? { totalQty: trade.qty, avgExitPrice: trade.exitPrice } : {}),
            }
          : { partial: true, remaining: remain.toString(), realizedGross: rest?.realizedGross }),
        ...(f.orderedAt !== undefined ? { delayed: true, orderedAt: f.orderedAt } : {}),
        ...(f.estimated ? { estimated: true, source: f.source } : {}),
        ...(trade && Number.isFinite(fxRate) && fxRate > 0 ? { fxRate, netPnlAccount: D(trade.netPnl).mul(fxRate).toNumber() } : {}),
      },
    });
    return trade ? { kind: "closed", trade } : { kind: "reduced", position: rest! };
  }

  /** 追跡中のポジションがある銘柄でエントリーが約定した (建玉の不整合 = 異常) */
  private entryConflict(o: PendingOrder, qty: Decimal, price: number, now: number): Applied {
    const msg = `${o.symbol}: 追跡中のポジションがある銘柄でエントリーが約定しました (qty ${qty.toString()})。建玉を確認してください`;
    this.log.error(msg);
    this.deps.store?.audit({ ts: now, type: "engine.entry_conflict", data: { symbol: o.symbol, clientId: o.clientId, qty: qty.toString(), price } });
    this.deps.onAnomaly?.(msg, now);
    return { kind: "none", reason: msg };
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

  /**
   * 状態不明の記録。不明が maxUnknownCount 回、または maxUnknownMs 続いたら escalated にする
   * (kill switch は発動しない。engine は新規エントリーだけを止め、建玉による確定を待つ)
   */
  private markUnknown(o: PendingOrder, now: number, why: string): void {
    const reason = redactSecrets(why);
    o.unknownCount = (o.unknownCount ?? 0) + 1;
    o.unknownSince ??= now;
    o.lastError = reason;
    o.lastCheckedAt = now;
    if (o.status === "submitting") o.status = "unknown";
    this.auditThrottled(`unk|${o.clientId}`, now, "engine.order_unknown", {
      symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, count: o.unknownCount, error: reason,
    });
    const tooLong = now - o.unknownSince >= this.policy.maxUnknownMs;
    if (!o.escalated && (o.unknownCount >= this.policy.maxUnknownCount || tooLong)) {
      o.escalated = true;
      o.escalatedAt = now;
      const msg =
        `注文状態不明: ${o.symbol} ${o.kind === "entry" ? "エントリー" : "決済"} clientId=${o.clientId}` +
        `${o.orderId ? ` orderId=${o.orderId}` : ""} (${reason})。新規エントリーを止め、建玉の照会で確定させます`;
      this.log.error(msg, { unknownCount: o.unknownCount, sinceMs: now - o.unknownSince });
      this.deps.store?.audit({
        ts: now, type: "order.unknown_escalated",
        data: { symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, count: o.unknownCount, sinceMs: now - o.unknownSince, error: reason },
      });
      this.pending.upsert(o);
      this.deps.onEscalated?.({ ...o }, now);
      return;
    }
    this.pending.upsert(o);
  }

  // ───────── 建玉・手動の申告による確定 ─────────

  /**
   * 状態不明の注文を、ブローカーの建玉で判定する。照会に失敗したら何もしない。
   * 同じ判定が POSITION_RESOLVE_CONFIRMATIONS 回続いたら確定する (一覧の反映遅れ対策)。
   * 「約定なし」で確定する前に、orderId が分かっていれば取消を試みる (後から約定するのを防ぐ。失敗してもよい)
   */
  private async resolveByPosition(o: PendingOrder, now: number, memo: Map<unknown, Promise<BrokerPosition[] | undefined>>): Promise<Applied | undefined> {
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(o.symbol);
    } catch {
      return undefined;
    }
    const list = await this.positionsOf(broker, memo);
    if (!list) return undefined;
    const cur = this.pending.get(o.clientId);
    if (!cur) return undefined;
    const r = this.judgeByPosition(cur, list);
    if (!r) return undefined;
    cur.positionCheckAt = now;
    const prev = cur.positionObs;
    const count = prev && prev.verdict === r.verdict ? (prev.count ?? 1) + 1 : 1;
    if (count < POSITION_RESOLVE_CONFIRMATIONS) {
      cur.positionObs = { verdict: r.verdict, qty: r.qty.toString(), at: now, count };
      this.pending.upsert(cur);
      this.log.warn("状態不明の注文を建玉で判定しました (次の確認で確定します)", {
        symbol: cur.symbol, clientId: cur.clientId, kind: cur.kind, verdict: r.verdict, qty: r.qty.toString(), brokerQty: r.brokerQty,
      });
      return undefined;
    }
    if (r.verdict !== "filled" && cur.orderId) await this.tryCancel(broker, cur);
    const latest = this.pending.get(cur.clientId);
    if (!latest) return undefined;
    latest.positionCheckAt = now;
    return this.finalizeResolved(latest, r, now, { source: "position" });
  }

  private async tryCancel(broker: Broker, o: PendingOrder): Promise<void> {
    const orderId = o.orderId;
    if (!orderId) return;
    try {
      await this.call(() => broker.cancelOrder(orderId, o.symbol), "cancelOrder");
    } catch (e) {
      this.log.warn("注文の取消に失敗 (確定は続けます)", { symbol: o.symbol, clientId: o.clientId, orderId, error: errMsg(e) });
    }
  }

  /** 建玉による判定。判定できない (推定価格が無い) なら undefined */
  private judgeByPosition(o: PendingOrder, list: BrokerPosition[]): Resolution | undefined {
    const brokerQty = sumPositions(list).get(o.symbol) ?? D(0);
    const minQty = D(this.deps.instrumentOf?.(o.symbol)?.minQty ?? 0);
    const tolPct = this.policy.positionTolerance;
    if (o.kind === "exit") {
      const p = o.exit ? this.deps.journal.get(o.exit.tradeId) : undefined;
      if (!p) return { verdict: "none", qty: D(0), price: 0, brokerQty: brokerQty.toString() };
      const tracked = D(p.qty);
      const dirQty = p.direction === "long" ? brokerQty : brokerQty.neg();
      const held = Decimal.max(dirQty, 0);
      const tol = Decimal.max(minQty, tracked.mul(tolPct));
      const filled = tracked.minus(held);
      const base = { brokerQty: brokerQty.toString(), trackedQty: tracked.toString() };
      if (filled.lte(tol)) return { verdict: "none", qty: D(0), price: 0, ...base };
      const px = this.deps.priceOf?.(o.symbol);
      const price = px !== undefined && Number.isFinite(px) && px > 0 ? px : p.lastPrice;
      if (held.lte(tol)) return { verdict: "filled", qty: tracked, price, ...base };
      return { verdict: "partial", qty: filled, price, ...base };
    }
    const ordered = D(o.qty);
    const t = this.get(o.symbol);
    const trackedSigned = t ? D(t.qty).mul(t.direction === "long" ? 1 : -1) : D(0);
    const delta = brokerQty.minus(trackedSigned);
    const filled = o.side === "buy" ? delta : delta.neg();
    const tol = Decimal.max(minQty, ordered.mul(tolPct));
    const base = { brokerQty: brokerQty.toString(), trackedQty: trackedSigned.toString() };
    if (filled.lte(tol)) return { verdict: "none", qty: D(0), price: 0, ...base };
    const qty = Decimal.min(filled, ordered);
    const avg = list.find((b) => b.symbol === o.symbol && Number.isFinite(b.avgPrice) && b.avgPrice > 0)?.avgPrice;
    const px = avg ?? this.deps.priceOf?.(o.symbol);
    if (px === undefined || !Number.isFinite(px) || !(px > 0)) return undefined;
    return { verdict: qty.gte(ordered.minus(tol)) ? "filled" : "partial", qty, price: px, ...base };
  }

  /**
   * 建玉・手動の申告による確定を記録する (journal と保留中の注文を 1 つのトランザクションで)。
   * 約定ありは推定扱い (estimated: true) で、学習には渡さない
   */
  private finalizeResolved(
    o: PendingOrder,
    r: Resolution,
    now: number,
    by: { source: "position" } | { source: "manual"; req: ResolveRequest },
  ): Applied {
    return this.tx(() => {
      let a: Applied;
      const estimated = r.verdict !== "none";
      if (r.verdict === "none") {
        a = { kind: "none", reason: "約定なし" };
      } else if (o.kind === "entry") {
        const e = o.entry;
        if (!e) throw new Error(`エントリー情報がありません: ${o.clientId}`);
        if (this.has(o.symbol)) a = this.entryConflict(o, r.qty, r.price, now);
        else {
          const opened = this.open({ ...e.input, qty: r.qty.toNumber(), entryPrice: r.price, entryFees: 0, estimated: true }, e.plan);
          this.deps.store?.audit({
            ts: now,
            type: "engine.entry",
            data: {
              ...e.audit, tradeId: opened.id, symbol: o.symbol, strategyId: e.input.strategyId, qty: r.qty.toString(), requestedQty: o.qty,
              price: r.price, delayed: true, orderedAt: o.createdAt, estimated: true, source: by.source,
            },
          });
          a = { kind: "opened", position: opened };
        }
      } else {
        const p = o.exit ? this.deps.journal.get(o.exit.tradeId) : undefined;
        if (!p) a = { kind: "none", reason: "追跡していないポジション" };
        else {
          const tracked = D(p.qty);
          const tol = Decimal.max(D(this.deps.instrumentOf?.(o.symbol)?.minQty ?? 0), tracked.mul(this.policy.positionTolerance));
          const qty = Decimal.min(r.qty, tracked);
          const full = r.verdict === "filled" || qty.gte(tracked.minus(tol));
          this.exitBackoff.delete(o.symbol);
          a = this.recordExit(o, p, { qty: full ? tracked : qty, price: r.price, full, now, orderedAt: o.createdAt, estimated: true, source: by.source });
        }
      }
      this.pending.remove(o.clientId);
      const data = {
        symbol: o.symbol, clientId: o.clientId, ...(o.orderId ? { orderId: o.orderId } : {}), kind: o.kind, result: r.verdict,
        qty: r.qty.toString(), ...(estimated ? { price: r.price, estimated: true } : {}),
        ...(r.brokerQty !== undefined ? { brokerQty: r.brokerQty } : {}), ...(r.trackedQty !== undefined ? { trackedQty: r.trackedQty } : {}),
        ...(a.kind === "opened" ? { tradeId: a.position.id } : a.kind === "closed" ? { tradeId: a.trade.id } : a.kind === "reduced" ? { tradeId: a.position.id } : {}),
      };
      if (by.source === "position") {
        this.log.warn("状態不明の注文を建玉で確定しました", data);
        this.deps.store?.audit({ ts: now, type: "order.resolved_by_position", data });
      } else {
        this.log.warn("保留中の注文を手動の申告で解消しました", { ...data, by: by.req.by });
        this.deps.store?.audit({ ts: now, type: "order.manual_resolve", data: { ...data, outcome: by.req.outcome, by: by.req.by, requestedAt: by.req.at } });
      }
      return a;
    });
  }

  /**
   * CLI `orders resolve` の要求を適用する。none: 約定なし / filled: 申告の数量・価格で約定 (推定扱い・学習に渡さない)。
   * orderId が分かっていれば先に取消を試みる (失敗してもよい)。適用した (または対象が無い) なら結果を返す
   */
  async applyResolveRequest(req: ResolveRequest, now: number): Promise<{ applied: boolean; message: string }> {
    const o = this.pending.get(req.clientId);
    const reject = (message: string) => {
      this.log.warn(`手動の解消要求を適用できません: ${message}`, { clientId: req.clientId });
      this.deps.store?.audit({
        ts: now, type: "order.manual_resolve",
        data: { clientId: req.clientId, outcome: req.outcome, result: "rejected", reason: message, by: req.by, requestedAt: req.at },
      });
      return { applied: false, message };
    };
    if (!o) return reject("保留中の注文が見つかりません (既に確定した可能性があります)");
    let r: Resolution = { verdict: "none", qty: D(0), price: 0 };
    if (req.outcome === "filled") {
      let qty: Decimal;
      try {
        qty = D(req.qty ?? NaN);
      } catch {
        qty = D(NaN);
      }
      const price = Number(req.price);
      if (!qty.isFinite() || !qty.gt(0)) return reject(`数量が不正です (${String(req.qty)})`);
      if (!Number.isFinite(price) || !(price > 0)) return reject(`価格が不正です (${String(req.price)})`);
      const base = o.kind === "exit" ? D(o.exit ? (this.deps.journal.get(o.exit.tradeId)?.qty ?? o.qty) : o.qty) : D(o.qty);
      const tol = Decimal.max(D(this.deps.instrumentOf?.(o.symbol)?.minQty ?? 0), base.mul(this.policy.positionTolerance));
      const q = Decimal.min(qty, base);
      r = { verdict: q.gte(base.minus(tol)) ? "filled" : "partial", qty: q, price };
    }
    if (o.orderId) {
      try {
        await this.tryCancel(this.deps.brokerFor(o.symbol), o);
      } catch {
        // 発注先が無い: 取消はできないが解消は続ける
      }
    }
    const cur = this.pending.get(req.clientId);
    if (!cur) return reject("取消の間に注文が確定しました");
    const a = this.finalizeResolved(cur, r, now, { source: "manual", req });
    return { applied: true, message: `${cur.symbol} ${cur.kind === "entry" ? "エントリー" : "決済"} を ${r.verdict} として解消しました (${a.kind})` };
  }

  // ───────── 突き合わせ ─────────

  /**
   * 決済が約定せずに終わった後の建玉の確認 (前のティックで予定したもの)。照会に失敗したら次のティックに再試行する。
   * 建玉が無い・少ないことを EXIT_REJECT_CONFIRMATIONS 回確認したら、追跡を manual として整理する。journal を変えたら true
   */
  private async runVerify(v: VerifyItem, now: number, memo: Map<unknown, Promise<BrokerPosition[] | undefined>>): Promise<boolean> {
    const p = this.deps.journal.get(v.tradeId);
    if (!p) {
      this.verifyQueue.delete(v.tradeId);
      return false;
    }
    // 新しい決済が保留中なら、その確定を待つ
    if (this.hasPending(p.symbol)) return false;
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(p.symbol);
    } catch {
      this.verifyQueue.delete(v.tradeId);
      return false;
    }
    const list = await this.positionsOf(broker, memo);
    if (!list) return false;
    const cur = this.deps.journal.get(v.tradeId);
    if (!cur || this.hasPending(cur.symbol)) return false;
    const px = this.deps.priceOf?.(cur.symbol);
    const r = this.reconcileOne(cur, sumPositions(list).get(cur.symbol) ?? D(0), now, {
      price: px !== undefined && Number.isFinite(px) && px > 0 ? px : cur.lastPrice, confirmations: EXIT_REJECT_CONFIRMATIONS, phase: "exit_rejected",
    });
    if (r.kind === "waiting") {
      // 不一致を確認中: 次のティックでもう一度確認する
      this.verifyQueue.set(v.tradeId, { ...v, at: now });
      return false;
    }
    this.verifyQueue.delete(v.tradeId);
    if (r.kind === "orphaned" || r.kind === "reduced") {
      this.exitBackoff.delete(cur.symbol);
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * ブローカーの建玉との整合チェック (起動時・定期)。保留中の注文がある銘柄は対象外。
   * - ブローカーに建玉が無い (または方向が逆の) 追跡中ポジションは、現在値で手仕舞い済み (manual) として journal から外す。
   * - ブローカーの建玉が追跡数量より少なければ、差分を一部決済 (manual) としてポジションに累計する。
   * いずれも学習には渡さない (TradeRecord は全量を決済したときに保存する)。
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
    // journal (追跡中の kv と trades) と決済ルールの書き込みをまとめて確定する
    return this.tx(() => {
      if (missing) {
        const t = this.deps.journal.close({ id: p.id, ...exit });
        delete this.plans[p.id];
        this.persist();
        this.verifyQueue.delete(p.id);
        this.log.warn("ブローカーに建玉が無い追跡ポジションを外しました (外部で決済された可能性)", base);
        this.deps.store?.audit({ ts: now, type: "reconcile.external_close", data: { ...base, price: o.price, netPnl: t.netPnl } });
        return { kind: "orphaned" as const, trade: t };
      }
      const r = this.deps.journal.reduce(p.id, { qty: shortfall.toNumber(), ...exit });
      this.log.warn("ブローカーの建玉が追跡数量より少ないため差分を外しました", { ...base, reducedQty: shortfall.toString() });
      this.deps.store?.audit({ ts: now, type: "reconcile.external_reduce", data: { ...base, reducedQty: shortfall.toString(), price: o.price } });
      if (r.kind === "closed") {
        delete this.plans[p.id];
        this.persist();
        return { kind: "orphaned" as const, trade: r.trade };
      }
      return { kind: "reduced" as const };
    });
  }

  private auditThrottled(key: string, now: number, type: string, data: Record<string, unknown>) {
    const last = this.lastAudit.get(key);
    if (last !== undefined && now - last < AUDIT_THROTTLE_MS) return;
    this.lastAudit.set(key, now);
    if (this.lastAudit.size > 200 || now - this.lastAuditSweep > 60_000) {
      this.lastAuditSweep = now;
      sweepOld(this.lastAudit, now, 10 * 60_000);
    }
    this.deps.store?.audit({ ts: now, type, data });
  }
}
