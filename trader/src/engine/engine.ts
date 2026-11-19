import type { AiOptions } from "../core/ai";
import type { AppConfig } from "../core/config";
import { D, Decimal } from "../core/decimal";
import { redactSecrets } from "../core/http";
import { createLogger, type Logger } from "../core/logger";
import {
  systemClock, type Balance, type Broker, type BrokerPosition, type Clock, type EntryContext, type Instrument, type IntelBias, type MarketBrief,
  type MarketView, type OrderRequest, type Params, type Quote, type RegimeFeatures, type Signal, type Store, type Strategy, type StrategyContext,
  type StrategyPlan, type Timeframe, type TradeRecord,
} from "../core/types";
import type { BrokerSet } from "../execution/router";
import type { PaperSnapshot } from "../execution/paper";
import type { IntelService } from "../intel/service";
import { buildBaselinePlan, buildStrategyPlan, MAX_RISK_MULTIPLIER } from "../intel/planner";
import { DEX_SOURCE } from "../intel/sources/dexscreener";
import { armKey } from "../learning/allocator";
import { TradeJournal } from "../learning/journal";
import type { LearningService, PeriodicResult } from "../learning/service";
import type { DexScreenerFeed } from "../market/feeds/dexscreener";
import type { MarketHub } from "../market/hub";
import { detectRegime, regimeOptionsFor } from "../regime/detect";
import { clearResumeRequest, peekResumeRequest } from "../risk/resumeRequest";
import { costBps, type RiskManager, type RiskPosition } from "../risk/manager";
import { ALL_STRATEGIES, resolveParams } from "../strategies/registry";
import {
  activeBlackout, emptyBrief, intelBiasFor, liquidityUsdFor, normalizeReason, planRegimeTimeframe, selectAutoMemeCandidates,
} from "./context";
import { runGrouped, withDeadline } from "./deadline";
import { createFxConverter, type FxConverter } from "./fx";
import { peekResolveRequests, removeResolveRequests, type PendingEntry, type PendingOrder, type PendingStatus } from "./orders";
import { DEFAULT_ORDER_POLICY, PositionManager, type EntryResult, type OrderPolicy } from "./positions";

export const PAPER_SNAPSHOT_KEY = "paper:snapshot";
export const AUTO_MEME_KEY = "engine:autoMemeWatch";
/** レジーム判定に必要な最低本数 (未満なら「レジーム不明」) */
const MIN_REGIME_BARS = 30;
/** エラー文 (ccxt は URL・署名を含みうる) は伏せてから記録する */
const errMsg = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e));

export interface EngineOptions {
  /** 評価額の保存間隔 (既定 60 秒) */
  equityEveryMs?: number;
  /** これより古い気配では新規エントリーしない (既定 30 秒) */
  maxQuoteAgeMs?: number;
  /** start() のティック間隔 (既定 SCALP_LOOP_MS) */
  tickMs?: number;
  /** 情報ループ間隔 (既定 INTEL_LOOP_MS) */
  intelEveryMs?: number;
  /** 学習ループ間隔 (既定 LEARN_LOOP_MS) */
  learnEveryMs?: number;
  /** 自動ミーム監視の最大件数 (既定 5) */
  autoMemeMax?: number;
  /** PaperBroker の snapshot に残す注文結果の件数 (冪等性の確認用, 既定 500) */
  snapshotResultsKeep?: number;
  /** live モードで口座情報を取り直す間隔 (既定 10 秒) */
  liveAccountCacheMs?: number;
  /** 市場データ取得 (hub.poll) の時間上限。超えた venue は次回へ持ち越す (既定 tickMs、最小 1 秒) */
  pollTimeoutMs?: number;
  /** ブローカーの建玉との定期的な突き合わせの間隔 (既定 5 分) */
  reconcileEveryMs?: number;
  /** これより新しいポジションは定期の突き合わせで外さない (約定の反映遅れ対策, 既定 60 秒) */
  reconcileMinAgeMs?: number;
  /** kill switch 作動中に残った建玉の決済を再試行する間隔 (既定 30 秒) */
  killSwitchRetryMs?: number;
  /** 口座照会がこの回数続けて失敗したら新規エントリーを止める (既定 3) */
  accountFailLimit?: number;
  /** ブローカー呼び出し (発注・照会・取消・口座) の締め切り (既定 8 秒)。超えた発注は状態不明の保留として扱う */
  brokerTimeoutMs?: number;
  /** 保留中の注文の扱い (取消までの時間・状態不明の上限・決済の発注レート上限など) */
  orderPolicy?: Partial<OrderPolicy>;
}

export interface EngineDeps {
  config: AppConfig;
  store: Store;
  hub: MarketHub;
  brokerSet: BrokerSet;
  risk: RiskManager;
  intel: Pick<IntelService, "refresh">;
  learning: LearningService;
  strategies?: readonly Strategy[];
  clock?: Clock;
  ai?: AiOptions;
  logger?: Logger;
  journal?: TradeJournal;
  fx?: FxConverter;
  /** 腕の探索に使う乱数 (シミュレーションでは固定シード) */
  rng?: () => number;
  /** AUTO_MEME_WATCH 用 */
  dexFeed?: DexScreenerFeed;
  /** hub が保持する時間足 (計画用レジームの時間足を選ぶのに使う) */
  timeframes?: Timeframe[];
  options?: EngineOptions;
}

export interface TickResult {
  now: number;
  equity: number;
  entries: number;
  exits: number;
  evaluations: number;
  killSwitchTripped: boolean;
}

export interface AccountState {
  equity: number;
  available: number;
  positions: RiskPosition[];
  prices: Record<string, number>;
  /** 一度も取得できていない (または換算できない) ブローカーがあり、評価額が欠けている */
  incomplete?: boolean;
  missing?: string[];
  /** 取得に失敗し前回値を使ったブローカー */
  stale?: string[];
  /** 取得の失敗が続いている (新規エントリーを止める) */
  degradedReason?: string;
  /** 保留中のエントリーの件数 (positions に想定代金で加え、available から引いた) */
  pendingEntries?: number;
}

/** ブローカーごとの最後に取得できた口座情報 */
interface BrokerAccountCache {
  balance?: Balance;
  positions?: BrokerPosition[];
  at?: number;
  failures: number;
  lastError?: string;
}

interface Gate {
  ok: boolean;
  reason?: string;
  directionBias: "long" | "short" | "both";
  riskMultiplier: number;
}

interface Candidate {
  strategy: Strategy;
  signal: Signal;
  regime: RegimeFeatures;
  params: Params;
  intel?: IntelBias;
  armWeight: number;
  riskMultiplier: number;
  score: number;
}

interface TickCtx {
  now: number;
  brief?: MarketBrief;
  plan?: StrategyPlan;
  halted: boolean;
  haltReason?: string;
  account: AccountState;
  /** 口座情報の欠落・取得失敗の継続による新規エントリーの停止 */
  entryBlock?: { key: string; sample: string };
  /** このティックで市場データの取得が時間内に終わらなかった銘柄 (新規エントリーの対象外) */
  timedOut: Set<string>;
  regimes: Map<string, RegimeFeatures>;
  intel: Map<string, IntelBias | undefined>;
  entries: number;
  exits: number;
  evaluations: number;
}

export interface PositionStatus {
  id: string;
  symbol: string;
  strategyId: string;
  direction: "long" | "short";
  qty: number;
  entryPrice: number;
  entryTs: number;
  lastPrice: number;
  stop: number;
  takeProfit?: number;
  /** 含み損益 (クオート通貨 / 口座通貨) */
  unrealizedPnl: number;
  unrealizedPnlAccount?: number;
  quoteCurrency: string;
}

export interface EngineStatus {
  now: number;
  mode: "paper" | "live";
  liveBlockedReason?: string;
  baseCurrency: string;
  watched: { symbol: string; venue: string; assetClass: string; lastError?: string }[];
  equity: { current: number; initial: number; cash?: number; realized?: number; unrealized?: number; available: number };
  risk: {
    halted: boolean;
    reason?: string;
    killSwitch?: { at: number; reason: string };
    haltedUntil?: number;
    /** 状態不明の注文による新規エントリーの停止 (確定すれば自動で再開) */
    entriesPaused?: { since: number; orders: string[] };
    peakEquity: number;
    dayStartEquity: number;
    limits: AppConfig["risk"];
  };
  positions: PositionStatus[];
  /** 保留中の注文 (受付済み・未約定、または状態不明) */
  pendingOrders: {
    symbol: string; kind: "entry" | "exit"; clientId: string; orderId?: string; status: PendingStatus; createdAt: number; unknownCount: number;
    lastError?: string; escalated?: boolean;
  }[];
  plan?: {
    generatedAt: number;
    validUntil: number;
    rationale: string;
    symbols: { symbol: string; enabledStrategies: string[]; directionBias: string; riskMultiplier: number; notes?: string }[];
    blackouts: StrategyPlan["blackouts"];
  };
  brief?: {
    generatedAt: number;
    riskOn: number;
    summary: string;
    stub: boolean;
    watchlist: string[];
    biases: { asset: string; sentiment: number; confidence: number; eventRisk: number }[];
    events: { ts: number; title: string; currency?: string; impact: string }[];
  };
  equityHistory: { ts: number; equity: number }[];
  lastTickAt?: number;
  tickCount: number;
}

/** 等間隔に間引く (先頭と末尾は残す) */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max || max < 2) return arr.slice();
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

const midOf = (q: Quote) => (q.bid + q.ask) / 2;

/**
 * 売買エンジン。依存はすべて注入する。
 * tick(now) は 1 回分の処理で、テスト・シミュレーションから直接呼べる。start()/stop() は実時間のループ。
 */
export class TradingEngine {
  readonly config: AppConfig;
  readonly store: Store;
  readonly hub: MarketHub;
  readonly brokerSet: BrokerSet;
  readonly risk: RiskManager;
  readonly learning: LearningService;
  readonly journal: TradeJournal;
  readonly positions: PositionManager;
  readonly fx: FxConverter;
  readonly strategies: readonly Strategy[];
  readonly clock: Clock;
  private readonly intel: Pick<IntelService, "refresh">;
  private readonly ai?: AiOptions;
  private readonly log: Logger;
  private readonly rng: () => number;
  private readonly dexFeed?: DexScreenerFeed;
  private readonly timeframes?: Timeframe[];
  private readonly opt: Required<Omit<EngineOptions, "tickMs" | "intelEveryMs" | "learnEveryMs">> & {
    tickMs: number;
    intelEveryMs: number;
    learnEveryMs: number;
  };

  /** 銘柄×戦略ごとに最後に評価した主時間足の確定足の時刻 */
  private readonly lastEval = new Map<string, number>();
  private readonly skips = new Map<string, { count: number; sample: string }>();
  private initialized = false;
  private lastEquitySave?: number;
  private lastSkipFlush?: number;
  private lastIntelAt?: number;
  private lastLearnAt?: number;
  private intelRunning = false;
  private learnRunning = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private inflight?: Promise<unknown>;
  /** 実行中の情報ループ・学習ループ (stop で完了を待つ) */
  private readonly background = new Set<Promise<unknown>>();
  private stopped = false;
  private acctCache?: { at: number; value: AccountState };
  private readonly brokerAcct = new Map<Broker, BrokerAccountCache>();
  private accountDegradedAudited = false;
  private lastReconcileAt?: number;
  private lastKillCloseAt?: number;
  private readonly warnedAt = new Map<string, number>();
  /** 状態不明の注文による新規エントリーの停止 (ソフト停止) */
  private entriesPaused?: { since: number; clientIds: string[] };
  private lastTickAt?: number;
  private tickCount = 0;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.hub = deps.hub;
    this.brokerSet = deps.brokerSet;
    this.risk = deps.risk;
    this.learning = deps.learning;
    this.intel = deps.intel;
    this.strategies = deps.strategies ?? ALL_STRATEGIES;
    this.clock = deps.clock ?? systemClock;
    this.ai = deps.ai;
    this.log = deps.logger ?? createLogger("engine");
    this.rng = deps.rng ?? Math.random;
    this.dexFeed = deps.dexFeed;
    this.timeframes = deps.timeframes;
    const env = deps.config.env;
    const o = deps.options ?? {};
    this.opt = {
      equityEveryMs: o.equityEveryMs ?? 60_000,
      maxQuoteAgeMs: o.maxQuoteAgeMs ?? 30_000,
      tickMs: o.tickMs ?? env.SCALP_LOOP_MS,
      intelEveryMs: o.intelEveryMs ?? env.INTEL_LOOP_MS,
      learnEveryMs: o.learnEveryMs ?? env.LEARN_LOOP_MS,
      autoMemeMax: o.autoMemeMax ?? 5,
      snapshotResultsKeep: o.snapshotResultsKeep ?? 500,
      liveAccountCacheMs: o.liveAccountCacheMs ?? 10_000,
      pollTimeoutMs: o.pollTimeoutMs ?? Math.max(1_000, o.tickMs ?? env.SCALP_LOOP_MS),
      reconcileEveryMs: o.reconcileEveryMs ?? 300_000,
      reconcileMinAgeMs: o.reconcileMinAgeMs ?? 60_000,
      killSwitchRetryMs: o.killSwitchRetryMs ?? 30_000,
      accountFailLimit: o.accountFailLimit ?? 3,
      brokerTimeoutMs: o.brokerTimeoutMs ?? o.orderPolicy?.brokerTimeoutMs ?? DEFAULT_ORDER_POLICY.brokerTimeoutMs,
      orderPolicy: o.orderPolicy ?? {},
    };
    this.fx = deps.fx ?? createFxConverter({ baseCurrency: env.BASE_CURRENCY, getQuote: (s) => this.hub.latestQuote(s) });
    // 追跡ポジション・保留中の注文・決済ルールは mode 別に保存する (paper と live を混ぜない)
    this.journal = deps.journal ?? new TradeJournal({ store: deps.store, mode: deps.brokerSet.mode });
    if (this.journal.mode !== deps.brokerSet.mode) throw new Error(`journal の mode (${this.journal.mode}) とブローカーの mode (${deps.brokerSet.mode}) が違います`);
    this.positions = new PositionManager({
      journal: this.journal,
      brokerFor: (s) => this.brokerFor(s),
      onTradeClosed: (t) => this.onTradeClosed(t),
      onOrder: (now) => this.risk.recordOrder(now),
      store: deps.store,
      logger: this.log,
      toAccount: (ccy) => this.fx.toAccount(ccy),
      quoteCurrencyOf: (s) => this.hub.instrument(s)?.quoteCurrency,
      instrumentOf: (s) => this.hub.instrument(s),
      fxRate: (from, to) => this.fx.rate(from, to),
      priceOf: (s) => this.priceOf(s),
      onAnomaly: (reason, now) => this.onAnomaly(reason, now),
      onEscalated: (o, now) => this.onOrderEscalated(o, now),
      orderPolicy: { ...this.opt.orderPolicy, brokerTimeoutMs: this.opt.brokerTimeoutMs },
    });
  }

  get mode(): "paper" | "live" {
    return this.brokerSet.mode;
  }

  /** paper では単一の PaperBroker (後から追加した銘柄も扱える)、live は venue 別 */
  brokerFor(symbol: string): Broker {
    return this.brokerSet.paper ?? this.brokerSet.brokerFor(symbol);
  }

  /** 建玉の不整合が確実な異常 (追跡中の銘柄でエントリーが約定・決済の約定超過): kill switch で止め、手動確認を促す */
  private onAnomaly(reason: string, now: number): void {
    this.log.error("建玉の不整合を検知したためキルスイッチを作動させます。取引所で建玉を確認し、問題が無ければ resume してください", { reason });
    this.risk.trip(reason, now);
    this.acctCache = undefined;
  }

  /**
   * 注文状態の不明が続いた (escalated): kill switch は発動せず、エンジン全体の新規エントリーだけを止める
   * (他の銘柄の損切り・利確・決済は続ける)。建玉の照会で確定すれば自動で再開する
   */
  private onOrderEscalated(o: PendingOrder, now: number): void {
    this.log.error(
      "注文状態が確認できません。新規エントリーを止めます (損切り・利確・決済は続けます)。" +
        "建玉の照会で自動的に確定させ、確定すれば再開します。急ぐ場合は取引所で注文と建玉を確認し、" +
        "`npm run trader -- orders resolve <clientId> --none` または `--filled --qty <数量> --price <価格>` で解消してください",
      { symbol: o.symbol, kind: o.kind, clientId: o.clientId, ...(o.orderId ? { orderId: o.orderId } : {}), error: o.lastError },
    );
    this.acctCache = undefined;
    this.entryPause(now);
  }

  /**
   * 状態不明 (escalated) の保留注文があれば新規エントリーを止める理由を返す (ソフト停止)。
   * 1 件も無くなれば自動で再開する。開始・再開は監査ログに残す
   */
  private entryPause(now: number): { key: string; sample: string } | undefined {
    const esc = this.positions.escalatedOrders();
    if (esc.length > 0) {
      const clientIds = esc.map((o) => o.clientId);
      if (!this.entriesPaused) {
        this.entriesPaused = { since: now, clientIds };
        this.store.audit({ ts: now, type: "engine.entries_paused", data: { orders: esc.map((o) => ({ symbol: o.symbol, kind: o.kind, clientId: o.clientId })) } });
      } else this.entriesPaused.clientIds = clientIds;
      return { key: "order_unknown", sample: `状態不明の注文 ${esc.length} 件の確定待ち (${[...new Set(esc.map((o) => o.symbol))].join(", ")})` };
    }
    if (this.entriesPaused) {
      this.log.warn("状態不明の注文が解消したため新規エントリーを再開します", { pausedMs: now - this.entriesPaused.since });
      this.store.audit({ ts: now, type: "engine.entries_resumed", data: { since: this.entriesPaused.since, pausedMs: now - this.entriesPaused.since } });
      this.entriesPaused = undefined;
    }
    return undefined;
  }

  /** ブローカー呼び出しの締め切り */
  private brokerCall<T>(fn: () => Promise<T>, label: string): Promise<T> {
    return withDeadline((async () => fn())(), this.opt.brokerTimeoutMs, label);
  }

  /** 解消の要求 (CLI `orders resolve`) を適用して消す。適用した件数 */
  private async applyResolveRequests(now: number): Promise<number> {
    const reqs = peekResolveRequests(this.store, this.mode);
    if (reqs.length === 0) return 0;
    let applied = 0;
    for (const r of reqs) {
      try {
        const res = await this.positions.applyResolveRequest(r, now);
        if (res.applied) applied++;
        this.log.warn(`手動の解消要求: ${res.message}`, { clientId: r.clientId, outcome: r.outcome, by: r.by });
      } catch (e) {
        this.log.error("手動の解消要求の適用に失敗", { clientId: r.clientId, error: errMsg(e) });
      }
    }
    removeResolveRequests(this.store, this.mode, reqs.map((r) => r.id));
    if (applied > 0) {
      this.saveSnapshot();
      this.acctCache = undefined;
    }
    return applied;
  }

  /** 同じ警告を間引く */
  private warnThrottled(key: string, now: number, msg: string, data?: Record<string, unknown>): void {
    const last = this.warnedAt.get(key);
    if (last !== undefined && now - last < 60_000) return;
    this.warnedAt.set(key, now);
    this.log.warn(msg, data);
  }

  private priceOf(symbol: string): number | undefined {
    const q = this.hub.latestQuote(symbol);
    return q && q.bid > 0 && q.ask > 0 ? midOf(q) : undefined;
  }

  private onTradeClosed(t: TradeRecord): void {
    try {
      this.learning.onTradeClosed(t);
    } catch (e) {
      this.log.error("学習への反映に失敗", { tradeId: t.id, error: errMsg(e) });
    }
    this.saveSnapshot();
    this.acctCache = undefined;
  }

  // ───────── 起動時の復元 ─────────

  /** PaperBroker の snapshot を復元し、追跡中ポジションとブローカーの建玉を突き合わせる (冪等) */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const now = this.clock.now();
    const paper = this.brokerSet.paper;
    const snap = this.store.kvGet<PaperSnapshot>(PAPER_SNAPSHOT_KEY);
    if (paper && snap) {
      try {
        paper.restore(snap);
        this.log.info("ペーパー口座を復元しました", { positions: snap.positions.length });
      } catch (e) {
        this.log.warn("ペーパー口座の復元に失敗", { error: errMsg(e) });
      }
    }
    if (this.config.env.AUTO_MEME_WATCH && this.dexFeed) await this.restoreAutoMeme();
    // エンジン停止中に書かれた解消の要求 (CLI `orders resolve`) を適用する
    await this.applyResolveRequests(now);
    try {
      const brokerPositions = await this.brokerPositions();
      const r = this.positions.reconcile(brokerPositions, now, { priceOf: (s) => this.priceOf(s), phase: "startup", confirmations: this.reconcileConfirmations() });
      if (r.orphaned.length) this.log.warn("ブローカーに建玉が無い追跡ポジションを外しました", { symbols: r.orphaned });
      if (r.untracked.length) {
        this.log.warn(
          `エンジンが追跡していない建玉があります (自動では決済しません${this.mode === "live" ? "。この銘柄には新規エントリーしません" : ""})`,
          { symbols: r.untracked },
        );
      }
    } catch (e) {
      this.log.warn("建玉の突き合わせに失敗", { error: errMsg(e) });
    }
    this.lastReconcileAt = now;
    const pending = this.positions.pendingOrders();
    if (pending.length) this.log.warn("保留中の注文があります。照会して確定させます", { orders: pending.map((o) => `${o.symbol} ${o.kind} ${o.clientId}`) });
    this.entryPause(now);
    this.store.audit({
      ts: now,
      type: "engine.start",
      data: { mode: this.mode, watched: this.hub.watched().map((i) => i.symbol), openPositions: this.journal.list().length, pendingOrders: pending.length },
    });
  }

  private uniqueBrokers(): Broker[] {
    return this.brokerSet.paper ? [this.brokerSet.paper] : [...new Set(this.brokerSet.brokers.values())];
  }

  /** 全ブローカーの建玉 (venue ごとに並列・締め切りあり)。1 つでも失敗したら例外 */
  private async brokerPositions(): Promise<BrokerPosition[]> {
    const lists = await Promise.all(this.uniqueBrokers().map((b) => this.brokerCall(() => b.getPositions(), `${b.venue} getPositions`)));
    return lists.flat();
  }

  // ───────── 口座 ─────────

  /**
   * 評価額 (口座通貨)・余力・建玉。会計値は decimal で合算する。
   * live はブローカー単位で失敗を許容し、前回の値を使う (取得できたことが無い・換算できないブローカーがあれば incomplete)。
   * 失敗が accountFailLimit 回続いたら degradedReason を付ける (エンジンは新規エントリーを止める)。
   * 保留中のエントリーは、想定代金 (数量 × 想定価格を口座通貨に換算) の建玉として positions に加え、available から引く
   * (受付だけで約定が遅れる間に、最大保有数・余力・エクスポージャーの上限を超えて発注しないため)。
   */
  async account(now: number = this.clock.now(), force = false): Promise<AccountState> {
    return this.withPendingEntries(await this.brokerAccount(now, force));
  }

  /** 保留中のエントリーを口座情報に加える (base は変更しない) */
  private withPendingEntries(base: AccountState): AccountState {
    const entries = this.positions.pendingOrders().filter((o) => o.kind === "entry" && o.entry);
    if (entries.length === 0) return base;
    let available = D(base.available);
    const positions = [...base.positions];
    for (const o of entries) {
      const e = o.entry!.input;
      const inst = this.hub.instrument(o.symbol);
      const px = e.intendedEntryPrice;
      let qty: Decimal;
      try {
        qty = D(o.qty);
      } catch {
        continue;
      }
      if (!qty.isFinite() || !qty.gt(0) || !(px > 0)) continue;
      const cs = e.contractSize ?? inst?.contractSize ?? 1;
      const ccy = inst?.quoteCurrency;
      positions.push({
        symbol: o.symbol,
        qty: qty.mul(o.side === "buy" ? 1 : -1).toNumber(),
        avgPrice: px,
        price: px,
        assetClass: e.assetClass,
        contractSize: cs,
        ...(ccy ? { quoteCurrency: ccy } : {}),
      });
      const rate = ccy ? this.fx.toAccount(ccy) : NaN;
      if (Number.isFinite(rate) && rate > 0) available = available.minus(qty.mul(px).mul(cs).mul(rate));
    }
    return { ...base, available: available.toNumber(), positions, pendingEntries: entries.length };
  }

  /** ブローカーの口座情報 (保留中のエントリーを含まない)。live は venue ごとに並列・締め切りあり */
  private async brokerAccount(now: number, force: boolean): Promise<AccountState> {
    const paper = this.brokerSet.paper;
    if (!paper && !force && this.acctCache && now - this.acctCache.at < this.opt.liveAccountCacheMs) return this.acctCache.value;
    let equity = D(0);
    let available = D(0);
    const raw: BrokerPosition[] = [];
    const missing: string[] = [];
    const stale: string[] = [];
    let degradedReason: string | undefined;
    if (paper) {
      equity = D(paper.markToMarket().equity);
      available = D((await paper.getBalance()).available);
      raw.push(...(await paper.getPositions()));
    } else {
      const brokers = this.uniqueBrokers();
      // venue ごとに並列で取得する (1 つの venue の遅延が他を止めない。同じ venue の中は順番どおり)
      const fetched = await Promise.all(
        brokers.map(async (b) => {
          try {
            const bal = await this.brokerCall(() => b.getBalance(), `${b.venue} getBalance`);
            const pos = await this.brokerCall(() => b.getPositions(), `${b.venue} getPositions`);
            return { bal, pos };
          } catch (e) {
            return { error: e };
          }
        }),
      );
      for (const [i, b] of brokers.entries()) {
        const st = this.brokerAcct.get(b) ?? { failures: 0 };
        this.brokerAcct.set(b, st);
        try {
          const f = fetched[i];
          if ("error" in f) throw f.error;
          const { bal, pos } = f;
          if (!D(bal.equity).isFinite() || !D(bal.available).isFinite()) throw new Error(`残高が数値ではありません (equity=${bal.equity})`);
          if (st.failures > 0) this.log.info("口座情報の取得が回復しました", { venue: b.venue, failures: st.failures });
          st.balance = bal;
          st.positions = pos;
          st.at = now;
          st.failures = 0;
          delete st.lastError;
        } catch (e) {
          st.failures++;
          st.lastError = errMsg(e);
          this.warnThrottled(`acct|${b.venue}`, now, "口座情報の取得に失敗 (前回の値を使います)", { venue: b.venue, failures: st.failures, error: st.lastError });
          if (st.failures >= this.opt.accountFailLimit) degradedReason = `${b.venue}: 口座情報の取得に ${st.failures} 回連続で失敗 (${st.lastError})`;
          if (!st.balance) {
            missing.push(b.venue);
            continue;
          }
          stale.push(b.venue);
        }
        const bal = st.balance!;
        const rate = this.fx.toAccount(bal.currency);
        if (!Number.isFinite(rate) || !(rate > 0)) {
          this.warnThrottled(`acctfx|${b.venue}`, now, "口座通貨へ換算できない残高があります (評価額が欠けるため停止判定を保留します)", { venue: b.venue, currency: bal.currency });
          missing.push(b.venue);
          continue;
        }
        equity = equity.plus(D(bal.equity).mul(rate));
        available = available.plus(D(bal.available).mul(rate));
        raw.push(...(st.positions ?? []));
      }
    }
    const prices: Record<string, number> = {};
    const positions: RiskPosition[] = [];
    for (const p of raw) {
      const q = this.hub.latestQuote(p.symbol);
      const price = q ? midOf(q) : p.avgPrice;
      prices[p.symbol] = price;
      positions.push({ symbol: p.symbol, qty: Number(p.qty), avgPrice: p.avgPrice, price });
    }
    const value: AccountState = {
      equity: equity.toNumber(),
      available: available.toNumber(),
      positions,
      prices,
      ...(missing.length ? { incomplete: true, missing } : {}),
      ...(stale.length ? { stale } : {}),
      ...(degradedReason ? { degradedReason } : {}),
    };
    if (degradedReason && !this.accountDegradedAudited) {
      this.accountDegradedAudited = true;
      this.log.error("口座情報の取得失敗が続いています。新規エントリーを止めます (決済は続けます)", { reason: degradedReason });
      this.store.audit({ ts: now, type: "engine.account_degraded", data: { reason: degradedReason } });
    } else if (!degradedReason && !missing.length) this.accountDegradedAudited = false;
    this.acctCache = { at: now, value };
    return value;
  }

  // ───────── 1 ティック ─────────

  async tick(now: number = this.clock.now()): Promise<TickResult> {
    if (!this.initialized) await this.init();
    const p = this.tickInner(now);
    this.inflight = p;
    try {
      return await p;
    } finally {
      if (this.inflight === p) this.inflight = undefined;
    }
  }

  private async tickInner(now: number): Promise<TickResult> {
    let killedBefore = Boolean(this.risk.state().killSwitch);
    // 1. 市場データ (venue ごとに並列。時間上限を超えた venue は次回へ持ち越し、その銘柄はこのティックで新規エントリーしない)
    let timedOut = new Set<string>();
    try {
      const r = await this.hub.poll({ timeoutMs: this.opt.pollTimeoutMs });
      timedOut = new Set(r?.timedOutSymbols ?? []);
    } catch (e) {
      this.log.error("市場データの取得に失敗", { error: errMsg(e) });
    }
    const insts = this.hub.watched();
    const quotes = new Map<string, Quote>();
    for (const inst of insts) {
      const q = this.hub.latestQuote(inst.symbol);
      if (!q) continue;
      quotes.set(inst.symbol, q);
      // ペーパー口座へ気配を渡す (指値の約定判定・評価額)
      this.brokerSet.paper?.onQuote(inst.symbol, q);
    }

    // 2. ポジション管理 (損切り・利確・トレーリング・時間切れ)。口座照会より前に、直近の気配で銘柄ごとに分離して判定する
    let exits = await this.manageExits(quotes, now);

    // 3. 手動の解消要求 (CLI `orders resolve`) を適用し、保留中の注文を照会して確定したものを journal に反映する
    //    (状態不明が続いた注文は建玉で確定させる。決済の拒否後の建玉確認もここで行う。venue ごとに並列)
    let entries = 0;
    await this.applyResolveRequests(now);
    if (this.positions.pending.size > 0 || this.positions.hasDeferredChecks()) {
      const sync = await this.positions.syncPending(now);
      entries += sync.opened.length;
      exits += sync.closed.length + sync.reduced;
      if (sync.opened.length || sync.closed.length || sync.reduced || sync.resolved || sync.reconciled) {
        this.saveSnapshot();
        this.acctCache = undefined;
      }
    }

    // 4. 評価額 (ブローカー単位で失敗を許容)
    let account = await this.account(now, Boolean(this.brokerSet.paper) || exits > 0 || entries > 0);
    // 別プロセスの CLI `resume` からの再開要求 (kv) を毎ティック確認し、あれば適用して消す (自分の mode 宛てのみ)
    const resumeReq = peekResumeRequest(this.store);
    if (resumeReq) {
      if ((resumeReq.mode ?? "paper") !== this.mode) {
        this.warnThrottled("resume_mode", now, "別の mode 宛ての再開要求は適用しません", { requestMode: resumeReq.mode ?? "paper", mode: this.mode });
      } else if (account.incomplete) {
        this.warnThrottled("resume_wait", now, "口座情報が揃うまで再開要求の適用を保留します", { missing: account.missing });
      } else {
        const was = this.risk.state();
        this.risk.resume({ equity: account.equity, now, by: resumeReq.by });
        clearResumeRequest(this.store);
        killedBefore = false;
        this.log.warn("再開要求を適用しました", { by: resumeReq.by, requestedAt: resumeReq.at });
        const esc = this.positions.escalatedOrders();
        if (esc.length) {
          this.log.warn(
            "状態不明の注文が残っているため、新規エントリーは止めたままです。建玉の照会で確定するのを待つか、" +
              "`npm run trader -- orders resolve <clientId> --none|--filled --qty <数量> --price <価格>` で解消してください",
            { orders: esc.map((o) => `${o.symbol} ${o.kind} clientId=${o.clientId}`) },
          );
        }
        this.store.audit({
          ts: now,
          type: "engine.resume_request_applied",
          data: { by: resumeReq.by, requestedAt: resumeReq.at, wasKillSwitch: Boolean(was.killSwitch), wasHalted: was.haltedUntil !== undefined },
        });
      }
    }

    // 5. リスク判定。評価額が欠けている間は更新しない (見かけの損失で停止させない)
    let drawdownPct: number | undefined;
    if (account.incomplete) {
      this.warnThrottled("equity_incomplete", now, "口座情報が欠けているため停止判定を保留します", { missing: account.missing });
    } else {
      drawdownPct = this.risk.onEquity(account.equity, now).drawdownPct;
    }
    const killed = Boolean(this.risk.state().killSwitch);
    const killSwitchTripped = killed && !killedBefore;
    // kill switch 作動中は残っている建玉の決済を試み続ける (初回は即時、以後 killSwitchRetryMs ごと)
    if (killed) exits += await this.killSwitchClose(now, quotes, killSwitchTripped, drawdownPct);

    // 6. ブローカーの建玉との定期的な突き合わせ (外部での決済を反映)
    const reconciled = await this.maybeReconcile(now);
    if (exits > 0 || reconciled) account = await this.account(now, true);

    // 7. 戦略評価とエントリー
    const halted = this.risk.isHalted(now);
    const accountBlock = account.incomplete
      ? { key: "account_unavailable", sample: `口座情報を取得できません (${(account.missing ?? []).join(", ")})` }
      : account.degradedReason
        ? { key: "account_unavailable", sample: account.degradedReason }
        : undefined;
    this.entryPause(now);
    const ctx: TickCtx = {
      now,
      brief: this.store.latestBrief(),
      plan: this.store.latestPlan(),
      halted: halted.halted,
      haltReason: halted.reason,
      account,
      ...(accountBlock ? { entryBlock: accountBlock } : {}),
      timedOut,
      regimes: new Map(),
      intel: new Map(),
      entries,
      exits,
      evaluations: 0,
    };
    for (const inst of insts) {
      const view = this.hub.getView(inst.symbol, now);
      if (!view) continue;
      try {
        await this.processSymbol(inst, view, ctx);
      } catch (e) {
        this.log.error("銘柄の処理に失敗", { symbol: inst.symbol, error: errMsg(e) });
      }
    }

    // 8. 評価額の記録・スナップショット
    if (this.lastEquitySave === undefined || now - this.lastEquitySave >= this.opt.equityEveryMs) {
      // ctx.account はエントリー・決済のたびに取り直している。欠けた評価額は記録しない
      if (!ctx.account.incomplete) this.store.saveEquity({ ts: now, equity: ctx.account.equity, mode: this.mode });
      this.saveSnapshot();
      this.lastEquitySave = now;
    }
    if (this.lastSkipFlush === undefined || now - this.lastSkipFlush >= this.opt.equityEveryMs) this.flushSkips(now);

    this.lastTickAt = now;
    this.tickCount++;
    return { now, equity: ctx.account.equity, entries: ctx.entries, exits: ctx.exits, evaluations: ctx.evaluations, killSwitchTripped };
  }

  /**
   * 損切り・利確などの決済判定。銘柄ごとに失敗を分離し、直近の気配で判定する (poll に失敗した銘柄も含む)。
   * venue (ブローカー) ごとに並列で、同じ venue の中は順番どおり (1 つの venue の遅延が他の venue の損切りを止めない)
   */
  private async manageExits(quotes: Map<string, Quote>, now: number): Promise<number> {
    let exits = 0;
    await runGrouped(this.positions.list(), (p) => this.positions.brokerKey(p.symbol), async (pos) => {
      try {
        const q = quotes.get(pos.symbol) ?? this.hub.latestQuote(pos.symbol);
        if (!q) return;
        const res = await this.positions.onQuote(pos.symbol, q, now);
        if (res.status === "closed" || res.status === "reduced") exits++;
      } catch (e) {
        this.log.error("ポジション管理に失敗", { symbol: pos.symbol, error: errMsg(e) });
      }
    });
    return exits;
  }

  /** kill switch 作動中の全決済。保留中の注文がある銘柄は照会の結果を待つ */
  private async killSwitchClose(now: number, quotes: Map<string, Quote>, isNew: boolean, drawdownPct?: number): Promise<number> {
    if (this.positions.list().length === 0) return 0;
    if (!isNew && this.lastKillCloseAt !== undefined && now - this.lastKillCloseAt < this.opt.killSwitchRetryMs) return 0;
    const first = isNew || this.lastKillCloseAt === undefined;
    this.lastKillCloseAt = now;
    const ks = this.risk.state().killSwitch;
    if (first) this.log.error("キルスイッチ作動: 全ポジションを決済します", { reason: ks?.reason, drawdownPct });
    else this.log.warn("キルスイッチ作動中: 残っているポジションの決済を再試行します", { positions: this.positions.list().length });
    const res = await this.positions.closeAll("kill_switch", now, (s) => quotes.get(s) ?? this.hub.latestQuote(s));
    const closed = res.filter((x) => x.status === "closed" || x.status === "reduced").length;
    const pending = res.filter((x) => x.status === "pending").length;
    this.store.audit({
      ts: now,
      type: "engine.kill_switch_close",
      data: { attempt: first ? "initial" : "retry", closed, pending, failed: res.length - closed - pending },
    });
    return closed;
  }

  /**
   * 追跡を外すまでに不一致を確認する回数。live は 2 回 (照会の一時的な欠落 = 例: デリバティブの照会失敗で現物分だけが返る、
   * と建玉ゼロを区別できないため。迷ったら外さない)。paper は PaperBroker が正なので 1 回
   */
  private reconcileConfirmations(): number {
    return this.mode === "live" ? 2 : 1;
  }

  /** reconcileEveryMs ごとにブローカーの建玉と突き合わせる。journal を変更したら true */
  private async maybeReconcile(now: number): Promise<boolean> {
    if (this.lastReconcileAt !== undefined && now - this.lastReconcileAt < this.opt.reconcileEveryMs) return false;
    this.lastReconcileAt = now;
    if (this.positions.list().length === 0) return false;
    let bp: BrokerPosition[];
    try {
      bp = await this.brokerPositions();
    } catch (e) {
      this.log.warn("建玉の突き合わせに失敗 (次回に再試行)", { error: errMsg(e) });
      return false;
    }
    const r = this.positions.reconcile(bp, now, {
      priceOf: (s) => this.priceOf(s), minAgeMs: this.opt.reconcileMinAgeMs, phase: "periodic", confirmations: this.reconcileConfirmations(),
    });
    if (r.orphaned.length === 0 && r.reduced.length === 0) return false;
    this.saveSnapshot();
    this.acctCache = undefined;
    return true;
  }

  /** 新規エントリーを止める理由 (保有中の銘柄は決済判定を続けるので対象外) */
  private entryBlock(inst: Instrument, ctx: TickCtx): { key: string; sample: string } | undefined {
    const sym = inst.symbol;
    if (this.positions.hasPending(sym)) return { key: "pending_order", sample: `${sym}: 保留中の注文の確定待ち` };
    // 状態不明の注文がある間はエンジン全体の新規エントリーを止める (確定すれば自動で再開)
    const paused = this.entryPause(ctx.now);
    if (paused) return paused;
    if (ctx.entryBlock) return ctx.entryBlock;
    const err = this.hub.lastError(sym);
    if (err) return { key: "poll_failed", sample: `${sym}: ${redactSecrets(err)}` };
    if (ctx.timedOut.has(sym)) return { key: "poll_timeout", sample: `${sym}: 市場データの取得が時間内に終わりませんでした` };
    if (this.mode === "live") {
      // ブローカーに journal で追跡していない建玉がある銘柄には入らない (外部の建玉との不整合を避ける)
      const bp = ctx.account.positions.find((p) => p.symbol === sym && p.qty !== 0);
      if (bp && Math.abs(bp.qty) >= (inst.minQty > 0 ? inst.minQty : 0)) return { key: "untracked_position", sample: `${sym}: 追跡していない建玉 ${bp.qty}` };
    }
    return undefined;
  }

  private skip(key: string, sample?: string): void {
    const s = this.skips.get(key);
    if (s) {
      s.count++;
      if (sample) s.sample = sample;
    } else this.skips.set(key, { count: 1, sample: sample ?? key });
  }

  /** 見送り理由の要約を監査ログへ */
  private flushSkips(now: number): void {
    if (this.skips.size > 0) {
      const summary = Object.fromEntries([...this.skips].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, v]));
      this.store.audit({ ts: now, type: "engine.skip_summary", data: { since: this.lastSkipFlush ?? now, reasons: summary } });
      this.skips.clear();
    }
    this.lastSkipFlush = now;
  }

  private regimeFor(view: MarketView, tf: Timeframe, ctx: TickCtx): RegimeFeatures {
    const key = `${view.instrument.symbol}|${tf}`;
    let r = ctx.regimes.get(key);
    if (!r) {
      r = detectRegime(view.candles[tf] ?? [], view.quote, regimeOptionsFor(view.instrument.assetClass));
      ctx.regimes.set(key, r);
    }
    return r;
  }

  private intelFor(inst: Instrument, ctx: TickCtx): IntelBias | undefined {
    if (!ctx.intel.has(inst.symbol)) {
      const biases = ctx.brief?.biases ?? {};
      ctx.intel.set(inst.symbol, intelBiasFor(inst, biases, this.learning.intelInfluence(inst.assetClass)));
    }
    return ctx.intel.get(inst.symbol);
  }

  private paramsFor(s: Strategy, inst: Instrument): Params {
    return resolveParams(s, this.learning.paramsFor(s.id, inst.assetClass) ?? s.defaultParams);
  }

  /** 新規エントリーの可否 (計画 → 無ければベースライン計画相当)。ブラックアウトも確認する */
  private gate(inst: Instrument, s: Strategy, regime: RegimeFeatures, armWeight: number, ctx: TickCtx): Gate {
    const { now } = ctx;
    const plan = ctx.plan && ctx.plan.validUntil > now ? ctx.plan : undefined;
    const sp = plan?.perSymbol[inst.symbol];
    let blackouts: StrategyPlan["blackouts"];
    let directionBias: Gate["directionBias"];
    let riskMultiplier: number;
    if (plan && sp) {
      if (!sp.enabledStrategies.includes(s.id)) return { ok: false, reason: "plan_disabled", directionBias: "both", riskMultiplier: 0 };
      directionBias = sp.directionBias;
      riskMultiplier = sp.riskMultiplier;
      blackouts = plan.blackouts;
    } else {
      // 計画がまだ無い (期限切れ・計画後に追加した銘柄を含む): レジームに合う戦略をベースライン計画と同じ規則で許可
      const base = buildBaselinePlan({
        brief: ctx.brief ?? emptyBrief(now),
        instruments: [inst],
        regimes: { [inst.symbol]: regime },
        strategies: [s],
        armWeights: { [armKey(s.id, regime.label, inst.assetClass)]: armWeight },
        lessons: [],
        now,
      });
      const bp = base.perSymbol[inst.symbol];
      if (!bp?.enabledStrategies.includes(s.id)) return { ok: false, reason: "baseline_disabled", directionBias: "both", riskMultiplier: 0 };
      directionBias = bp.directionBias;
      riskMultiplier = bp.riskMultiplier;
      blackouts = base.blackouts;
    }
    if (!(riskMultiplier > 0)) return { ok: false, reason: "plan_risk_zero", directionBias, riskMultiplier: 0 };
    if (activeBlackout({ blackouts }, inst.assetClass, now)) return { ok: false, reason: "blackout", directionBias, riskMultiplier };
    return { ok: true, directionBias, riskMultiplier };
  }

  private async processSymbol(inst: Instrument, view: MarketView, ctx: TickCtx): Promise<void> {
    const sym = inst.symbol;
    const pos = this.positions.get(sym);
    if (!pos) {
      const block = this.entryBlock(inst, ctx);
      if (block) return this.skip(block.key, block.sample);
    }
    const candidates: Candidate[] = [];
    for (const s of this.strategies) {
      if (!s.assetClasses.includes(inst.assetClass)) continue;
      // 評価タイミング: 板が必須の戦略は毎ティック、それ以外は主時間足の新しい確定足が出たときだけ
      if (s.requiresBook) {
        if (!view.book) continue;
      } else {
        const c = view.candles[s.primaryTimeframe];
        const last = c && c.length ? c[c.length - 1].ts : undefined;
        if (last === undefined) continue;
        const k = `${sym}|${s.id}`;
        if (this.lastEval.get(k) === last) continue;
        this.lastEval.set(k, last);
      }
      const owner = pos !== undefined && pos.strategyId === s.id ? pos : undefined;
      if (pos && !owner) continue; // 1 銘柄 1 ポジション: 保有中は持ち主の戦略だけ評価 (決済シグナル用)
      if (!pos && ctx.halted) {
        this.skip("halted", ctx.haltReason);
        continue;
      }
      const regime = this.regimeFor(view, s.primaryTimeframe, ctx);
      let gate: Gate | undefined;
      let armWeight = 1;
      if (!pos) {
        armWeight = this.learning.armWeight(s.id, regime.label, inst.assetClass, this.rng);
        gate = this.gate(inst, s, regime, armWeight, ctx);
        if (!gate.ok) {
          this.skip(gate.reason!);
          continue;
        }
      }
      const params = this.paramsFor(s, inst);
      const intel = this.intelFor(inst, ctx);
      const sctx: StrategyContext = {
        market: view,
        regime,
        ...(intel ? { intel } : {}),
        ...(owner ? { position: this.positions.view(owner) } : {}),
        params,
      };
      ctx.evaluations++;
      let signal: Signal | null;
      try {
        signal = s.evaluate(sctx);
      } catch (e) {
        this.log.error("戦略の評価に失敗", { strategyId: s.id, symbol: sym, error: errMsg(e) });
        continue;
      }
      if (!signal) continue;

      if (owner) {
        const opposite = (signal.direction === "long" && owner.direction === "short") || (signal.direction === "short" && owner.direction === "long");
        if (signal.direction === "flat" || opposite) {
          const intended = owner.direction === "long" ? view.quote.bid : view.quote.ask;
          const res = await this.positions.close(sym, "signal", intended, ctx.now);
          if (res.status === "closed" || res.status === "reduced") {
            ctx.exits++;
            ctx.account = await this.account(ctx.now, true);
          }
        }
        continue;
      }
      if (signal.direction === "flat") continue;
      if (gate!.directionBias !== "both" && gate!.directionBias !== signal.direction) {
        this.skip("direction_bias");
        continue;
      }
      if (!(armWeight > 0)) {
        this.skip("arm_disabled");
        continue;
      }
      // 計画のリスク倍率 × 腕の重み (上限は計画と同じ MAX_RISK_MULTIPLIER)
      const riskMultiplier = Math.min(MAX_RISK_MULTIPLIER, gate!.riskMultiplier * armWeight);
      candidates.push({
        strategy: s, signal, regime, params, intel, armWeight, riskMultiplier,
        score: signal.confidence * armWeight * signal.expectedEdgeBps,
      });
    }
    if (pos || candidates.length === 0) return;
    // 同じ銘柄で複数の戦略がシグナルを出したら confidence × 腕の重み × 期待値幅 が最大のもの
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    if (candidates.length > 1) this.skip("lower_score", `${sym}: ${candidates.length} 件中 ${best.strategy.id} を採用`);
    await this.enter(inst, view, best, ctx);
  }

  private async enter(inst: Instrument, view: MarketView, c: Candidate, ctx: TickCtx): Promise<void> {
    const { now } = ctx;
    const q = view.quote;
    const sym = inst.symbol;
    const sig = c.signal;
    if (now - q.ts > this.opt.maxQuoteAgeMs) return this.skip("stale_quote");
    const rate = this.fx.toAccount(inst.quoteCurrency);
    if (!Number.isFinite(rate) || !(rate > 0)) return this.skip("fx_unknown", `${inst.quoteCurrency} → ${this.fx.baseCurrency}`);
    try {
      this.brokerFor(sym); // 発注先が無い銘柄はリスク判定の前に見送る
    } catch (e) {
      return this.skip("no_broker", errMsg(e));
    }
    const liquidityUsd = inst.assetClass === "meme" ? liquidityUsdFor(inst, view, (ccy) => this.fx.toUsd(ccy)) : undefined;
    const acct = ctx.account;
    const decision = this.risk.evaluateEntry({
      signal: sig,
      instrument: inst,
      quote: q,
      equity: acct.equity,
      available: acct.available,
      positions: acct.positions,
      riskMultiplier: c.riskMultiplier,
      now,
      ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
      instruments: new Map(this.hub.watched().map((i) => [i.symbol, i])),
      prices: acct.prices,
      toAccount: (ccy) => this.fx.toAccount(ccy),
    });
    if (!decision.ok) return this.skip(`risk: ${normalizeReason(decision.reason)}`, `${sym} ${c.strategy.id}: ${decision.reason}`);

    const side = sig.direction === "long" ? "buy" : "sell";
    const intended = side === "buy" ? q.ask : q.bid;
    const cost = costBps(inst, q);
    const entryContext: EntryContext = {
      regime: c.regime,
      ...(c.intel ? { intel: c.intel } : {}),
      confidence: sig.confidence,
      expectedEdgeBps: sig.expectedEdgeBps,
      costBps: cost,
      params: { ...c.params },
      features: { ...sig.features },
      riskMultiplier: c.riskMultiplier,
      reason: sig.reason,
    };
    const req: OrderRequest = {
      clientId: this.positions.newClientId("e", now),
      symbol: sym,
      side,
      type: "market",
      qty: decision.qty,
      strategyId: c.strategy.id,
      // 取引所側の保護ストップ (対応するアダプターだけが付ける。プロセス停止時の保険)
      protectiveStop: sig.stopLoss,
    };
    const entry: PendingEntry = {
      input: {
        mode: this.mode,
        symbol: sym,
        venue: inst.venue,
        assetClass: inst.assetClass,
        strategyId: c.strategy.id,
        horizon: sig.horizon,
        direction: sig.direction === "long" ? "long" : "short",
        entryTs: now,
        intendedEntryPrice: intended,
        initialStop: sig.stopLoss,
        ...(sig.takeProfit !== undefined ? { takeProfit: sig.takeProfit } : {}),
        entryContext,
        ...(inst.contractSize !== undefined ? { contractSize: inst.contractSize } : {}),
      },
      plan: {
        ...(sig.trailingStopPct !== undefined ? { trailingStopPct: sig.trailingStopPct } : {}),
        ...(sig.maxHoldMs !== undefined ? { maxHoldMs: sig.maxHoldMs } : {}),
      },
      audit: {
        direction: sig.direction,
        intendedPrice: intended,
        stop: sig.stopLoss,
        ...(sig.takeProfit !== undefined ? { takeProfit: sig.takeProfit } : {}),
        confidence: Number(sig.confidence.toFixed(3)),
        expectedEdgeBps: Number(sig.expectedEdgeBps.toFixed(1)),
        costBps: Number(cost.toFixed(1)),
        armWeight: Number(c.armWeight.toFixed(3)),
        riskMultiplier: Number(c.riskMultiplier.toFixed(3)),
        regime: c.regime.label,
        ...(c.intel ? { intel: { sentiment: Number(c.intel.sentiment.toFixed(3)), confidence: Number(c.intel.confidence.toFixed(3)) } } : {}),
        ...(liquidityUsd !== undefined ? { liquidityUsd: Math.round(liquidityUsd) } : {}),
        reason: sig.reason,
        notes: decision.notes,
      },
    };
    let r: EntryResult;
    try {
      r = await this.positions.enter(req, entry, now);
    } catch (e) {
      const msg = errMsg(e);
      this.log.error("エントリーの処理に失敗", { symbol: sym, error: msg });
      this.store.audit({ ts: now, type: "engine.order_error", data: { symbol: sym, strategyId: c.strategy.id, error: msg } });
      return this.skip("order_error", msg);
    }
    if (r.status === "opened") {
      ctx.entries++;
      this.saveSnapshot();
      ctx.account = await this.account(now, true);
      return;
    }
    if (r.status === "pending") {
      // 保留中のエントリーを想定代金で口座情報に加え、同じティックの後続の銘柄のリスク判定に反映する
      ctx.account = await this.account(now);
      return this.skip("order_pending", `${sym}: ${r.reason ?? "未確定"}`);
    }
    this.acctCache = undefined;
    return this.skip("order_rejected", `${sym}: ${r.reason ?? "rejected"}`);
  }

  /** PaperBroker の snapshot を kv へ (注文結果は直近分だけ残す) */
  saveSnapshot(): void {
    const paper = this.brokerSet.paper;
    if (!paper) return;
    const snap = paper.snapshot();
    const entries = Object.entries(snap.results);
    if (entries.length > this.opt.snapshotResultsKeep) snap.results = Object.fromEntries(entries.slice(-this.opt.snapshotResultsKeep));
    this.store.kvSet(PAPER_SNAPSHOT_KEY, snap);
  }

  // ───────── 情報ループ ─────────

  /** 計画用のレジーム (データ不足の銘柄は含めない = 計画上「レジーム不明」) */
  planRegimes(now: number): Record<string, RegimeFeatures> {
    const out: Record<string, RegimeFeatures> = {};
    const tf = planRegimeTimeframe(this.hubTimeframes());
    for (const inst of this.hub.watched()) {
      const view = this.hub.getView(inst.symbol, now);
      const c = view?.candles[tf];
      if (!view || !c || c.length < MIN_REGIME_BARS) continue;
      out[inst.symbol] = detectRegime(c, view.quote, regimeOptionsFor(inst.assetClass));
    }
    return out;
  }

  private hubTimeframes(): Timeframe[] {
    if (this.timeframes?.length) return this.timeframes;
    const first = this.hub.watched()[0];
    const v = first ? this.hub.getView(first.symbol) : undefined;
    const tfs = v ? (Object.keys(v.candles) as Timeframe[]) : [];
    return tfs.length ? tfs : ["15m", "5m", "1m"];
  }

  async buildPlan(brief: MarketBrief, now: number): Promise<StrategyPlan> {
    const instruments = this.hub.watched();
    const regimes = this.planRegimes(now);
    const armWeights: Record<string, number> = {};
    for (const inst of instruments) {
      const r = regimes[inst.symbol];
      if (!r) continue;
      for (const s of this.strategies) {
        if (!s.assetClasses.includes(inst.assetClass)) continue;
        armWeights[armKey(s.id, r.label, inst.assetClass)] = this.learning.armWeight(s.id, r.label, inst.assetClass, this.rng);
      }
    }
    return buildStrategyPlan({
      brief,
      instruments,
      regimes,
      strategies: [...this.strategies],
      armWeights,
      lessons: this.store.listLessons({ status: "active", limit: 50 }),
      now,
      ...(this.ai ? { ai: this.ai } : {}),
    });
  }

  /** 情報収集 → 計画 → 保存。失敗しても取引は止めない */
  async runIntel(now: number = this.clock.now()): Promise<StrategyPlan | undefined> {
    if (this.intelRunning || this.stopped) return undefined;
    this.intelRunning = true;
    this.lastIntelAt = now;
    const p = this.intelInner(now);
    this.background.add(p);
    try {
      return await p;
    } finally {
      this.background.delete(p);
      this.intelRunning = false;
    }
  }

  private async intelInner(now: number): Promise<StrategyPlan | undefined> {
    try {
      const brief = await this.intel.refresh(now);
      if (this.stopped) return undefined; // 停止後は保存しない (store が閉じられている可能性)
      const plan = await this.buildPlan(brief, now);
      if (this.stopped) return undefined;
      this.store.savePlan(plan);
      const active = Object.values(plan.perSymbol).filter((p) => p.enabledStrategies.length > 0).length;
      this.store.audit({ ts: now, type: "engine.plan", data: { activeSymbols: active, blackouts: plan.blackouts.length, riskOn: brief.riskOn, stubBrief: brief.stub } });
      if (this.config.env.AUTO_MEME_WATCH) await this.autoMemeWatch(brief, now);
      return plan;
    } catch (e) {
      const msg = errMsg(e);
      this.log.warn("情報ループに失敗 (取引は継続)", { error: msg });
      if (!this.stopped) this.store.audit({ ts: now, type: "engine.intel_error", data: { error: msg } });
      return undefined;
    }
  }

  // ───────── 学習ループ ─────────

  async runLearning(now: number = this.clock.now()): Promise<PeriodicResult | undefined> {
    if (this.learnRunning || this.stopped) return undefined;
    this.learnRunning = true;
    this.lastLearnAt = now;
    const p = this.learningInner(now);
    this.background.add(p);
    try {
      return await p;
    } finally {
      this.background.delete(p);
      this.learnRunning = false;
    }
  }

  private async learningInner(now: number): Promise<PeriodicResult | undefined> {
    try {
      const r = await this.learning.periodic(now);
      if (r.adjustments.length || r.reverted.length || r.reflection?.lessons.length || r.postExitFilled) {
        this.store.audit({
          ts: now,
          type: "engine.learning",
          data: {
            postExitFilled: r.postExitFilled,
            adjustments: r.adjustments.map((a) => `${a.strategyId}/${a.assetClass} ${a.param} ${a.from}→${a.to} ${a.status}`),
            reverted: r.reverted.map((a) => `${a.strategyId}/${a.assetClass} ${a.param}`),
            lessons: r.reflection?.lessons.length ?? 0,
          },
        });
      }
      return r;
    } catch (e) {
      const msg = errMsg(e);
      this.log.warn("学習ループに失敗 (取引は継続)", { error: msg });
      if (!this.stopped) this.store.audit({ ts: now, type: "engine.learning_error", data: { error: msg } });
      return undefined;
    }
  }

  // ───────── 自動ミーム監視 (AUTO_MEME_WATCH) ─────────

  private watchInstrument(inst: Instrument): boolean {
    if (this.hub.instrument(inst.symbol)) return false;
    this.hub.watch(inst, this.dexFeed);
    this.brokerSet.paper?.addInstrument(inst);
    return true;
  }

  private async restoreAutoMeme(): Promise<void> {
    for (const key of this.store.kvGet<string[]>(AUTO_MEME_KEY) ?? []) {
      const [chainId, pairAddress] = key.split(":");
      try {
        this.watchInstrument(await this.dexFeed!.trackPair(chainId, pairAddress));
      } catch (e) {
        this.log.warn("自動監視ミームの復元に失敗", { key, error: errMsg(e) });
      }
    }
  }

  /** DexScreener のトレンドから条件を満たすミームを最大 autoMemeMax 件まで監視に追加 */
  async autoMemeWatch(brief: MarketBrief, now: number): Promise<string[]> {
    if (!this.dexFeed) return [];
    const added = this.store.kvGet<string[]>(AUTO_MEME_KEY) ?? [];
    if (added.length >= this.opt.autoMemeMax) return [];
    const items = this.store.listIntel({ since: now - 6 * 3_600_000, kinds: ["trending"], limit: 1000 });
    const cands = selectAutoMemeCandidates(items, {
      minLiquidityUsd: this.config.risk.memeMinLiquidityUsd,
      watchlist: brief.watchlist,
      exclude: new Set(added),
      max: this.opt.autoMemeMax - added.length,
      source: DEX_SOURCE,
    });
    const symbols: string[] = [];
    for (const c of cands) {
      try {
        const inst = await this.dexFeed.trackPair(c.chainId, c.pairAddress);
        added.push(c.key);
        if (!this.watchInstrument(inst)) continue;
        symbols.push(inst.symbol);
        this.store.audit({ ts: now, type: "engine.auto_meme_watch", data: { ...c, symbol: inst.symbol, trendingSymbol: c.symbol } });
      } catch (e) {
        this.log.warn("ミームの自動監視に失敗", { key: c.key, error: errMsg(e) });
      }
    }
    this.store.kvSet(AUTO_MEME_KEY, added);
    return symbols;
  }

  // ───────── シミュレーション・実時間ループ ─────────

  /** シミュレーション用: tick に加えて、期限が来た情報ループ・学習ループを順に実行する */
  async advance(now: number): Promise<TickResult> {
    const r = await this.tick(now);
    if (this.lastIntelAt === undefined || now - this.lastIntelAt >= this.opt.intelEveryMs) await this.runIntel(now);
    if (this.lastLearnAt === undefined) this.lastLearnAt = now;
    else if (now - this.lastLearnAt >= this.opt.learnEveryMs) await this.runLearning(now);
    return r;
  }

  private async safeTick(): Promise<void> {
    if (this.inflight) return; // 前のティックが終わっていなければ飛ばす
    try {
      await this.tick(this.clock.now());
    } catch (e) {
      this.log.error("ティックの処理に失敗", { error: errMsg(e) });
    }
  }

  get running(): boolean {
    return this.timers.length > 0;
  }

  /** 実時間で起動。最初のティックの後に情報ループを 1 回 (非同期) 実行する */
  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    // エンジン停止中に書かれた古い再開要求は捨てる (起動後に作動した停止を意図せず解除しない)。
    // 消すのは自分の mode 宛ての要求だけ (mode の無い古い要求は paper 宛て)。別の mode で動作中のエンジン宛ての要求は残す
    const staleResume = peekResumeRequest(this.store);
    if (staleResume && (staleResume.mode ?? "paper") === this.mode) clearResumeRequest(this.store);
    await this.init();
    await this.safeTick();
    void this.runIntel(this.clock.now());
    this.lastLearnAt = this.clock.now();
    this.timers.push(setInterval(() => void this.safeTick(), this.opt.tickMs));
    this.timers.push(setInterval(() => void this.runIntel(this.clock.now()), this.opt.intelEveryMs));
    this.timers.push(setInterval(() => void this.runLearning(this.clock.now()), this.opt.learnEveryMs));
  }

  /**
   * ループを止め、実行中のティック (と情報・学習ループ。最大 waitMs) を待ってから snapshot と評価額を保存する。
   * 保有中のポジションは決済しない。
   */
  async stop(opts: { waitMs?: number } = {}): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.inflight) await this.inflight.catch(() => undefined);
    if (this.background.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.background]),
        new Promise((r) => (timer = setTimeout(r, opts.waitMs ?? 15_000))),
      ]);
      if (timer) clearTimeout(timer);
    }
    this.stopped = true;
    const now = this.clock.now();
    try {
      const acct = await this.account(now, true);
      if (!acct.incomplete) this.store.saveEquity({ ts: now, equity: acct.equity, mode: this.mode });
    } catch (e) {
      this.log.warn("停止時の評価額の保存に失敗", { error: errMsg(e) });
    }
    this.saveSnapshot();
    this.flushSkips(now);
    this.store.audit({ ts: now, type: "engine.stop", data: { openPositions: this.journal.list().length, pendingOrders: this.positions.pending.size } });
  }

  // ───────── 状態 (ダッシュボード) ─────────

  async status(): Promise<EngineStatus> {
    const now = this.clock.now();
    const acct = await this.account(now);
    const rs = this.risk.state();
    const halted = this.risk.isHalted(now);
    const paperM = this.brokerSet.paper?.markToMarket();
    const positions: PositionStatus[] = this.positions.list().map((p) => {
      const inst = this.hub.instrument(p.symbol);
      const q = this.hub.latestQuote(p.symbol);
      const last = q ? midOf(q) : p.lastPrice;
      const dir = p.direction === "long" ? 1 : -1;
      const upnl = D(last).minus(p.entryPrice).mul(p.qty).mul(p.contractSize).mul(dir);
      const ccy = inst?.quoteCurrency ?? "";
      const rate = ccy ? this.fx.toAccount(ccy) : NaN;
      return {
        id: p.id,
        symbol: p.symbol,
        strategyId: p.strategyId,
        direction: p.direction,
        qty: p.qty,
        entryPrice: p.entryPrice,
        entryTs: p.entryTs,
        lastPrice: last,
        stop: this.positions.currentStop(p),
        ...(p.takeProfit !== undefined ? { takeProfit: p.takeProfit } : {}),
        unrealizedPnl: upnl.toNumber(),
        ...(Number.isFinite(rate) ? { unrealizedPnlAccount: upnl.mul(rate).toNumber() } : {}),
        quoteCurrency: ccy,
      };
    });
    const plan = this.store.latestPlan();
    const brief = this.store.latestBrief();
    const eq = this.store.listEquity({ since: now - 7 * 86_400_000, mode: this.mode });
    return {
      now,
      mode: this.mode,
      ...(this.config.liveBlockedReason ? { liveBlockedReason: this.config.liveBlockedReason } : {}),
      baseCurrency: this.config.env.BASE_CURRENCY,
      watched: this.hub.watched().map((i) => ({
        symbol: i.symbol, venue: i.venue, assetClass: i.assetClass,
        ...(this.hub.lastError(i.symbol) ? { lastError: redactSecrets(this.hub.lastError(i.symbol)!) } : {}),
      })),
      equity: {
        current: acct.equity,
        initial: this.mode === "paper" ? this.config.env.PAPER_INITIAL_EQUITY : (eq[0]?.equity ?? acct.equity),
        available: acct.available,
        ...(paperM ? { cash: paperM.cash, realized: paperM.realized, unrealized: paperM.unrealized } : {}),
      },
      risk: {
        halted: halted.halted,
        ...(halted.reason ? { reason: halted.reason } : {}),
        ...(rs.killSwitch ? { killSwitch: rs.killSwitch } : {}),
        ...(rs.haltedUntil !== undefined ? { haltedUntil: rs.haltedUntil } : {}),
        ...(this.entriesPaused ? { entriesPaused: { since: this.entriesPaused.since, orders: [...this.entriesPaused.clientIds] } } : {}),
        peakEquity: rs.peakEquity,
        dayStartEquity: rs.dayStartEquity,
        limits: this.config.risk,
      },
      positions,
      pendingOrders: this.positions.pendingOrders().map((o) => ({
        symbol: o.symbol,
        kind: o.kind,
        clientId: o.clientId,
        ...(o.orderId ? { orderId: o.orderId } : {}),
        status: o.status,
        createdAt: o.createdAt,
        unknownCount: o.unknownCount,
        ...(o.lastError ? { lastError: redactSecrets(o.lastError) } : {}),
        ...(o.escalated ? { escalated: true } : {}),
      })),
      ...(plan
        ? {
            plan: {
              generatedAt: plan.generatedAt,
              validUntil: plan.validUntil,
              rationale: plan.rationale,
              symbols: Object.values(plan.perSymbol).map((s) => ({
                symbol: s.symbol, enabledStrategies: s.enabledStrategies, directionBias: s.directionBias,
                riskMultiplier: Number(s.riskMultiplier.toFixed(3)), ...(s.notes ? { notes: s.notes } : {}),
              })),
              blackouts: plan.blackouts,
            },
          }
        : {}),
      ...(brief
        ? {
            brief: {
              generatedAt: brief.generatedAt,
              riskOn: brief.riskOn,
              summary: brief.summary,
              stub: brief.stub,
              watchlist: brief.watchlist,
              biases: Object.values(brief.biases)
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, 10)
                .map((b) => ({ asset: b.asset, sentiment: b.sentiment, confidence: b.confidence, eventRisk: b.eventRisk })),
              events: brief.events
                .filter((e) => e.ts >= now - 3_600_000)
                .sort((a, b) => a.ts - b.ts)
                .slice(0, 10)
                .map((e) => ({ ts: e.ts, title: e.title, ...(e.currency ? { currency: e.currency } : {}), impact: e.impact })),
            },
          }
        : {}),
      equityHistory: downsample(eq.map((p) => ({ ts: p.ts, equity: p.equity })), 300),
      ...(this.lastTickAt !== undefined ? { lastTickAt: this.lastTickAt } : {}),
      tickCount: this.tickCount,
    };
  }
}
