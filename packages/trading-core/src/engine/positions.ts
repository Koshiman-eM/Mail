import { costFeeRate } from "../core/fees";
import { D, Decimal } from "../core/decimal";
import { redactedErrMsg, redactSecrets } from "../core/http";
import { sweepOld } from "../core/sweep";
import { createLogger, type Logger } from "../core/logger";
import type {
  Broker, BrokerPosition, ExitReason, Fill, Instrument, OrderRequest, OrderResult, PositionView, Quote, Store, TradeRecord,
} from "../core/types";
import type { FeesByLiquidity, OpenTrade, OpenTradeInput, TradeJournal, TradeThesisFields } from "../learning/journal";
import { runGrouped, withDeadline } from "./deadline";
import { normalizeCurrency } from "./fx";
import {
  activeThesisMs, advancePeak, decideThesis, initialRiskPerUnit, THESIS_DISABLED, thesisGrossR, thesisNetR, thesisOutcomeOf, thesisTrailStop,
  tighterStop, type ThesisExitReason, type ThesisPricing, type ThesisSettings,
} from "./thesis";
import {
  bumpLimitStats, isFinalStatus, PendingOrders, RestingTakeProfits, type LimitCancelReason, type PendingEntry, type PendingOrder, type PositionVerdict,
  type ResolveRequest, type RestingTakeProfit,
} from "./orders";
import { quoteMid } from "../core/util";

/** エントリー時に決まる決済ルール (TradeJournal に無い分) */
export interface ExitPlan {
  /** トレーリング幅 (0.01 = 1%) */
  trailingStopPct?: number;
  /** 最大保有時間 (0 / 未設定なら時間切れなし) */
  maxHoldMs?: number;
  /** 読みの期限 (シグナルの expectedMs。無ければ maxHoldMs を読みの期限にする。src/engine/thesis.ts) */
  expectedMs?: number;
  /**
   * 読みの管理の状態 (再起動しても続ける)。extendedAt: 期限で読み当たりとして延長した時刻 /
   * netRAtDeadline: 期限の時点の純 R の見積り (延長・期限で読み外れの判定に使った値) /
   * peak: 延長後の有利な極値 (決済できる価格: 買いは bid の高値、売りは ask の安値。延長した時点の気配から始める) /
   * stop: 延長後の保護ストップ (きつくなる方へだけ更新。設定・手数料が変わっても緩めない。THESIS_EXIT=false で再起動しても保護に使う) /
   * exit: 決めた読みの決済 (読み外れ・延長の上限)。約定するまで同じ理由で再試行し、その間は延長しない
   */
  thesis?: {
    extendedAt?: number; netRAtDeadline?: number; peak?: number; stop?: number;
    exit?: { reason: ThesisExitReason; netR?: number; at: number };
  };
  /** 一部約定で残った分は、決済判定に該当しなくても次のティックで同じ理由で決済する (thesisStop: 延長後の保護ストップでの決済) */
  retryExit?: { reason: ExitReason; intendedPrice: number; thesisStop?: boolean };
  /** 利確の指値を (もう) 板に置かない (決済のために取り消した・置けなかった) */
  noRestingTp?: boolean;
  /** 利確の指値を置こうとした回数 (取引所に拒否・取消されても無限に置き直さない) */
  tpAttempts?: number;
}

/** 利確の指値を置き直す上限 (建玉ごと) */
const MAX_TP_ATTEMPTS = 3;
/** 利確の指値の取消を再送するまでの間隔 (取消が照会に反映されないとき) */
const TP_RECANCEL_MS = 10_000;
/** 利確の指値が「見つからない」と何回続けて答えられたら、約定なしで消えたとみなすか */
const TP_NOT_FOUND_CONFIRMATIONS = 2;

export interface ExitDecision {
  reason: ExitReason;
  /** 意図した決済価格 (ストップ価格・利確価格・判定時点の価格) */
  intendedPrice: number;
  /** 読みの管理の決済のときの純 R の見積り */
  netR?: number;
  /** 延長後の保護ストップ (建値・トレーリング) での決済 (reason は trailing) */
  thesisStop?: boolean;
  /** 延長していない建玉が延長の上限に届いた (期限で読み当たり → 同時に上限)。決済の前に延長を記録する */
  thesisExtend?: { netR: number };
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
  /** 約定せずに終わった指値のエントリー (cause: 取消の理由。rejected は取引所の拒否) */
  limitUnfilled: { order: PendingOrder; cause: LimitCancelReason | "rejected" }[];
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
  /** 決済注文の状態不明がこの回数続いたら escalated (損切りを長く止めないため、エントリーより短い) */
  exitMaxUnknownCount: number;
  /** 決済注文の状態不明がこの時間続いたら escalated */
  exitMaxUnknownMs: number;
  /** escalated の決済注文を建玉で確定させるための getPositions の間隔 */
  exitPositionCheckMs: number;
  /** 板に置いた利確の指値の照会の間隔 (銘柄ごと。気配が利確価格に触れたときは間隔によらず即時) */
  tpPollMs: number;
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
  exitMaxUnknownCount: 2,
  exitMaxUnknownMs: 20_000,
  exitPositionCheckMs: 10_000,
  tpPollMs: 3_000,
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
  /**
   * 新しいポジションを登録した (成行の約定・指値の約定 (一部約定を含む)・照会や手動の申告による確定)。
   * open() の中で 1 ポジションにつき 1 回だけ呼ぶ (engine はテンポのエントリーの記録に使う)。例外は握りつぶす
   */
  onOpened?: (p: OpenTrade, now: number) => void;
  store?: Store;
  logger?: Logger;
  /** 注文 clientId の接頭辞 */
  clientIdPrefix?: string;
  /** 決済時点の口座通貨換算 (監査ログに残し、レポートで使う) */
  toAccount?: (ccy: string) => number;
  quoteCurrencyOf?: (symbol: string) => string | undefined;
  /** 銘柄情報 (手数料の通貨換算・端数の判定。takerFeeRate は読みの管理の純 R の見積り) */
  instrumentOf?: (symbol: string) => (Pick<Instrument, "baseCurrency" | "quoteCurrency" | "minQty"> & Partial<Pick<Instrument, "takerFeeRate" | "fixedFeePerOrder" | "costModel" | "venue">>) | undefined;
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
  /**
   * エントリーの約定後、利確価格に reduceOnly の指値を板に置く (LIMIT_TAKE_PROFIT。paper 専用)。
   * 発注先が capabilities.restingTakeProfit に対応しているときだけ (無ければ従来どおりエンジン側の成行で利確)。
   * journal の mode が live なら true でも置かない
   */
  limitTakeProfit?: boolean;
  /**
   * 読みの管理 (THESIS_EXIT。src/engine/thesis.ts)。省略・無効なら従来どおり maxHoldMs で時間切れ (time)。
   * 有効なら、決済計画に maxHoldMs (または expectedMs) がある建玉は、期限で答え合わせをして決済・延長する
   */
  thesis?: ThesisSettings;
}

/** 旧キー (mode なし)。paper 用として扱う */
const LEGACY_PLANS_KEY = "positions:exitPlans";
const plansKey = (mode: string) => `${LEGACY_PLANS_KEY}:${mode}`;

/** 保存済みの決済計画 (status の表示用。読み取りだけ) */
export function readExitPlans(store: Pick<Store, "kvGet">, mode: string): Record<string, ExitPlan> {
  const saved = store.kvGet<Record<string, ExitPlan>>(plansKey(mode));
  return saved && typeof saved === "object" ? saved : {};
}

/** 建玉の読みの状態 (ダッシュボード・status の表示用) */
export interface ThesisView {
  /** 読みの期限 (エントリー時刻 + 期限までの時間) */
  deadlineTs: number;
  /** 延長の上限の時刻 (期限 × THESIS_EXTEND_MULT) */
  capTs: number;
  /** 期限 (延長中は上限) までの残り (分。過ぎていれば 0) */
  remainingMin: number;
  /** watching: 期限まで監視中 / extended: 期限で読み当たり → 延長中 */
  state: "watching" | "extended";
  /** 現在の純 R の見積り (気配が無ければ省略) */
  netR?: number;
}
const AUDIT_THROTTLE_MS = 60_000;

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
  /** Σ 数量 × 価格 */
  notional: Decimal;
  /** クオート通貨建ての手数料 */
  fee: Decimal;
  /** 手数料の liquidity 別の内訳 (クオート通貨建て) */
  maker: Decimal;
  taker: Decimal;
  invalid?: string;
}

const byLiquidity = (maker: Decimal, taker: Decimal): FeesByLiquidity => ({ maker: maker.toNumber(), taker: taker.toNumber() });

type Applied =
  | { kind: "pending"; reason?: string; unknown?: boolean }
  | { kind: "rejected"; reason: string; limitUnfilled?: { order: PendingOrder; cause: LimitCancelReason | "rejected" } }
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
 *   読みの管理 (deps.thesis) が有効なら、時間切れの代わりに読みの期限で答え合わせをする (途中・期限で読み外れ / 延長 / 延長の上限。src/engine/thesis.ts)。
 * - 戦略の flat シグナル・転換で決済 (engine が確定足ごとに判定して close を呼ぶ。exitInProgress のときは重ねない)・kill switch でも決済する。
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
  /** 指値のエントリーを待っている銘柄で、取引所の建玉が説明できる範囲を超えた連続回数 (銘柄ごと) */
  private readonly excessObs = new Map<string, number>();
  /** 決済の拒否後の建玉確認 (その場で待たずに次のティックへ回す) */
  private readonly verifyQueue = new Map<string, VerifyItem>();
  readonly pending: PendingOrders;
  /** 板に置いた利確の指値 (建玉ごと) */
  readonly tps: RestingTakeProfits;

  constructor(private readonly deps: PositionManagerDeps) {
    this.log = deps.logger ?? createLogger("positions");
    const mode = deps.journal.mode;
    this.plansKey = plansKey(mode);
    let saved = deps.store?.kvGet<Record<string, ExitPlan>>(this.plansKey);
    if (saved === undefined && mode === "paper") saved = deps.store?.kvGet<Record<string, ExitPlan>>(LEGACY_PLANS_KEY);
    const open = new Set(deps.journal.list().map((p) => p.id));
    this.plans = Object.fromEntries(Object.entries(saved ?? {}).filter(([id]) => open.has(id)));
    this.pending = new PendingOrders({ ...(deps.store ? { store: deps.store } : {}), mode });
    this.tps = new RestingTakeProfits({ ...(deps.store ? { store: deps.store } : {}), mode });
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

  /**
   * 状態不明が続いている (escalated) 保留中の注文。
   * 決済のための取消を確かめられない利確の指値も含める (新規エントリーを止める。kind は exit)
   */
  escalatedOrders(): PendingOrder[] {
    const tps = this.tps
      .list()
      .filter((t) => t.escalated)
      .map(
        (t): PendingOrder => ({
          clientId: t.clientId, ...(t.orderId ? { orderId: t.orderId } : {}), symbol: t.symbol, side: t.side, qty: t.qty, kind: "exit", createdAt: t.createdAt,
          status: "unknown", unknownCount: t.unknownCount, ...(t.lastError ? { lastError: t.lastError } : {}), escalated: true,
        }),
      );
    return [...this.pending.escalated(), ...tps];
  }

  /** 板に置いた利確の指値の一覧 */
  restingTakeProfits(): RestingTakeProfit[] {
    return this.tps.list();
  }

  /**
   * 追跡していない建玉の利確の指値 (孤児。取消を確かめる前) が銘柄に残っているか。
   * 残っている間は新規エントリーしない (reduceOnly の指値が新しい建玉に当たって決済してしまうため)
   */
  hasOrphanTakeProfit(symbol: string): boolean {
    return this.tps.list().some((t) => t.symbol === symbol && !this.deps.journal.get(t.tradeId));
  }

  /** 銘柄の保留中の指値のエントリー */
  pendingLimitEntry(symbol: string): PendingOrder | undefined {
    return this.pending.list().find((o) => o.symbol === symbol && o.kind === "entry" && o.limit !== undefined);
  }

  /** 次のティックへ回した確認 (決済の拒否後の建玉確認) があるか */
  hasDeferredChecks(): boolean {
    return this.verifyQueue.size > 0;
  }

  planOf(id: string): ExitPlan {
    return { ...(this.plans[id] ?? {}) };
  }

  /** 注文の clientId (再起動後の重複を避けるため短い乱数を付ける) */
  newClientId(kind: "e" | "x" | "t", now: number): string {
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

  /**
   * トレーリングストップ価格 (当初ストップより有利な場合のみ)。
   * 読みの管理で延長した建玉は、建値 (往復手数料込み) と 極値 − THESIS_TRAIL_R × 当初のリスク の有利な方とも比べ、きつい方を使う
   */
  trailingStop(p: OpenTrade): number | undefined {
    const pct = this.plans[p.id]?.trailingStopPct;
    const long = p.direction === "long";
    let out: number | undefined;
    if (pct !== undefined && pct > 0) {
      const s = long ? p.highWater * (1 - pct) : p.lowWater * (1 + pct);
      if (long ? s > p.initialStop : s < p.initialStop) out = s;
    }
    const t = this.thesisStop(p);
    if (t !== undefined && (long ? t > p.initialStop : t < p.initialStop) && (out === undefined || (long ? t > out : t < out))) out = t;
    return out;
  }

  // ───────── 読みの管理 ─────────

  /** 読みの管理を使う建玉なら期限 (ms) と当初のリスク (無効・期限なし・リスク 0 以下なら undefined = 従来の時間切れ) */
  private thesisOf(p: OpenTrade): { ms: number; risk: number; plan: ExitPlan } | undefined {
    const plan = this.plans[p.id];
    if (!plan) return undefined;
    const risk = initialRiskPerUnit(p.entryPrice, p.initialStop);
    const ms = activeThesisMs(this.deps.thesis, plan.expectedMs, plan.maxHoldMs, risk);
    return ms === undefined ? undefined : { ms, risk, plan };
  }

  /** 純 R・建値の計算に使う値 (エントリー手数料は実際に払った額を 1 単位あたりにする。一部決済後も元の数量で割る) */
  private thesisPricing(p: OpenTrade, risk: number): ThesisPricing {
    const units = D(p.qty).plus(p.exitedQty ?? 0).mul(p.contractSize).toNumber();
    // 決済の手数料の見積り: taker 率 + 約定ごとの固定手数料の率換算 (Jupiter のネットワーク手数料。src/core/fees.ts)
    const inst = this.deps.instrumentOf?.(p.symbol);
    const rate = inst?.takerFeeRate !== undefined ? costFeeRate({ ...inst, takerFeeRate: inst.takerFeeRate }) : undefined;
    return {
      direction: p.direction,
      entryPrice: p.entryPrice,
      risk,
      entryFeePerUnit: units > 0 && Number.isFinite(p.entryFees) ? p.entryFees / units : 0,
      ...(rate !== undefined && Number.isFinite(rate) ? { takerFeeRate: rate } : {}),
    };
  }

  /** 今決済したときの純 R の見積り (決済できる価格: 買いは bid、売りは ask) */
  private thesisNetRAt(p: OpenTrade, quote: Pick<Quote, "bid" | "ask">, risk: number): number {
    return thesisNetR(this.thesisPricing(p, risk), p.direction === "long" ? quote.bid : quote.ask);
  }

  /**
   * 延長後の保護ストップ (延長していない建玉は undefined)。
   * 極値は延長した時点から測る (plan.thesis.peak。延長より前の高値・安値は使わない)。保存済みのストップ (plan.thesis.stop) と
   * 今の計算のきつい方を使い、設定・手数料が変わっても緩めない。読みの管理を使わなくなった建玉 (THESIS_EXIT=false で再起動など) も
   * 保存済みのストップで守り続ける
   */
  private thesisStop(p: OpenTrade): number | undefined {
    const t = this.plans[p.id]?.thesis;
    if (!t || t.extendedAt === undefined) return undefined;
    const th = this.thesisOf(p);
    const cur = th ? thesisTrailStop(this.thesisPricing(p, th.risk), t.peak ?? Number.NaN, this.deps.thesis!.trailR) : undefined;
    return tighterStop(p.direction, t.stop, cur);
  }

  /** 延長後の有利な極値を気配で進め、保護ストップを保存する (変わったら決済計画に保存する) */
  private advanceThesisPeak(p: OpenTrade, quote: Quote): void {
    const plan = this.plans[p.id];
    const t = plan?.thesis;
    if (!t || t.extendedAt === undefined) return;
    let peak = t.peak;
    if (this.thesisOf(p) && quote.bid > 0 && quote.ask > 0) peak = advancePeak(p.direction, t.peak, p.direction === "long" ? quote.bid : quote.ask);
    this.plans[p.id] = { ...plan, thesis: { ...t, ...(peak !== undefined ? { peak } : {}) } };
    const stop = this.thesisStop(p);
    if (stop !== undefined) this.plans[p.id] = { ...this.plans[p.id], thesis: { ...this.plans[p.id].thesis, stop } };
    if (peak !== t.peak || stop !== t.stop) this.persist();
  }

  /** 延長を記録する (決済計画に保存して再起動後も続ける。監査ログ thesis.extended) */
  private recordExtension(p: OpenTrade, ms: number, quote: Pick<Quote, "bid" | "ask">, netR: number, now: number, capped: boolean): void {
    const plan = this.plans[p.id] ?? {};
    const peak = p.direction === "long" ? quote.bid : quote.ask;
    this.plans[p.id] = { ...plan, thesis: { ...(plan.thesis ?? {}), extendedAt: now, netRAtDeadline: netR, peak } };
    const stop = this.thesisStop(p);
    if (stop !== undefined) this.plans[p.id] = { ...this.plans[p.id], thesis: { ...this.plans[p.id].thesis, stop } };
    this.persist();
    const data = {
      tradeId: p.id, symbol: p.symbol, strategyId: p.strategyId, direction: p.direction, netR: Number(netR.toFixed(4)),
      deadlineTs: p.entryTs + ms, capTs: p.entryTs + ms * Math.max(1, this.deps.thesis!.extendMult), ...(stop !== undefined ? { stop } : {}),
      ...(capped ? { capped: true } : {}),
    };
    this.deps.store?.audit({ ts: now, type: "thesis.extended", data });
    this.log.info(capped ? "読みの期限で利益が出ていますが延長の上限に達しているため決済します" : "読みの期限で利益が出ているため延長します (建値・トレーリングで保護)", data);
  }

  /**
   * 期限で読み当たりなら延長を記録する。延長後の極値は今の決済できる価格から始める
   * (保護ストップは max(建値, 価格 − THESIS_TRAIL_R × R) より厳しくならない。この気配では判定し直さない)。
   * onQuote が、checkExit で決済に該当しなかったときに呼ぶ。決済の再試行中 (retryExit・読みの決済) は延長しない。延長したら true
   */
  private markThesisExtension(p: OpenTrade, quote: Quote, now: number): boolean {
    const th = this.thesisOf(p);
    if (!th || th.plan.thesis?.extendedAt !== undefined || th.plan.thesis?.exit || th.plan.retryExit) return false;
    if (!(quote.bid > 0) || !(quote.ask > 0)) return false;
    const pricing = this.thesisPricing(p, th.risk);
    const d = decideThesis(
      {
        elapsedMs: now - p.entryTs, expectedMs: th.plan.expectedMs, maxHoldMs: th.plan.maxHoldMs, extended: false,
        netR: thesisNetR(pricing, p.direction === "long" ? quote.bid : quote.ask), grossR: thesisGrossR(pricing, quoteMid(quote)),
      },
      this.deps.thesis!,
    );
    if (!d.extend || d.exit) return false;
    this.recordExtension(p, th.ms, quote, d.extend.netR, now, false);
    return true;
  }

  /**
   * 読みの決済 (読み外れ・延長の上限) を決めたら決済計画に保存する (約定するまで同じ理由で再試行し、その間は延長しない)。
   * 延長していない建玉が上限に届いた (THESIS_EXTEND_MULT = 1・停止中に上限を過ぎた) ときは、先に延長を記録する (答え合わせは延長)
   */
  private noteThesisExit(p: OpenTrade, d: ExitDecision, quote: Pick<Quote, "bid" | "ask">, now: number): void {
    const plan = this.plans[p.id];
    if (!plan || plan.thesis?.exit) return;
    if (d.reason !== "thesis_failed" && d.reason !== "thesis_timeout" && d.reason !== "thesis_cap") return;
    if (d.thesisExtend && plan.thesis?.extendedAt === undefined) {
      const th = this.thesisOf(p);
      if (th) this.recordExtension(p, th.ms, quote, d.thesisExtend.netR, now, true);
    }
    const cur = this.plans[p.id];
    const t = { ...(cur.thesis ?? {}) };
    t.exit = { reason: d.reason, ...(d.netR !== undefined && Number.isFinite(d.netR) ? { netR: d.netR } : {}), at: now };
    if (d.reason === "thesis_timeout" && d.netR !== undefined && Number.isFinite(d.netR) && t.netRAtDeadline === undefined) t.netRAtDeadline = d.netR;
    this.plans[p.id] = { ...cur, thesis: t };
    this.persist();
  }

  /**
   * 決済時の読みの管理の記録 (TradeRecord に付ける。読みの管理を使わない建玉は undefined)。
   * 読み外れ (途中・期限) の決済には延長の記録を付けない。thesisStop は約定した決済の注文が延長後の保護ストップによるものか
   */
  private thesisRecord(p: OpenTrade, reason: ExitReason, thesisStop: boolean): TradeThesisFields | undefined {
    const th = this.thesisOf(p);
    if (!th) return undefined;
    const t = th.plan.thesis;
    const failed = reason === "thesis_failed" || reason === "thesis_timeout";
    const extended = !failed && t?.extendedAt !== undefined;
    return {
      thesisExpectedMs: th.ms,
      thesisDeadlineTs: p.entryTs + th.ms,
      ...(extended ? { thesisExtendedAt: t!.extendedAt } : {}),
      thesisOutcome: thesisOutcomeOf(reason, extended),
      ...(t?.netRAtDeadline !== undefined && Number.isFinite(t.netRAtDeadline) ? { thesisNetRAtDeadline: t.netRAtDeadline } : {}),
      ...(thesisStop && reason === "trailing" ? { thesisStopExit: true } : {}),
    };
  }

  /** 建玉の読みの状態 (表示用。読みの管理を使わない建玉は undefined) */
  thesisView(p: OpenTrade, quote: Pick<Quote, "bid" | "ask"> | undefined, now: number): ThesisView | undefined {
    const th = this.thesisOf(p);
    if (!th) return undefined;
    const extended = th.plan.thesis?.extendedAt !== undefined;
    const deadlineTs = p.entryTs + th.ms;
    const capTs = p.entryTs + th.ms * Math.max(1, this.deps.thesis!.extendMult);
    const netR = quote && quote.bid > 0 && quote.ask > 0 ? this.thesisNetRAt(p, quote, th.risk) : NaN;
    return {
      deadlineTs,
      capTs,
      remainingMin: Math.max(0, ((extended ? capTs : deadlineTs) - now) / 60_000),
      state: extended ? "extended" : "watching",
      ...(Number.isFinite(netR) ? { netR } : {}),
    };
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

  /**
   * エントリーの約定後に登録する。新しいポジションの作成はすべてここを通る (deps.onOpened を 1 回だけ呼ぶ)。
   * now は約定を反映した時刻 (省略時はエントリーの時刻)
   */
  open(input: OpenTradeInput, plan: ExitPlan, now?: number): OpenTrade {
    if (this.has(input.symbol)) throw new Error(`${input.symbol} は既にポジションがあります (1 銘柄 1 ポジション)`);
    const p = this.deps.journal.open(input);
    this.plans[p.id] = {
      ...(plan.trailingStopPct !== undefined && plan.trailingStopPct > 0 ? { trailingStopPct: plan.trailingStopPct } : {}),
      ...(plan.maxHoldMs !== undefined && plan.maxHoldMs > 0 ? { maxHoldMs: plan.maxHoldMs } : {}),
      ...(plan.expectedMs !== undefined && plan.expectedMs > 0 ? { expectedMs: plan.expectedMs } : {}),
      ...(plan.retryExit ? { retryExit: plan.retryExit } : {}),
    };
    this.persist();
    if (this.deps.onOpened) {
      try {
        this.deps.onOpened({ ...p }, now ?? p.entryTs);
      } catch (e) {
        this.log.warn("ポジション登録の通知に失敗 (取引は継続)", { symbol: p.symbol, error: redactedErrMsg(e) });
      }
    }
    return p;
  }

  // ───────── エントリー ─────────

  /**
   * エントリーの成行を発注する。約定すれば約定数量・平均価格で journal に登録する。
   * 未約定・状態不明 (締め切り超過を含む) は保留中として記録し、syncPending で確定させる (その間この銘柄には発注しない)。
   */
  async enter(req: OrderRequest, entry: PendingEntry, now: number, limit?: PendingOrder["limit"]): Promise<EntryResult> {
    const symbol = req.symbol;
    if (this.has(symbol)) return { status: "rejected", reason: "既にポジションがあります" };
    if (this.hasPending(symbol)) return { status: "rejected", reason: "保留中の注文があります" };
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(symbol);
    } catch (e) {
      return { status: "rejected", reason: redactedErrMsg(e) };
    }
    const o: PendingOrder = {
      clientId: req.clientId, symbol, side: req.side, qty: req.qty, kind: "entry", createdAt: now, status: "submitting", unknownCount: 0, entry,
      ...(limit ? { limit } : {}),
    };
    // 発注前に書き込む (発注中に停止しても再起動後に clientId で照会できる)
    this.pending.upsert(o);
    let res: OrderResult;
    try {
      res = await this.call(() => broker.placeOrder(req), "placeOrder");
    } catch (e) {
      this.deps.onOrder?.(now);
      const msg = redactedErrMsg(e);
      this.log.error("発注の結果が不明です (保留中として照会を続けます)", { symbol, clientId: req.clientId, error: msg });
      this.deps.store?.audit({ ts: now, type: "engine.order_error", data: { symbol, strategyId: req.strategyId, clientId: req.clientId, error: msg, pending: true } });
      this.markUnknown(o, now, `発注で例外: ${msg}`);
      if (limit) this.bumpStats(now, (s) => s.entryPlaced++);
      return { status: "pending", reason: msg };
    }
    this.deps.onOrder?.(now);
    if (limit && res.status !== "rejected") this.bumpStats(now, (s) => s.entryPlaced++);
    const a = this.applyResult(o, res, now);
    if (a.kind === "opened") return { status: "opened", position: a.position };
    if (a.kind === "pending") return { status: "pending", ...(a.reason ? { reason: a.reason } : {}) };
    return { status: "rejected", reason: "reason" in a ? a.reason : a.kind };
  }

  // ───────── 決済 ─────────

  /**
   * 決済判定 (副作用なし)。損切り → 利確 → トレーリング → 時間切れ (読みの管理) の順。
   * 読みの管理を使う建玉は、時間切れの代わりに 途中で読み外れ / 期限で読み外れ / 延長の上限 で決済する
   * (期限で読み当たりのときは何も返さず、延長の記録は onQuote が行う。延長後の建値・トレーリングはトレーリングとして判定する)。
   * skipTakeProfit: 利確の指値を板に置いている (利確は指値の約定で記録するので、成行の利確をしない)
   */
  checkExit(p: OpenTrade, quote: Quote, now: number, opts: { skipTakeProfit?: boolean } = {}): ExitDecision | undefined {
    const long = p.direction === "long";
    const { bid, ask } = quote;
    if (!(bid > 0) || !(ask > 0)) return undefined;
    const trail = this.trailingStop(p);
    // 実効のトレーリングが読みの管理の保護ストップ (延長後の建値・トレーリング) か
    const ts = trail !== undefined ? this.thesisStop(p) : undefined;
    const byThesis = ts !== undefined && trail === ts ? { thesisStop: true } : {};
    const hit = (stop: number) => (long ? bid <= stop : ask >= stop);
    if (hit(p.initialStop)) {
      // 引き上げ済みのトレーリングストップを飛び越えて当初ストップまで動いた場合は、先に触れたトレーリング側で記録する
      return trail !== undefined ? { reason: "trailing", intendedPrice: trail, ...byThesis } : { reason: "stop", intendedPrice: p.initialStop };
    }
    if (!opts.skipTakeProfit && p.takeProfit !== undefined && (long ? bid >= p.takeProfit : ask <= p.takeProfit)) {
      return { reason: "take_profit", intendedPrice: p.takeProfit };
    }
    if (trail !== undefined && hit(trail)) return { reason: "trailing", intendedPrice: trail, ...byThesis };
    const plan = this.plans[p.id];
    // 決めた読みの決済 (読み外れ・延長の上限) は、約定するまで同じ理由で再試行する (従来の時間切れと同じ。損切り・利確・トレーリングが先)
    const pendingExit = plan?.thesis?.exit;
    if (pendingExit) return { reason: pendingExit.reason, intendedPrice: long ? bid : ask, ...(pendingExit.netR !== undefined ? { netR: pendingExit.netR } : {}) };
    const th = this.thesisOf(p);
    const pricing = th ? this.thesisPricing(p, th.risk) : undefined;
    const d = decideThesis(
      {
        elapsedMs: now - p.entryTs,
        ...(plan?.expectedMs !== undefined ? { expectedMs: plan.expectedMs } : {}),
        ...(plan?.maxHoldMs !== undefined ? { maxHoldMs: plan.maxHoldMs } : {}),
        extended: plan?.thesis?.extendedAt !== undefined,
        netR: pricing ? thesisNetR(pricing, long ? bid : ask) : NaN,
        // 途中で読み外れは値動きだけ (仲値) で判定する (コストだけでは切らない)
        grossR: pricing ? thesisGrossR(pricing, (bid + ask) / 2) : NaN,
      },
      // 読みの管理を使わない建玉は従来の時間切れ
      th ? this.deps.thesis! : THESIS_DISABLED,
    );
    if (d.exit) {
      return {
        reason: d.exit.reason, intendedPrice: long ? bid : ask, ...(d.exit.netR !== undefined ? { netR: d.exit.netR } : {}),
        ...(d.extend && d.exit.reason === "thesis_cap" ? { thesisExtend: d.extend } : {}),
      };
    }
    return undefined;
  }

  /**
   * 毎ティックの処理: 価格反映 → 利確の指値の照会 → 決済判定 → 必要なら決済 → 利確の指値を置く
   * (保留中の注文がある銘柄は照会の結果を待つ)。
   * 利確の指値は銘柄ごとに tpPollMs に 1 回照会する (気配が利確価格に触れたら即時)。
   * 決済のために取消中の利確の指値があれば、取消の確認を続ける (確定するまで成行は送らない)
   */
  async onQuote(symbol: string, quote: Quote, now: number): Promise<CloseResult> {
    const p0 = this.get(symbol);
    if (!p0) return { status: "none" };
    if (quote.bid > 0 && quote.ask > 0) {
      this.deps.journal.mark(symbol, quoteMid(quote), now);
      // 延長後の極値も気配で進める (journal の高値・安値と同じく、保留中の注文があっても記録する)
      this.advanceThesisPeak(p0, quote);
    }
    if (this.hasPending(symbol)) return { status: "pending", reason: "保留中の注文があります" };
    let reduced: OpenTrade | undefined;
    const rtp = this.tps.get(p0.id);
    if (rtp) {
      if (rtp.exit) return this.close(symbol, rtp.exit.reason, rtp.exit.intendedPrice, now, rtp.exit.thesisStop ? { thesisStop: true } : {});
      const long = p0.direction === "long";
      const touched = quote.bid > 0 && quote.ask > 0 && (long ? quote.bid >= rtp.price : quote.ask <= rtp.price);
      const due = rtp.lastCheckedAt === undefined || now - rtp.lastCheckedAt >= this.policy.tpPollMs || rtp.status === "submitting" || rtp.status === "unknown";
      if (touched || due) {
        const r = await this.pollTakeProfit(rtp, now);
        if (r.applied?.kind === "closed") return { status: "closed", trade: r.applied.trade };
        if (r.applied?.kind === "reduced") reduced = r.applied.position;
      }
    }
    const p = this.get(symbol);
    if (!p) return { status: "none" };
    const skipTakeProfit = this.tps.get(p.id) !== undefined;
    const d = this.checkExit(p, quote, now, { skipTakeProfit });
    if (d) {
      // 読みの決済は決済計画に保存して、約定するまで同じ理由で再試行する (延長の上限に先に届いた建玉は延長を記録してから)
      this.noteThesisExit(p, d, quote, now);
      return this.close(symbol, d.reason, d.intendedPrice, now, d.thesisStop ? { thesisStop: true } : {});
    }
    // 決済に該当しないときだけ、読みの期限で利益が出ていれば延長を記録する (延長した気配では保護ストップを判定しない =
    // 延長そのもので決済しない。決済の再試行中は延長しない)
    this.markThesisExtension(p, quote, now);
    // 一部約定で残った分
    const retry = this.plans[p.id]?.retryExit;
    if (retry) return this.close(symbol, retry.reason, retry.intendedPrice, now, retry.thesisStop ? { thesisStop: true } : {});
    await this.placeTakeProfit(p, quote, now);
    return reduced ? { status: "reduced", position: reduced } : { status: "none" };
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
  async close(symbol: string, reason: ExitReason, intendedPrice: number, now: number, opts: { maxQty?: Decimal; thesisStop?: boolean } = {}): Promise<CloseResult> {
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
        const msg = redactedErrMsg(e);
        this.auditThrottled(`err|${symbol}`, now, "engine.exit_error", { symbol, reason, error: msg });
        this.log.error("決済の発注先が見つかりません", { symbol, reason, error: msg });
        return { status: "error", reason: msg };
      }
      // 板に置いた利確の指値があれば、先に取り消して結果 (または約定) を照会で確かめる。
      // 確定するまで成行は送らない (取消に失敗・状態不明のまま成行を送ると、利確の約定と重なって過剰決済・ドテンになりうる)
      if (this.tps.get(p.id)) {
        const c = await this.clearTakeProfit(p, reason, intendedPrice, now, opts.thesisStop === true);
        if (c !== "cleared") return c;
      }
      const cur = this.get(symbol);
      if (!cur || cur.id !== p.id) return { status: "none", reason: "ポジションがありません" };
      const long = cur.direction === "long";
      // 数量は追跡数量 (と、指定があれば取引所の保有数量) を上限にする (reduceOnly と合わせて過剰決済しない)。
      // 利確の指値が一部約定していれば、その分を減らした残りの数量
      let qty = D(cur.qty);
      if (opts.maxQty !== undefined) {
        if (!opts.maxQty.isFinite() || !opts.maxQty.gt(0)) return { status: "none", reason: "決済する数量がありません" };
        if (opts.maxQty.lt(qty)) qty = opts.maxQty;
      }
      const req: OrderRequest = {
        clientId: this.newClientId("x", now),
        symbol,
        side: long ? "sell" : "buy",
        type: "market",
        qty: qty.toString(),
        reduceOnly: true,
        strategyId: p.strategyId,
      };
      const o: PendingOrder = {
        clientId: req.clientId, symbol, side: req.side, qty: req.qty, kind: "exit", createdAt: now, status: "submitting", unknownCount: 0,
        exit: { tradeId: p.id, reason, intendedPrice, ...(opts.thesisStop ? { thesisStop: true } : {}) },
      };
      this.pending.upsert(o);
      this.exitOrderTs.push(now);
      let res: OrderResult;
      try {
        res = await this.call(() => broker.placeOrder(req), "placeOrder");
      } catch (e) {
        this.deps.onOrder?.(now);
        const msg = redactedErrMsg(e);
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

  /**
   * 決済の手続きが進んでいる建玉か。進んでいれば理由を返す (無ければ undefined)。
   * 確定足で判断する追加の決済 (転換で決済) を重ねないためのガード。どれも close() の前に確かめる:
   * - 保留中・状態不明の注文がある (決済の約定待ち・照会中)
   * - 決済中 (close の途中)
   * - 決済が拒否された後の建玉の確認待ち (建玉が残っているか分からない)
   * - 決めた読みの決済 (読み外れ・延長の上限) を約定するまで再試行中 (読みの決済を上書きしない)
   * - 一部約定の残り (retryExit) を同じ理由で決済中
   * - 決済のために板の利確の指値を取消中
   */
  exitInProgress(symbol: string): string | undefined {
    const p = this.get(symbol);
    if (!p) return "ポジションがありません";
    if (this.hasPending(symbol)) return "保留中の注文があります";
    if (this.closing.has(p.id)) return "決済中";
    if (this.verifyQueue.has(p.id)) return "決済の拒否後の建玉の確認待ち";
    const plan = this.plans[p.id];
    if (plan?.thesis?.exit) return `読みの決済 (${plan.thesis.exit.reason}) を再試行中`;
    if (plan?.retryExit) return `一部約定の残りを決済中 (${plan.retryExit.reason})`;
    if (this.tps.get(p.id)?.exit) return "決済のため利確の指値を取消中";
    return undefined;
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
        out.set(p.id, { status: "error", reason: redactedErrMsg(e) });
      }
    });
    return list.map((p) => out.get(p.id) ?? { status: "none" });
  }

  // ───────── 利確の指値 (板に置く) ─────────

  /**
   * 発注先が利確の指値の板置きに対応していて、設定で有効か。
   * live では設定によらず置かない (paper 専用。engine も live では limitTakeProfit を渡さないが、ここでも止める)。
   * 既に板にある利確の指値 (以前の起動で置いたもの) の照会・取消は続ける
   */
  private tpBroker(symbol: string): Broker | undefined {
    if (this.deps.limitTakeProfit !== true || this.deps.journal.mode === "live") return undefined;
    try {
      const b = this.deps.brokerFor(symbol);
      // 成行 (スワップ) だけの取引先 (Jupiter) には指値を置けない
      const venue = this.deps.instrumentOf?.(symbol)?.venue;
      if (venue !== undefined && b.capabilities?.marketOnlyVenues?.includes(venue)) return undefined;
      return b.capabilities?.restingTakeProfit === true ? b : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 利確価格に reduceOnly の指値を置く (LIMIT_TAKE_PROFIT で、発注先が対応しているときだけ)。
   * 置かない条件: 利確価格が無い・既に置いている・決済の途中 (retryExit・取消済み)・保留中の注文がある・
   * 気配が既に利確価格に届いている (置いた瞬間に約定する = maker にならない。従来どおり成行の利確に任せる)・数量が最小未満。
   * 発注前に kv へ書き込む (発注中に停止しても再起動後に clientId で照会・取消できる)。置いたら true
   */
  async placeTakeProfit(p: OpenTrade, quote: Quote | undefined, now: number): Promise<boolean> {
    const tp = p.takeProfit;
    if (tp === undefined || !Number.isFinite(tp) || !(tp > 0)) return false;
    if (this.tps.get(p.id) || this.hasPending(p.symbol) || this.closing.has(p.id)) return false;
    const plan = this.plans[p.id] ?? {};
    if (plan.retryExit || plan.noRestingTp || (plan.tpAttempts ?? 0) >= MAX_TP_ATTEMPTS) return false;
    const broker = this.tpBroker(p.symbol);
    if (!broker) return false;
    const long = p.direction === "long";
    if (!quote || !(quote.bid > 0) || !(quote.ask > 0)) return false;
    if (long ? !(tp > quote.ask) : !(tp < quote.bid)) return false;
    const minQty = this.deps.instrumentOf?.(p.symbol)?.minQty ?? 0;
    const qty = D(p.qty);
    if (!qty.gt(0) || (minQty > 0 && qty.lt(minQty))) return false;
    const req: OrderRequest = {
      clientId: this.newClientId("t", now),
      symbol: p.symbol,
      side: long ? "sell" : "buy",
      type: "limit",
      qty: qty.toString(),
      limitPrice: tp,
      tif: "GTC",
      reduceOnly: true,
      ...(broker.capabilities?.postOnly ? { postOnly: true } : {}),
      strategyId: p.strategyId,
    };
    const rtp: RestingTakeProfit = {
      tradeId: p.id, symbol: p.symbol, clientId: req.clientId, side: req.side, qty: req.qty, price: tp, createdAt: now, status: "submitting",
      appliedQty: "0", appliedFee: "0", unknownCount: 0,
    };
    this.plans[p.id] = { ...plan, tpAttempts: (plan.tpAttempts ?? 0) + 1 };
    this.persist();
    this.tps.upsert(rtp);
    let res: OrderResult;
    try {
      res = await this.call(() => broker.placeOrder(req), "placeOrder");
    } catch (e) {
      this.deps.onOrder?.(now);
      this.markTpUnknown(rtp, now, `利確の指値の発注で例外: ${redactedErrMsg(e)}`);
      this.bumpStats(now, (s) => s.tpPlaced++);
      return true;
    }
    this.deps.onOrder?.(now);
    if (res.status === "rejected") {
      this.tps.remove(p.id);
      const reason = res.reason !== undefined ? redactSecrets(res.reason) : "rejected";
      this.bumpStats(now, (s) => s.tpRejected++);
      this.auditThrottled(`tprej|${p.symbol}`, now, "engine.tp_rejected", { symbol: p.symbol, tradeId: p.id, price: tp, reason });
      this.log.warn("利確の指値が拒否されました (成行の利確に任せます)", { symbol: p.symbol, price: tp, reason });
      return false;
    }
    this.bumpStats(now, (s) => s.tpPlaced++);
    this.deps.store?.audit({
      ts: now, type: "engine.tp_placed",
      data: { symbol: p.symbol, tradeId: p.id, clientId: req.clientId, orderId: res.orderId, price: tp, qty: req.qty, postOnly: req.postOnly === true },
    });
    this.applyTpResult(rtp, res, now);
    return true;
  }

  /** 利確の指値の状態不明を記録する (決済の取消中に続いたら escalated = 新規エントリーを止める) */
  private markTpUnknown(rtp: RestingTakeProfit, now: number, why: string): void {
    const cur = this.tps.get(rtp.tradeId);
    if (!cur) return;
    const reason = redactSecrets(why);
    cur.unknownCount = (cur.unknownCount ?? 0) + 1;
    cur.unknownSince ??= now;
    cur.lastError = reason;
    cur.lastCheckedAt = now;
    if (cur.status === "submitting") cur.status = "unknown";
    this.auditThrottled(`tpunk|${cur.clientId}`, now, "engine.tp_unknown", {
      symbol: cur.symbol, tradeId: cur.tradeId, clientId: cur.clientId, orderId: cur.orderId, count: cur.unknownCount, error: reason, exiting: cur.exit !== undefined,
    });
    const lim = this.unknownLimits({ kind: "exit" });
    if (cur.exit && !cur.escalated && (cur.unknownCount >= lim.count || now - cur.unknownSince >= lim.ms)) {
      cur.escalated = true;
      const msg =
        `利確の指値の状態を確認できないため、${cur.symbol} の決済 (${cur.exit.reason}) の成行を送れません (過剰決済の防止)。` +
        `取引所で注文 ${cur.orderId ?? cur.clientId} と建玉を確認してください`;
      this.log.error(msg, { error: reason });
      this.deps.store?.audit({ ts: now, type: "order.tp_unknown_escalated", data: { symbol: cur.symbol, tradeId: cur.tradeId, clientId: cur.clientId, orderId: cur.orderId, error: reason } });
      this.tps.upsert(cur);
      this.deps.onEscalated?.(
        { clientId: cur.clientId, ...(cur.orderId ? { orderId: cur.orderId } : {}), symbol: cur.symbol, side: cur.side, qty: cur.qty, kind: "exit", createdAt: cur.createdAt, status: "unknown", unknownCount: cur.unknownCount, lastError: reason, escalated: true },
        now,
      );
      return;
    }
    this.tps.upsert(cur);
  }

  /**
   * 利確の指値を照会し、新しい約定を take_profit (maker) として journal に反映する。
   * final: 注文が終わった (約定・取消・見つからない) ので記録を消した
   */
  private async pollTakeProfit(rtp: RestingTakeProfit, now: number): Promise<{ final: boolean; applied?: Applied }> {
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(rtp.symbol);
    } catch (e) {
      this.markTpUnknown(rtp, now, `発注先が見つかりません: ${redactedErrMsg(e)}`);
      return { final: false };
    }
    let res: OrderResult | undefined;
    try {
      res = await this.call(() => broker.getOrder(rtp.clientId, rtp.symbol, rtp.orderId, { createdAt: rtp.createdAt, side: rtp.side, qty: rtp.qty }), "getOrder");
    } catch (e) {
      this.markTpUnknown(rtp, now, `利確の指値の照会に失敗: ${redactedErrMsg(e)}`);
      return { final: false };
    }
    const cur = this.tps.get(rtp.tradeId);
    if (!cur) return { final: true };
    if (!res) {
      // 取引所が「無い」と答えた。反映遅れの間 (作成から notFoundGraceMs。orderId が無い = 発注の結果が不明な記録も同じ) は待ち、
      // 別のティックで続けて答えたら約定なしで消えたとみなす (同じティックの 2 回の照会 = 定期の照会と取消の確認、では確定しない)
      if (now - cur.createdAt < this.policy.notFoundGraceMs || (cur.notFoundAt !== undefined && now <= cur.notFoundAt)) {
        cur.lastCheckedAt = now;
        this.tps.upsert(cur);
        return { final: false };
      }
      const n = (cur.notFound ?? 0) + 1;
      if (n < TP_NOT_FOUND_CONFIRMATIONS) {
        cur.notFound = n;
        cur.notFoundAt = now;
        cur.lastCheckedAt = now;
        this.tps.upsert(cur);
        return { final: false };
      }
      this.tps.remove(cur.tradeId);
      this.deps.store?.audit({ ts: now, type: "engine.tp_missing", data: { symbol: cur.symbol, tradeId: cur.tradeId, clientId: cur.clientId, orderId: cur.orderId } });
      this.log.warn("利確の指値が取引所に見つかりません (約定なしで消えたとみなします)", { symbol: cur.symbol, clientId: cur.clientId });
      return { final: true };
    }
    return this.applyTpResult(cur, res, now);
  }

  /** 照会 (または発注) の結果を反映する。journal と記録の書き込みは 1 つのトランザクションで */
  private applyTpResult(rtp: RestingTakeProfit, res: OrderResult, now: number): { final: boolean; applied?: Applied } {
    const cur = this.tps.get(rtp.tradeId) ?? rtp;
    if (res.orderId) cur.orderId = String(res.orderId);
    cur.lastCheckedAt = now;
    delete cur.notFound;
    delete cur.notFoundAt;
    const sum = this.summarize(cur.symbol, Array.isArray(res.fills) ? res.fills : [], now);
    if (sum.invalid) {
      this.markTpUnknown(cur, now, sum.invalid);
      return { final: false };
    }
    const final = isFinalStatus(res.status);
    if (res.status === "filled" && sum.qty.lte(0)) {
      this.markTpUnknown(cur, now, "約定済みだが約定明細がありません");
      return { final: false };
    }
    if (!final && cur.status !== "canceling") cur.status = res.status;
    cur.unknownCount = 0;
    delete cur.unknownSince;
    delete cur.lastError;
    if (cur.escalated) {
      delete cur.escalated;
      this.deps.store?.audit({ ts: now, type: "order.tp_unknown_resolved", data: { symbol: cur.symbol, tradeId: cur.tradeId, clientId: cur.clientId, status: res.status } });
    }
    return this.tx(() => {
      let applied: Applied | undefined;
      const delta = sum.qty.minus(cur.appliedQty);
      const p = this.deps.journal.get(cur.tradeId);
      if (delta.gt(0) && p) {
        const feeDelta = sum.fee.minus(cur.appliedFee);
        const notionalDelta = sum.notional.minus(cur.appliedNotional ?? 0);
        const price = notionalDelta.gt(0) ? notionalDelta.div(delta).toNumber() : cur.price;
        const tracked = D(p.qty);
        const minQty = this.deps.instrumentOf?.(cur.symbol)?.minQty ?? 0;
        const qty = Decimal.min(delta, tracked);
        const remain = tracked.minus(qty);
        const full = remain.lte(tracked.mul(1e-9)) || (remain.gt(0) && minQty > 0 && remain.lt(minQty));
        // maker / taker の内訳は累計の比率で按分する (照会の結果は累計)
        const share = (x: Decimal, prev: string | undefined) => x.minus(prev ?? 0);
        const pseudo: PendingOrder = {
          clientId: cur.clientId, ...(cur.orderId ? { orderId: cur.orderId } : {}), symbol: cur.symbol, side: cur.side, qty: cur.qty, kind: "exit",
          createdAt: cur.createdAt, status: res.status, unknownCount: 0, exit: { tradeId: p.id, reason: "take_profit", intendedPrice: cur.price },
        };
        applied = this.recordExit(pseudo, p, {
          qty: full ? tracked : qty, price, fee: feeDelta, full, now, exitOrderType: "limit", noRetry: true,
          feesByLiquidity: byLiquidity(share(sum.maker, cur.appliedMaker), share(sum.taker, cur.appliedTaker)),
          ...(cur.createdAt !== now ? { orderedAt: cur.createdAt } : {}),
        });
        cur.appliedQty = sum.qty.toString();
        cur.appliedFee = sum.fee.toString();
        cur.appliedNotional = sum.notional.toString();
        cur.appliedMaker = sum.maker.toString();
        cur.appliedTaker = sum.taker.toString();
        const done = applied.kind === "closed";
        this.bumpStats(now, (s) => (done && res.status === "filled" ? s.tpFilled++ : s.tpPartial++));
      } else if (delta.gt(0) && !p) {
        this.log.warn("追跡していない建玉の利確の指値が約定しました", { symbol: cur.symbol, tradeId: cur.tradeId, qty: delta.toString() });
        this.deps.store?.audit({ ts: now, type: "engine.exit_untracked", data: { symbol: cur.symbol, tradeId: cur.tradeId, clientId: cur.clientId, qty: delta.toString(), price: cur.price } });
      }
      // 記録を消すのは注文が終わった (約定・取消・拒否) ときだけ。建玉の追跡が終わっていても (全量の利確・外部の決済)、
      // 注文が板に残っている間は記録を残し、孤児の整理 (sweepTakeProfits) で取消 → 照会して確かめる
      const closed = !this.deps.journal.get(cur.tradeId);
      if (final) {
        this.tps.remove(cur.tradeId);
        if (res.status !== "filled" && cur.exit) this.bumpStats(now, (s) => s.tpCanceled++);
        if (!closed && !cur.exit && res.status !== "filled") {
          this.auditThrottled(`tpgone|${cur.symbol}`, now, "engine.tp_closed_by_venue", { symbol: cur.symbol, tradeId: cur.tradeId, status: res.status, reason: res.reason });
        }
      } else this.tps.upsert(cur);
      return { final, ...(applied ? { applied } : {}) };
    });
  }

  /**
   * 決済 (成行) の前に利確の指値を取り消す: 取消を送り、すぐに照会して確定させる。
   * - 照会で注文が終わった (取消・約定) と確かめられたら "cleared" (約定分は take_profit として反映済み。残りだけを成行で送る)
   * - 全量が利確で約定していたら closed
   * - 取消に失敗した・状態不明・取消が照会に反映されていない間は pending (成行を送らない。次のティックで照会を続ける)
   */
  private async clearTakeProfit(p: OpenTrade, reason: ExitReason, intendedPrice: number, now: number, thesisStop = false): Promise<"cleared" | CloseResult> {
    const rtp = this.tps.get(p.id);
    if (!rtp) return "cleared";
    if (!rtp.exit) {
      rtp.exit = { reason, intendedPrice, requestedAt: now, ...(thesisStop ? { thesisStop: true } : {}) };
      this.plans[p.id] = { ...(this.plans[p.id] ?? {}), noRestingTp: true };
      this.persist();
      this.deps.store?.audit({ ts: now, type: "engine.tp_cancel", data: { symbol: p.symbol, tradeId: p.id, clientId: rtp.clientId, orderId: rtp.orderId, exitReason: reason } });
    }
    rtp.status = "canceling";
    this.tps.upsert(rtp);
    let broker: Broker;
    try {
      broker = this.deps.brokerFor(p.symbol);
    } catch (e) {
      return { status: "error", reason: redactedErrMsg(e) };
    }
    if (rtp.orderId && (rtp.canceledAt === undefined || now - rtp.canceledAt >= TP_RECANCEL_MS)) {
      const orderId = rtp.orderId;
      try {
        await this.call(() => broker.cancelOrder(orderId, p.symbol), "cancelOrder");
        const cur = this.tps.get(p.id);
        if (cur) {
          cur.canceledAt = now;
          this.tps.upsert(cur);
        }
      } catch (e) {
        const msg = redactedErrMsg(e);
        this.auditThrottled(`tpcxl|${p.symbol}`, now, "engine.tp_cancel_failed", { symbol: p.symbol, tradeId: p.id, orderId, error: msg });
        this.log.warn("利確の指値の取消に失敗 (照会で確かめるまで成行の決済は送りません)", { symbol: p.symbol, orderId, error: msg });
      }
    }
    // 取消の結果 (または約定) をすぐに照会で確かめる (損切りを遅らせないため、間隔を空けない)
    const cur = this.tps.get(p.id);
    const r = cur ? await this.pollTakeProfit(cur, now) : { final: true };
    if (r.applied?.kind === "closed") return { status: "closed", trade: r.applied.trade };
    if (r.final) {
      this.deps.store?.audit({ ts: now, type: "engine.tp_cleared", data: { symbol: p.symbol, tradeId: p.id, exitReason: reason, remaining: this.get(p.symbol)?.qty } });
      return "cleared";
    }
    return { status: "pending", reason: "利確の指値の取消を確認中 (確定するまで成行の決済は送りません)" };
  }

  /**
   * 追跡していない建玉 (決済済み・外部で決済) の利確の指値を取り消す (孤児の整理。起動時と毎ティック)。
   * 記録を消すのは、照会で注文が終わった (取消・約定) と確かめたときだけ (取消に失敗しても板に残っている間は消さない)。
   * 取消・照会に失敗したら次回に再試行する。消した件数を返す
   */
  async sweepTakeProfits(now: number): Promise<number> {
    let n = 0;
    for (const rtp of this.tps.list()) {
      if (this.deps.journal.get(rtp.tradeId)) continue;
      let broker: Broker;
      try {
        broker = this.deps.brokerFor(rtp.symbol);
      } catch (e) {
        // 発注先が無いと取消・照会で確かめられない: 記録は残す (板に残っているかもしれない注文を忘れない)
        this.auditThrottled(`tporph|${rtp.symbol}`, now, "engine.tp_orphan_unverified", { symbol: rtp.symbol, tradeId: rtp.tradeId, clientId: rtp.clientId, error: redactedErrMsg(e) });
        continue;
      }
      if (rtp.orderId && (rtp.canceledAt === undefined || now - rtp.canceledAt >= TP_RECANCEL_MS)) {
        const orderId = rtp.orderId;
        try {
          await this.call(() => broker.cancelOrder(orderId, rtp.symbol), "cancelOrder");
          rtp.canceledAt = now;
          this.tps.upsert(rtp);
        } catch (e) {
          this.log.warn("孤児になった利確の指値の取消に失敗 (次回に再試行)", { symbol: rtp.symbol, orderId, error: redactedErrMsg(e) });
        }
      }
      const cur = this.tps.get(rtp.tradeId);
      if (!cur) continue;
      const r = await this.pollTakeProfit(cur, now);
      if (r.final) {
        n++;
        this.deps.store?.audit({ ts: now, type: "engine.tp_orphan", data: { symbol: rtp.symbol, tradeId: rtp.tradeId, clientId: rtp.clientId, orderId: rtp.orderId } });
      }
    }
    return n;
  }

  /** 追跡中の建玉の利確の指値をすべて照会する (起動時・建玉の突き合わせの前。約定を先に反映して外部の決済と誤認しない) */
  async pollAllTakeProfits(now: number): Promise<number> {
    let n = 0;
    for (const rtp of this.tps.list()) {
      if (!this.deps.journal.get(rtp.tradeId)) continue;
      try {
        const r = await this.pollTakeProfit(rtp, now);
        if (r.applied && (r.applied.kind === "closed" || r.applied.kind === "reduced")) n++;
      } catch (e) {
        this.log.warn("利確の指値の照会に失敗 (次回に再試行)", { symbol: rtp.symbol, error: redactedErrMsg(e) });
      }
    }
    return n;
  }

  // ───────── 保留中の注文 ─────────

  /**
   * 保留中の注文を照会し、確定したものを journal に反映する。venue (ブローカー) ごとに並列、同じ venue の中は順番どおり。
   * - 同じティック (createdAt === now) で作った注文はこのティックでは照会しない。
   * - 照会で状態が分からず、escalated (または不明が maxUnknownMs 以上) の注文は、positionCheckMs ごとに
   *   ブローカーの建玉で判定し、同じ判定が 2 回続いたら確定する。
   * - 決済が拒否された後の建玉の確認 (前のティックで予定したもの) もここで行う。
   */
  async syncPending(now: number, opts: { only?: ReadonlySet<string> } = {}): Promise<SyncResult> {
    const out: SyncResult = { opened: [], closed: [], reduced: 0, rejected: 0, pending: 0, resolved: 0, reconciled: 0, limitUnfilled: [] };
    const memo = new Map<unknown, Promise<BrokerPosition[] | undefined>>();
    type Item = { order: PendingOrder } | { verify: VerifyItem };
    // only: 指定した注文だけを (作成したティックでも) 照会する (指値のエントリーの即時の取消用)
    const only = opts.only;
    const items: Item[] = only
      ? this.pending.list().filter((o) => only.has(o.clientId)).map((order) => ({ order }))
      : [
          ...this.pending.list().filter((o) => o.createdAt < now).map((order) => ({ order })),
          ...[...this.verifyQueue.values()].filter((v) => v.at < now).map((verify) => ({ verify })),
        ];
    await runGrouped(items, (it) => this.brokerKey("order" in it ? it.order.symbol : it.verify.symbol), async (it) => {
      if ("verify" in it) {
        try {
          if (await this.runVerify(it.verify, now, memo)) out.reconciled++;
        } catch (e) {
          this.log.warn("決済が約定しなかった後の建玉の確認に失敗", { symbol: it.verify.symbol, error: redactedErrMsg(e) });
        }
        return;
      }
      const o = it.order;
      let a: Applied;
      try {
        a = await this.syncOne(o, now);
      } catch (e) {
        this.markUnknown(o, now, `照会の処理に失敗: ${redactedErrMsg(e)}`);
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
            this.log.warn("建玉による注文の確定に失敗 (次回に再試行)", { symbol: o.symbol, clientId: o.clientId, error: redactedErrMsg(e) });
          }
        }
      }
      if (a.kind === "opened") out.opened.push(a.position);
      else if (a.kind === "closed") out.closed.push(a.trade);
      else if (a.kind === "reduced") out.reduced++;
      else if (a.kind === "rejected") {
        out.rejected++;
        if (a.limitUnfilled) out.limitUnfilled.push(a.limitUnfilled);
      } else if (a.kind === "pending") out.pending++;
    });
    return out;
  }

  // ───────── 指値のエントリーの取消 ─────────

  /**
   * 指値のエントリーの取消を依頼する (取消・照会は syncPending で行う)。既に依頼済みなら理由を変えない。
   * 依頼したら true
   */
  requestLimitCancel(clientId: string, reason: LimitCancelReason, now: number): boolean {
    const o = this.pending.get(clientId);
    if (!o || !o.limit || o.limit.cancelReason !== undefined) return false;
    o.limit = { ...o.limit, cancelReason: reason };
    this.pending.upsert(o);
    this.deps.store?.audit({
      ts: now, type: "engine.limit_cancel_request",
      data: { symbol: o.symbol, clientId: o.clientId, ...(o.orderId ? { orderId: o.orderId } : {}), reason, ageMs: now - o.createdAt },
    });
    return true;
  }

  /**
   * 条件に合う指値のエントリーの取消を依頼し、その場で取消 → 照会して確定させる (停止・逆方向のシグナル・損切りの越え)。
   * 取消と約定が競合した場合は照会の累計の約定で反映する (一部約定ならその数量で建玉になる)
   */
  async cancelLimitEntries(match: (o: PendingOrder) => boolean, reason: LimitCancelReason, now: number): Promise<SyncResult> {
    return this.cancelLimitEntriesBy((o) => (match(o) ? reason : undefined), now);
  }

  /**
   * 指値のエントリーごとに取消の理由を決めて取消を依頼し、その場で取消 → 照会して確定させる (理由が undefined のものは対象外)。
   * 既に取消を依頼済みの注文も照会の対象にする (理由は変えない)
   */
  async cancelLimitEntriesBy(reasonOf: (o: PendingOrder) => LimitCancelReason | undefined, now: number): Promise<SyncResult> {
    const ids = new Set<string>();
    for (const o of this.pending.list()) {
      if (o.kind !== "entry" || !o.limit) continue;
      const reason = reasonOf(o);
      if (reason === undefined) continue;
      this.requestLimitCancel(o.clientId, reason, now);
      ids.add(o.clientId);
    }
    if (ids.size === 0) return { opened: [], closed: [], reduced: 0, rejected: 0, pending: 0, resolved: 0, reconciled: 0, limitUnfilled: [] };
    return this.syncPending(now, { only: ids });
  }

  /**
   * 待っている指値のエントリーで、気配がシグナルの損切り価格を越えたものの取消を依頼する (syncPending で確定)。
   * 気配が maxQuoteAgeMs より古ければ判定しない (古い気配で越えた・越えていないを決めない。
   * 気配が古いことによる取消は engine が新規を止める理由として別に行う)。依頼した clientId を返す
   */
  checkLimitEntries(quoteOf: (symbol: string) => Quote | undefined, now: number, opts: { maxQuoteAgeMs?: number } = {}): string[] {
    const out: string[] = [];
    for (const o of this.pending.list()) {
      const lim = o.limit;
      if (o.kind !== "entry" || !lim || lim.cancelReason !== undefined) continue;
      const q = quoteOf(o.symbol);
      if (!q || !(q.bid > 0) || !(q.ask > 0)) continue;
      if (opts.maxQuoteAgeMs !== undefined && !(now - q.ts <= opts.maxQuoteAgeMs)) continue;
      const crossed = lim.direction === "long" ? q.bid <= lim.stopLoss : q.ask >= lim.stopLoss;
      if (crossed && this.requestLimitCancel(o.clientId, "stop_crossed", now)) out.push(o.clientId);
    }
    return out;
  }

  private bumpStats(now: number, fn: Parameters<typeof bumpLimitStats>[3]): void {
    try {
      bumpLimitStats(this.deps.store, this.deps.journal.mode, now, fn);
    } catch (e) {
      this.log.warn("指値の集計の保存に失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  /** 状態不明 → escalated の上限・建玉照会の間隔 (決済注文は損切りを長く止めないため短い) */
  private unknownLimits(o: Pick<PendingOrder, "kind">): { count: number; ms: number; checkMs: number } {
    const P = this.policy;
    return o.kind === "exit"
      ? { count: P.exitMaxUnknownCount, ms: P.exitMaxUnknownMs, checkMs: P.exitPositionCheckMs }
      : { count: P.maxUnknownCount, ms: P.maxUnknownMs, checkMs: P.positionCheckMs };
  }

  private positionCheckDue(o: PendingOrder, now: number): boolean {
    const lim = this.unknownLimits(o);
    const stuck = o.escalated || (o.unknownSince !== undefined && now - o.unknownSince >= lim.ms);
    return stuck && (o.positionCheckAt === undefined || now - o.positionCheckAt >= lim.checkMs);
  }

  /** ブローカーの建玉 (同じ syncPending の中では 1 回だけ照会する)。失敗したら undefined */
  private positionsOf(broker: Broker, memo: Map<unknown, Promise<BrokerPosition[] | undefined>>): Promise<BrokerPosition[] | undefined> {
    let p = memo.get(broker);
    if (!p) {
      p = this.call(() => broker.getPositions(), "getPositions").catch((e) => {
        this.log.warn("建玉の照会に失敗 (次回に再試行)", { venue: broker.venue, error: redactedErrMsg(e) });
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
      this.markUnknown(o, now, `照会に失敗: ${redactedErrMsg(e)}`);
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
      this.markUnknown(o, now, `発注先が見つかりません: ${redactedErrMsg(e)}`);
      return { kind: "pending", unknown: true };
    }
    let res = await this.query(broker, o, now);
    if (res === "unknown") return { kind: "pending", unknown: true };
    if (res === "waiting") return { kind: "pending", reason: "注文の反映待ち" };
    let stuckAfterCancel = false;
    // 成行が一定時間を過ぎても確定しない: 取消してから再照会する (取消の間に約定した分も累計の約定で反映される)。
    // 指値のエントリーは期限 (expiresAt) を過ぎたとき・取消を依頼されたとき (逆方向のシグナル・損切りの越え・停止)
    const lim = o.limit;
    const cancelDue = lim ? lim.cancelReason !== undefined || now >= lim.expiresAt : now - o.createdAt >= this.policy.cancelAfterMs;
    if (!isFinalStatus(res.status) && cancelDue && o.orderId) {
      if (lim && lim.cancelReason === undefined) o.limit = { ...lim, cancelReason: "expired" };
      const first = o.cancelRequestedAt === undefined;
      try {
        const orderId = o.orderId;
        await this.call(() => broker.cancelOrder(orderId, o.symbol), "cancelOrder");
      } catch (e) {
        this.log.warn("注文の取消に失敗 (約定済みの可能性があるため再照会します)", { symbol: o.symbol, clientId: o.clientId, error: redactedErrMsg(e) });
      }
      if (first) {
        o.cancelRequestedAt = now;
        this.deps.store?.audit({
          ts: now, type: "engine.order_cancel",
          data: {
            symbol: o.symbol, clientId: o.clientId, orderId: o.orderId, kind: o.kind, ageMs: now - o.createdAt, status: res.status,
            ...(o.limit ? { limit: true, reason: o.limit.cancelReason } : {}),
          },
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
    if (o.kind === "entry" && o.limit) {
      // 指値のエントリーが約定せずに終わった (期限切れ・取消・拒否)
      const cause: LimitCancelReason | "rejected" = res.status === "rejected" ? "rejected" : (o.limit.cancelReason ?? "expired");
      this.deps.store?.audit({
        ts: now, type: "engine.limit_unfilled",
        data: {
          symbol: o.symbol, strategyId: o.entry?.input.strategyId, clientId: o.clientId, ...(o.orderId ? { orderId: o.orderId } : {}), cause,
          price: o.limit.price, ageMs: now - o.createdAt, status: res.status, ...(res.reason !== undefined ? { reason } : {}),
        },
      });
      this.bumpStats(now, (s) => {
        if (cause === "rejected") s.entryRejected++;
        else if (cause === "expired") s.entryExpired++;
        else s.entryCanceled[cause] = (s.entryCanceled[cause] ?? 0) + 1;
      });
      return { kind: "rejected", reason, limitUnfilled: { order: { ...o }, cause } };
    }
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

  /**
   * 約定を反映する時点の仲値 (TradeRecord.entryMid。仲値基準の MFE/MAE の起点)。
   * 現在値 (priceOf = 最新の気配の仲値) があればそれ、無ければシグナル時点の仲値 (指値で後から約定した場合のずれを避けるため現在値を優先)
   */
  private entryMidAt(symbol: string, signalMid: number | undefined): { entryMid?: number } {
    const now = this.deps.priceOf?.(symbol);
    if (now !== undefined && Number.isFinite(now) && now > 0) return { entryMid: now };
    return signalMid !== undefined && Number.isFinite(signalMid) && signalMid > 0 ? { entryMid: signalMid } : {};
  }

  /** 約定を journal に反映する */
  private settle(o: PendingOrder, sum: FillSummary, now: number): Applied {
    const delayed = o.createdAt !== now;
    if (o.kind === "entry") {
      const e = o.entry;
      if (!e) throw new Error(`エントリー情報がありません: ${o.clientId}`);
      if (this.has(o.symbol)) return this.entryConflict(o, sum.qty, sum.price, now);
      const minQty = this.deps.instrumentOf?.(o.symbol)?.minQty ?? 0;
      if (o.limit !== undefined && minQty > 0 && sum.qty.lt(minQty)) return this.dustEntry(o, sum, minQty, now);
      const opened = this.open(
        {
          ...e.input, qty: sum.qty.toNumber(), entryPrice: sum.price, entryFees: sum.fee.toNumber(), feesByLiquidity: byLiquidity(sum.maker, sum.taker),
          ...this.entryMidAt(o.symbol, e.input.entryMid),
          ...(e.input.entryOrderType === undefined ? { entryOrderType: o.limit ? "limit" : "market" } : {}),
        },
        e.plan,
        now,
      );
      if (o.limit) {
        const tol = Decimal.max(D(minQty), D(o.qty).mul(this.policy.positionTolerance));
        const full = sum.qty.gte(D(o.qty).minus(tol));
        this.bumpStats(now, (s) => (full ? s.entryFilled++ : s.entryPartial++));
      }
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
          ...(o.limit ? { orderType: "limit", limitPrice: o.limit.price, ...(o.limit.cancelReason ? { canceled: o.limit.cancelReason } : {}) } : {}),
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
      qty: sum.qty, price: sum.price, fee: sum.fee, full, now, feesByLiquidity: byLiquidity(sum.maker, sum.taker), exitOrderType: "market",
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
    f: {
      qty: Decimal; price: number; fee?: Decimal; full: boolean; now: number; orderedAt?: number; estimated?: boolean; source?: string;
      feesByLiquidity?: FeesByLiquidity; exitOrderType?: "market" | "limit";
      /** 一部約定でも残りを次のティックで決済しない (板に置いた利確の指値の一部約定: 残りは指値のまま追跡を続ける) */
      noRetry?: boolean;
    },
  ): Applied {
    const x = o.exit!;
    const { now } = f;
    const remain = D(p.qty).minus(f.qty);
    // 読みの管理の記録は決済計画を消す前に作る (全量の決済のときだけ TradeRecord に付く)
    const thesis = this.thesisRecord(p, x.reason, x.thesisStop === true);
    const input = {
      exitPrice: f.price, intendedExitPrice: x.intendedPrice, exitTs: now, exitReason: x.reason, fees: (f.fee ?? D(0)).toNumber(),
      ...(thesis ? { thesis } : {}),
      ...(f.estimated ? { estimated: true } : {}),
      ...(f.feesByLiquidity ? { feesByLiquidity: f.feesByLiquidity } : {}),
      ...(f.exitOrderType ? { exitOrderType: f.exitOrderType } : {}),
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
        if (f.noRetry) {
          this.log.info("利確の指値が一部約定しました。残りは指値のまま追跡を続けます", { symbol: o.symbol, filled: f.qty.toString(), remaining: remain.toString() });
        } else {
          this.plans[p.id] = {
            ...(this.plans[p.id] ?? {}), retryExit: { reason: x.reason, intendedPrice: x.intendedPrice, ...(x.thesisStop ? { thesisStop: true } : {}) },
          };
          this.log.warn("決済が一部約定のみ。残りは次のティックで決済します", { symbol: o.symbol, filled: f.qty.toString(), remaining: remain.toString() });
        }
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
        ...(f.exitOrderType === "limit" ? { orderType: "limit" } : {}),
        ...(f.estimated ? { estimated: true, source: f.source } : {}),
        ...(trade && Number.isFinite(fxRate) && fxRate > 0 ? { fxRate, netPnlAccount: D(trade.netPnl).mul(fxRate).toNumber() } : {}),
      },
    });
    return trade ? { kind: "closed", trade } : { kind: "reduced", position: rest! };
  }

  /**
   * 指値のエントリーが最小数量未満だけ一部約定して終わった (取消・期限)。取引所では決済できない端数 (最小数量未満は
   * 決済できない取引所がある) なので建玉として追跡しない (追跡すると決済を送り続けて銘柄が止まる)。決済の端数 (engine.exit_dust) と同じく
   * 追跡外の残りとして監査ログ limit.dust_entry に残す。新しい建玉ではないので onOpened (テンポのエントリー) も呼ばない。
   * シグナルとしては約定しなかった扱い (期限切れなら仮想トレード limit_unfilled)
   */
  private dustEntry(o: PendingOrder, sum: FillSummary, minQty: number, now: number): Applied {
    const cause: LimitCancelReason = o.limit?.cancelReason ?? "expired";
    const data = {
      symbol: o.symbol, strategyId: o.entry?.input.strategyId, clientId: o.clientId, ...(o.orderId ? { orderId: o.orderId } : {}),
      side: o.side, qty: sum.qty.toString(), price: sum.price, fee: sum.fee.toString(), minQty, requestedQty: o.qty, cause,
    };
    this.log.warn("指値のエントリーが最小数量未満だけ約定しました。決済できない端数のため追跡しません (取引所に端数の建玉が残ります)", data);
    this.deps.store?.audit({ ts: now, type: "limit.dust_entry", data });
    this.bumpStats(now, (s) => s.entryPartial++);
    return { kind: "rejected", reason: `最小数量未満の一部約定 (${sum.qty.toString()} < ${minQty})`, limitUnfilled: { order: { ...o }, cause } };
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
    let maker = D(0);
    let taker = D(0);
    const bad = (why: string): FillSummary => ({ qty: D(0), price: 0, notional: D(0), fee: D(0), maker: D(0), taker: D(0), invalid: why });
    const addFee = (f: Fill) => {
      const x = this.feeInQuote(symbol, f, now);
      fee = fee.plus(x);
      if (f.liquidity === "maker") maker = maker.plus(x);
      else taker = taker.plus(x);
    };
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
        addFee(f);
        continue;
      }
      if (typeof f.price !== "number" || !Number.isFinite(f.price) || f.price <= 0) return bad(`約定価格が不正 (${String(f.price)})`);
      qty = qty.plus(q);
      notional = notional.plus(q.mul(f.price));
      addFee(f);
    }
    return { qty, price: qty.gt(0) ? notional.div(qty).toNumber() : 0, notional, fee, maker, taker };
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
    const lim = this.unknownLimits(o);
    const tooLong = now - o.unknownSince >= lim.ms;
    if (!o.escalated && (o.unknownCount >= lim.count || tooLong)) {
      this.escalate(o, now, reason);
      return;
    }
    this.pending.upsert(o);
  }

  /** escalated にする (新規エントリーを止め、建玉の照会で確定させる)。保存して onEscalated を呼ぶ */
  private escalate(o: PendingOrder, now: number, reason: string): void {
    o.escalated = true;
    o.escalatedAt = now;
    o.unknownSince ??= now;
    o.lastError = reason;
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
  }

  // ───────── 建玉・手動の申告による確定 ─────────

  /**
   * 状態不明の注文を、ブローカーの建玉で判定する。照会に失敗したら何もしない。
   * 同じ判定が POSITION_RESOLVE_CONFIRMATIONS 回続いたら確定する (一覧の反映遅れ対策)。
   * 「約定なし」で確定する前に、orderId が分かっていれば取消を試みる (後から約定するのを防ぐ。成行は失敗してもよい)。
   * 指値のエントリーの「約定なし・一部約定」は、取消に成功して照会で板に無いと確かめたときだけ確定する (confirmLimitGone)
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
    let canceled = true;
    if (cur.kind === "entry" && cur.limit && (r.verdict !== "filled" || r.qty.lt(D(cur.qty)))) {
      // 指値のエントリーは板に残ったまま後で約定しうる: 取消に成功し、照会で板に無いと確かめるまで「約定なし・一部約定」で確定しない
      // (許容差で「全量約定」と判定しても、発注数量に届かない残りは板に残りうるので同じ)。
      // 確かめられなければ保留 (escalated) のまま。この銘柄の新規は保留中の注文で、全体の新規は状態不明で止まり続ける
      const g = await this.confirmLimitGone(broker, cur, now);
      if (g.kind === "applied") return g.applied;
      if (g.kind === "open") {
        const keep = this.pending.get(cur.clientId);
        if (!keep) return undefined;
        keep.positionCheckAt = now;
        keep.lastError = redactSecrets(g.why);
        if (keep.escalated) this.pending.upsert(keep);
        else this.escalate(keep, now, g.why);
        this.auditThrottled(`limunc|${keep.clientId}`, now, "order.limit_unconfirmed", {
          symbol: keep.symbol, clientId: keep.clientId, ...(keep.orderId ? { orderId: keep.orderId } : {}), verdict: r.verdict, why: redactSecrets(g.why),
        });
        this.log.warn(
          "状態不明の指値のエントリーが取引所の板に無いことを確かめられないため、追跡を続けます (取引所で注文を確認し、必要なら orders resolve で解消してください)",
          { symbol: keep.symbol, clientId: keep.clientId, orderId: keep.orderId, verdict: r.verdict, why: g.why },
        );
        return undefined;
      }
      // gone: 取消に成功し、照会でも板に無いことを確かめた
    } else if (r.verdict !== "filled" && cur.orderId) {
      canceled = await this.tryCancel(broker, cur, "確定は続けます");
    }
    const latest = this.pending.get(cur.clientId);
    if (!latest) return undefined;
    latest.positionCheckAt = now;
    const a = this.finalizeResolved(latest, r, now, { source: "position" });
    // 決済が「約定なし」と確定した: 損切り等を止めたままにしないため、新しい clientId ですぐに決済を再送する
    // (古い注文の取消に失敗した場合は二重約定を避けて再送しない。次のティックの決済判定に任せる)
    if (latest.kind === "exit" && r.verdict === "none" && canceled) return (await this.resendExit(latest, r, now)) ?? a;
    return a;
  }

  /**
   * 建玉で「約定なし」と確定した決済を新しい clientId で再送する。数量は追跡数量と取引所の保有数量の小さい方 (reduceOnly)。
   * 再送しなかったら undefined
   */
  private async resendExit(o: PendingOrder, r: Resolution, now: number): Promise<Applied | undefined> {
    const x = o.exit;
    const p = x ? this.deps.journal.get(x.tradeId) : undefined;
    if (!x || !p || r.brokerQty === undefined) return undefined;
    let brokerQty: Decimal;
    try {
      brokerQty = D(r.brokerQty);
    } catch {
      return undefined;
    }
    const held = Decimal.max(p.direction === "long" ? brokerQty : brokerQty.neg(), 0);
    const maxQty = Decimal.min(D(p.qty), held);
    if (!maxQty.isFinite() || !maxQty.gt(0)) return undefined;
    this.exitBackoff.delete(p.symbol);
    this.log.warn("決済が約定していないことを建玉で確認したため、新しい clientId で決済を再送します", {
      symbol: p.symbol, reason: x.reason, previousClientId: o.clientId, qty: maxQty.toString(),
    });
    this.deps.store?.audit({
      ts: now, type: "engine.exit_resend",
      data: { symbol: p.symbol, tradeId: p.id, reason: x.reason, previousClientId: o.clientId, qty: maxQty.toString(), brokerQty: r.brokerQty, trackedQty: String(p.qty) },
    });
    const c = await this.close(p.symbol, x.reason, x.intendedPrice, now, { maxQty });
    switch (c.status) {
      case "closed":
        return c.trade ? { kind: "closed", trade: c.trade } : undefined;
      case "reduced":
        return c.position ? { kind: "reduced", position: c.position } : undefined;
      case "pending":
        return { kind: "pending", ...(c.reason ? { reason: c.reason } : {}) };
      case "rejected":
        return { kind: "rejected", reason: c.reason ?? "rejected" };
      default:
        return undefined;
    }
  }

  /**
   * 状態不明の指値のエントリーが取引所の板に残っていないかを確かめる (建玉で「約定なし・一部約定」と判定したものを確定する前)。
   * - orderId が無ければ照会 (getOrder の hint) で特定する。特定できなければ open
   * - 取消を送り、照会し直す。照会で注文が終わった (取消・約定・拒否) と分かれば、その結果 (実際の約定) を反映する (applied)
   * - 取消に成功し、照会で「見つからない」と答えたら gone (建玉による判定で確定してよい)
   * - それ以外 (取消の失敗・照会の失敗・まだ板にある) は open (確定しない)
   */
  private async confirmLimitGone(
    broker: Broker,
    o: PendingOrder,
    now: number,
  ): Promise<{ kind: "gone" } | { kind: "open"; why: string } | { kind: "applied"; applied: Applied }> {
    const hint = { createdAt: o.createdAt, side: o.side, qty: o.qty };
    /** 照会の結果が「終わった」なら反映する (反映できなければ open) */
    const applyFinal = (res: OrderResult): { kind: "applied"; applied: Applied } | { kind: "open"; why: string } => {
      const cur = this.pending.get(o.clientId);
      if (!cur) return { kind: "open", why: "照会の間に注文の記録が変わりました" };
      const a = this.applyResult(cur, res, now);
      return a.kind === "pending" ? { kind: "open", why: `照会の結果を反映できません (${a.reason ?? res.status})` } : { kind: "applied", applied: a };
    };
    let orderId = o.orderId;
    if (!orderId) {
      let found: OrderResult | undefined;
      try {
        found = await this.call(() => broker.getOrder(o.clientId, o.symbol, undefined, hint), "getOrder");
      } catch (e) {
        return { kind: "open", why: `orderId が分からず、照会でも注文を特定できません: ${redactedErrMsg(e)}` };
      }
      if (!found) return { kind: "open", why: "orderId が分からず、照会でも取引所の注文を特定できません (取消できないため確定しません)" };
      if (isFinalStatus(found.status)) return applyFinal(found);
      if (!found.orderId) return { kind: "open", why: "照会で注文の orderId が分かりません (取消できないため確定しません)" };
      orderId = String(found.orderId);
      const cur = this.pending.get(o.clientId);
      if (cur) {
        cur.orderId = orderId;
        this.pending.upsert(cur);
      }
    }
    const id = orderId;
    let canceled = false;
    try {
      await this.call(() => broker.cancelOrder(id, o.symbol), "cancelOrder");
      canceled = true;
    } catch (e) {
      this.log.warn("状態不明の指値のエントリーの取消に失敗 (照会で確かめます)", { symbol: o.symbol, clientId: o.clientId, orderId: id, error: redactedErrMsg(e) });
    }
    let res: OrderResult | undefined;
    try {
      res = await this.call(() => broker.getOrder(o.clientId, o.symbol, id, hint), "getOrder");
    } catch (e) {
      return { kind: "open", why: `取消${canceled ? "後" : "に失敗した後"}の照会に失敗: ${redactedErrMsg(e)}` };
    }
    if (res && isFinalStatus(res.status)) return applyFinal(res);
    if (res) return { kind: "open", why: `取消${canceled ? "後" : "に失敗し"}も板に残っています (${res.status})` };
    return canceled ? { kind: "gone" } : { kind: "open", why: "取消に失敗し、照会でも注文が見つかりません (板に無いことを確かめられません)" };
  }

  /** 取消を試みる。成功 (または orderId が無い成行で取消できない) なら true、失敗なら false。orderId の無い指値は false (板に残りうる) */
  private async tryCancel(broker: Broker, o: PendingOrder, onFail: string): Promise<boolean> {
    const orderId = o.orderId;
    if (!orderId) return o.limit === undefined;
    try {
      await this.call(() => broker.cancelOrder(orderId, o.symbol), "cancelOrder");
      return true;
    } catch (e) {
      this.log.warn(`注文の取消に失敗 (${onFail})`, { symbol: o.symbol, clientId: o.clientId, orderId, error: redactedErrMsg(e) });
      return false;
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
          const opened = this.open(
            { ...e.input, qty: r.qty.toNumber(), entryPrice: r.price, entryFees: 0, estimated: true, ...this.entryMidAt(o.symbol, e.input.entryMid) },
            e.plan,
            now,
          );
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
        this.deps.store?.audit({
          ts: now, type: "order.manual_resolve",
          data: { ...data, outcome: by.req.outcome, by: by.req.by, requestedAt: by.req.at, ...(by.req.force ? { force: true } : {}) },
        });
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
    if (!o.escalated && req.force !== true) {
      return reject("状態不明 (escalated) ではない注文です。照会で確定するのを待つか、取引所で確認したうえで --force を付けてください");
    }
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
      let canceled: boolean;
      try {
        canceled = await this.tryCancel(this.deps.brokerFor(o.symbol), o, req.outcome === "none" ? "確定せず保留のままにします" : "確定は続けます");
      } catch {
        canceled = false; // 発注先が無い: 取消できない
      }
      if (!canceled && req.outcome === "none") {
        // 取消できなかった注文を「約定なし」と確定すると、後から約定したときに追跡から漏れる。
        // 保留のままにし、建玉の照会で確定させる (escalated にして照会の対象にする)
        const cur = this.pending.get(req.clientId);
        if (!cur) return reject("取消の間に注文が確定しました");
        const message = "取消に失敗したため「約定なし」で確定せず、保留のまま建玉の照会で確定させます";
        if (!cur.escalated) this.escalate(cur, now, `手動の解消 (--none) で取消に失敗`);
        this.log.warn(`手動の解消要求を保留しました: ${message}`, { clientId: req.clientId });
        this.deps.store?.audit({
          ts: now, type: "order.manual_resolve",
          data: {
            symbol: o.symbol, clientId: req.clientId, ...(o.orderId ? { orderId: o.orderId } : {}), kind: o.kind, outcome: req.outcome,
            result: "deferred", reason: message, by: req.by, requestedAt: req.at, ...(req.force ? { force: true } : {}),
          },
        });
        return { applied: false, message };
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
  ): { orphaned: string[]; reduced: string[]; waiting: string[]; untracked: string[]; trades: TradeRecord[]; limitExcess: string[] } {
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
    const limitExcess = this.checkLimitExcess(bySymbol, now, opts.confirmations ?? 1, phase);
    return { orphaned, reduced, waiting, untracked, trades, limitExcess };
  }

  /**
   * 指値のエントリーを待っている (状態不明を含む) 銘柄は、上の突き合わせの対象外 (保留中の注文がある)。その代わり、取引所の建玉が
   * 「追跡数量 + 保留中の注文 (買い・売り) で説明できる範囲」を超えて大きい (または追跡していないのに建玉がある) なら異常として
   * onAnomaly (engine は kill switch) を呼ぶ (取消を確かめられないまま板に残った指値の約定などで、追跡外の建玉ができている)。
   * 待っている指値の約定 (照会の前) で説明できる分・最小数量未満の端数は異常にしない。confirmations 回続いたら確定する。異常にした銘柄を返す
   */
  private checkLimitExcess(bySymbol: Map<string, Decimal>, now: number, confirmations: number, phase: string): string[] {
    const out: string[] = [];
    const pend = this.pending.list();
    const syms = new Set(pend.filter((o) => o.kind === "entry" && o.limit).map((o) => o.symbol));
    for (const sym of [...this.excessObs.keys()]) if (!syms.has(sym)) this.excessObs.delete(sym);
    for (const sym of syms) {
      const b = bySymbol.get(sym) ?? D(0);
      const t = this.get(sym);
      const tracked = t ? D(t.qty).mul(t.direction === "long" ? 1 : -1) : D(0);
      let buys = D(0);
      let sells = D(0);
      for (const o of pend) {
        if (o.symbol !== sym) continue;
        let q: Decimal;
        try {
          q = D(o.qty);
        } catch {
          continue;
        }
        if (!q.isFinite() || q.lte(0)) continue;
        if (o.side === "buy") buys = buys.plus(q);
        else sells = sells.plus(q);
      }
      const minQty = D(this.deps.instrumentOf?.(sym)?.minQty ?? 0);
      const tol = Decimal.max(minQty, tracked.abs().plus(buys).plus(sells).mul(this.policy.positionTolerance));
      // 説明できる範囲: [追跡 − 売りの保留, 追跡 + 買いの保留] (± 許容差)
      const above = b.minus(tracked.plus(buys));
      const below = tracked.minus(sells).minus(b);
      // 追跡より小さい (外部の決済・保留中の決済) は対象外 (保留が確定してから上の突き合わせで扱う)。大きい・逆方向・追跡外だけ
      const flipped = !b.isZero() && !tracked.isZero() && b.isPositive() !== tracked.isPositive();
      const larger = b.abs().gt(tracked.abs().plus(tol)) || (flipped && b.abs().gt(tol));
      if (!(larger && (above.gt(tol) || below.gt(tol)))) {
        this.excessObs.delete(sym);
        continue;
      }
      const base = { symbol: sym, brokerQty: b.toString(), trackedQty: tracked.toString(), pendingBuy: buys.toString(), pendingSell: sells.toString(), phase };
      const n = (this.excessObs.get(sym) ?? 0) + 1;
      if (n < confirmations) {
        this.excessObs.set(sym, n);
        this.log.warn("指値のエントリーを待っている銘柄で、取引所の建玉が追跡より大きくなっています (再確認します)", { ...base, observations: n });
        this.deps.store?.audit({ ts: now, type: "reconcile.limit_excess_waiting", data: { ...base, observations: n, required: confirmations } });
        continue;
      }
      this.excessObs.delete(sym);
      const msg =
        `${sym}: 指値のエントリーを待っている銘柄で、取引所の建玉 (${b.toString()}) が追跡 (${tracked.toString()}) と保留中の注文 ` +
        `(買い ${buys.toString()} / 売り ${sells.toString()}) で説明できる範囲を超えています。板に残った注文の約定など追跡していない建玉の可能性があります。` +
        "取引所で注文と建玉を確認してください";
      this.log.error(msg);
      this.deps.store?.audit({ ts: now, type: "reconcile.limit_excess", data: base });
      this.deps.onAnomaly?.(msg, now);
      out.push(sym);
    }
    return out;
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
