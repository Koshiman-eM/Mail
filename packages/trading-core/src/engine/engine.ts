import { enabledProfile } from "../core/assetClasses";
import type { MarketCalendar } from "../core/calendar";
import type { AiOptions } from "../core/ai";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES, type AppConfig } from "../core/config";
import { equitySinceReset, latestPaperReset } from "../paper/walletReset";
import { D, Decimal } from "../core/decimal";
import { redactedErrMsg, redactSecrets } from "../core/http";
import { createLogger, type Logger } from "../core/logger";
import { DEFAULT_SHORT_BORROW_RATE_DAILY, isSimulatedShort } from "../core/short";
import {
  systemClock, type Balance, type Broker, type BrokerPosition, type Clock, type EntryContext, type Instrument, type IntelBias, type MarketBrief,
  type IntelItem, type MarketDataFeed, type MarketView, type OrderRequest, type Params, type Quote, type RegimeFeatures, type Signal, type Store, type Strategy,
  type ShadowTradeRecord, type StrategyContext, type StrategyPlan, type Timeframe, type TradeRecord, TIMEFRAME_MS, isLearningExcludedTrade,
} from "../core/types";
import type { BrokerSet } from "../execution/brokerSet";
import type { PaperSnapshot } from "../execution/paper";
import type { IntelService } from "../intel/service";
import { biasForInstrument, buildBaselinePlan, buildStrategyPlan, MAX_RISK_MULTIPLIER } from "../intel/planner";
import { estimateSentiment } from "../intel/sentiment";
import { atrLast } from "../indicators/series";
import { armKey } from "../learning/allocator";
import { ForecastTracker, type ForecastOptions, type ForecastStatusView } from "../learning/forecast";
import type { OpenTrade, PriceAt } from "../learning/journal";
import type { NewsMarketInfo } from "../learning/newsCheck";
import { ShadowTracker, type PriceRange, type ShadowOptions } from "../learning/shadow";
import { TradeJournal } from "../learning/journal";
import type { LearningService, PeriodicResult } from "../learning/service";
import type { MarketHub } from "../market/hub";
import { detectRegime, regimeOptionsFor } from "../regime/detect";
import { clearResumeRequest, peekResumeRequest } from "../risk/resumeRequest";
import { costBps, type RiskManager, type RiskPosition } from "../risk/manager";
import { ALL_STRATEGIES, resolveParams } from "../strategies/registry";
import { RETIRED_STRATEGIES } from "../strategies/retired";
import {
  activeBlackout, emptyBrief, intelBiasFor, liquidityUsdFor, normalizeReason, planRegimeTimeframe,
} from "./context";
import { runGrouped, withDeadline } from "./deadline";
import { createFxConverter, fxApproxReason, normalizeCurrency, type FxConverter } from "./fx";
import { createPriceAt, priceFromCandles } from "./learningHooks";
import {
  peekResolveRequests, readLimitStats, removeResolveRequests, type LimitCancelReason, type LimitStats, type PendingEntry, type PendingLimit, type PendingOrder,
  type PendingStatus,
} from "./orders";
import { DEFAULT_ORDER_POLICY, PositionManager, type EntryResult, type OrderPolicy, type SyncResult, type ThesisView } from "./positions";
import { clampMaxHoldMs, isHoldLimitedHorizon, TempoController, tempoSeedTimestamps, tempoStatusView, type TempoStatusView } from "./tempo";
import { thesisSettingsFromEnv, type ThesisSettings } from "./thesis";
import {
  checkReversal, reversalAppliesTo, reversalDetailLabel, reversalSettingsFromEnv, reversalTimeframeFor, type ReversalSettings,
} from "./reversalExit";
import { effectiveLimitTakeProfit } from "./limitOrders";
import { quoteMid } from "../core/util";

export const PAPER_SNAPSHOT_KEY = "paper:snapshot";
/** レジーム判定に必要な最低本数 (未満なら「レジーム不明」) */
const MIN_REGIME_BARS = 30;

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
  /**
   * 見送ったシグナルの答え合わせ (仮想トレード)。enabled: false で無効。
   * 実際の発注・リスク判定・建玉管理には影響しない
   */
  shadow?: Partial<ShadowOptions> & { enabled?: boolean };
  /** ニュースと値動きの答え合わせの判定間隔 (既定 60 秒) */
  newsEvalEveryMs?: number;
  /**
   * 銘柄ごとの値動きの予想と答え合わせ。enabled: false で無効。
   * 実力が統計的に確かめられた (予想時間, 資産クラス) だけ、新規エントリーのリスク倍率に 0.7〜1.2 倍を掛ける
   * (RiskManager の上限は変えない)
   */
  forecast?: Partial<ForecastOptions> & { enabled?: boolean };
}

/** 予想に使うブリーフの鮮度の上限 (これより古いブリーフのバイアスは使わない) */
const FORECAST_BRIEF_MAX_AGE_MS = 6 * 3_600_000;
/** 戦略の合意に使うシグナルを覚えておく時間・件数 */
const SIGNAL_MEMORY_MS = 3_600_000;
const SIGNAL_MEMORY_MAX = 50;

/** 定期の処理 (USD/JPY のレートの取り直し・Jupiter の自動探索・トークン情報の取り直しなど)。失敗しても取引は止めない */
export interface PeriodicTask {
  name: string;
  everyMs: number;
  run(now: number): Promise<unknown>;
}

/**
 * 取引先ごとの追加の情報 (Jupiter)。無い・undefined を返した銘柄は従来どおり
 * - liquidityUsd: 資産クラス meme の流動性 (USD)。値を持つ取引先の銘柄はこれを使い、出来高からの推定は使わない (undefined なら拒否)
 * - entryBlock: 新規エントリーを止める理由 (自動追加の銘柄が選別に落ちた等。保有中の建玉の管理は続ける)
 */
export interface MarketExtras {
  /** この取引先の銘柄に liquidityUsd を使う */
  venues: readonly string[];
  liquidityUsd(symbol: string): number | undefined;
  /** 予定の約定代金 (クオート通貨建て) での往復コスト (bps)。RiskManager がサイズを決めた後の判定に使う (EntryParams.costBpsAt) */
  costBpsAt?(symbol: string, notionalQuote: number): number | undefined;
  entryBlock?(symbol: string): string | undefined;
}

export interface EngineDeps {
  config: AppConfig;
  store: Store;
  hub: MarketHub;
  brokerSet: BrokerSet;
  risk: RiskManager;
  /** lastItems があれば、分析済みの情報をニュースと値動きの答え合わせに使う (無ければ store の情報) */
  intel: Pick<IntelService, "refresh"> & Partial<Pick<IntelService, "lastItems">>;
  learning: LearningService;
  strategies?: readonly Strategy[];
  clock?: Clock;
  ai?: AiOptions;
  logger?: Logger;
  journal?: TradeJournal;
  fx?: FxConverter;
  /** 腕の探索に使う乱数 (シミュレーションでは固定シード) */
  rng?: () => number;
  /** hub が保持する時間足 (計画用レジームの時間足を選ぶのに使う) */
  timeframes?: Timeframe[];
  options?: EngineOptions;
  /** 定期の処理 (start でタイマー、advance で期限が来たら実行) */
  periodic?: PeriodicTask[];
  /** 取引先ごとの追加の情報 (Jupiter の流動性・選別に落ちた銘柄) */
  marketExtras?: MarketExtras;
  /**
   * 取引時間のカレンダー (src/core/calendar.ts)。閉まっている間は新規エントリーをしない (見送り market_closed)・
   * テンポの経過時間を進めない。省略時は常に開いている (暗号資産。従来どおり)。決済は従来どおり
   */
  calendar?: MarketCalendar;
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
  /**
   * journal で追跡中だが、ブローカーの建玉一覧に無い (または数量が少ない) ポジションの件数
   * (約定直後で一覧の反映が遅れている分。差分を想定代金で positions に加え、available から引いた)
   */
  trackedUnreported?: number;
  /** live: 口座通貨への換算に概算表・古い気配を使った通貨 (理由付き) */
  fxApprox?: string[];
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
  /** 取引時間外 (カレンダー) で新規エントリーをしない */
  marketClosed?: boolean;
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
  /**
   * テンポ (TARGET_ENTRIES_PER_HOUR > 0 のときだけ。ティックの初めに 1 回計算する)。
   * level: 0〜1、explore: 探索を許すか (paper、または TEMPO_ALLOW_LIVE_EXPLORE)。無効なら undefined (従来どおり)
   */
  tempo?: { level: number; explore: boolean };
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
  /** 読みの管理の状態 (読みの管理を使う建玉だけ。src/engine/positions.ts の ThesisView) */
  thesis?: ThesisView;
}

export interface EngineStatus {
  now: number;
  mode: "paper" | "live";
  liveBlockedReason?: string;
  baseCurrency: string;
  /** lastPrice: 最新の気配の仲値 (気配が無ければ省略)。forecast: 最新の値動きの予想 (無ければ省略) */
  watched: { symbol: string; venue: string; assetClass: string; lastPrice?: number; lastError?: string; forecast?: ForecastStatusView }[];
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
    biases: { asset: string; sentiment: number; confidence: number; eventRisk: number; blackoutUntil?: number }[];
    events: { ts: number; title: string; currency?: string; impact: string }[];
  } & BriefHeadlines;
  equityHistory: { ts: number; equity: number }[];
  lastTickAt?: number;
  tickCount: number;
  /** ループ間隔 (ms)。ダッシュボードが更新停止の判定に使う */
  tickMs: number;
  /**
   * 口座取得の劣化。incomplete / missing: 一度も取得できていない (または換算できない) ブローカー /
   * degradedReason: 取得の失敗が続いている (新規エントリー停止) / fxApprox: live で概算レート・古い為替を使っている通貨
   */
  account: { incomplete?: boolean; missing?: string[]; degradedReason?: string; fxApprox?: string[] };
  /**
   * エントリー頻度の目標 (テンポ)。enabled: TARGET_ENTRIES_PER_HOUR > 0 / target: 目標 (回/時) /
   * entriesInWindow: 直近 1 時間のエントリー数 / tempo: 0〜1 / capped: 上限に到達して新規を止めている /
   * minutesSinceLastEntry: 最後のエントリーからの経過 (分。無ければ null) / exploreAllowed: 探索を許すか
   */
  tempo?: TempoStatusView;
  /** 新規エントリーの最大保有時間 (分。0 = 無効。MAX_HOLD_MINUTES。読みの管理が有効なら読みの期限の上限) */
  maxHoldMinutes?: number;
  /** 読みの管理の設定 (THESIS_*) */
  thesis?: ThesisSettings;
  /** 転換で決済の設定 (REVERSAL_*) */
  reversal?: ReversalSettings;
  /** 指値 (maker) の利用状況: 設定・約定率の集計・待っている指値のエントリー・板に置いた利確の指値 */
  limitOrders?: {
    limitEntry: boolean;
    limitTakeProfit: boolean;
    stats: LimitStats;
    pendingEntries: { symbol: string; clientId: string; price: number; expiresAt: number; cancelReason?: LimitCancelReason }[];
    restingTakeProfits: { symbol: string; tradeId: string; price: number; qty: string; filledQty: string; status: string; exiting?: string }[];
  };
}

/** ダッシュボード用: 直近の情報 (ブリーフの集計対象期間) の件数と見出し */
export interface BriefHeadlines {
  /** 情報の件数 */
  itemCount: number;
  /** 件数の強気・弱気の内訳 (sentiment が ±0.15 を超えるもの。未分析はキーワード辞書で推定) */
  itemTone: { bull: number; bear: number; neutral: number };
  /** 新しい順の見出し (最大 30 件。伏せ字処理済み、各 100 文字まで) */
  items: { title: string; source: string; sentiment?: number }[];
}

/** 文字列を伏せ字処理してから max 文字 (コードポイント) に切り詰める */
const clipText = (s: string, max: number) => {
  const cps = Array.from(redactSecrets(s).replace(/\s+/g, " ").trim());
  return cps.length > max ? cps.slice(0, max - 1).join("") + "…" : cps.join("");
};

/** 見出しの sentiment (指標・カレンダーは本文の感情を持たないので undefined) */
const headlineSentiment = (it: IntelItem): number | undefined => {
  if (typeof it.sentiment === "number" && Number.isFinite(it.sentiment)) return it.sentiment;
  if (it.kind === "metric" || it.kind === "calendar") return undefined;
  return estimateSentiment(`${it.title} ${it.summary ?? ""}`).sentiment;
};

/** 情報の一覧 → 件数・強気弱気の内訳・新しい順の見出し (純粋関数) */
export function briefHeadlines(items: IntelItem[], opts: { limit?: number; maxLen?: number } = {}): BriefHeadlines {
  const limit = opts.limit ?? 30;
  const maxLen = opts.maxLen ?? 100;
  const tone = { bull: 0, bear: 0, neutral: 0 };
  const scored = items.map((it) => ({ it, s: headlineSentiment(it) }));
  for (const { s } of scored) {
    if (s !== undefined && s > 0.15) tone.bull++;
    else if (s !== undefined && s < -0.15) tone.bear++;
    else tone.neutral++;
  }
  return {
    itemCount: items.length,
    itemTone: tone,
    items: scored
      .slice()
      .sort((a, b) => b.it.publishedAt - a.it.publishedAt)
      .slice(0, Math.max(0, limit))
      .map(({ it, s }) => ({
        title: clipText(it.title, maxLen),
        source: clipText(it.source, 40),
        ...(s !== undefined ? { sentiment: Math.round(s * 1000) / 1000 } : {}),
      })),
  };
}

/** ブリーフの集計対象期間 (IntelService の既定と同じ 24 時間) */
const BRIEF_LOOKBACK_MS = 24 * 3_600_000;

/** 等間隔に間引く (先頭と末尾は残す) */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max || max < 2) return arr.slice();
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * 売買エンジン。依存はすべて注入する。
 * tick(now) は 1 回分の処理で、テスト・シミュレーションから直接呼べる。start()/stop() は実時間のループ。
 */
/** 見送り理由の実例 (sample) の最大文字数 */
const SKIP_SAMPLE_MAX = 160;

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
  private readonly intel: EngineDeps["intel"];
  /** 見送ったシグナルの仮想トレード (無効なら undefined) */
  readonly shadow?: ShadowTracker;
  /** 値動きの予想 (無効なら undefined) */
  readonly forecast?: ForecastTracker;
  private lastForecastAt?: number;
  /** 銘柄ごとの直近の戦略シグナル (戦略の合意の特徴量に使う。メモリのみ) */
  private readonly recentSignals = new Map<string, { ts: number; dir: 1 | -1; conf: number }[]>();
  private readonly priceAt: PriceAt;
  private readonly newsEvalEveryMs: number;
  private lastNewsEvalAt?: number;
  private readonly ai?: AiOptions;
  private readonly log: Logger;
  private readonly rng: () => number;
  private readonly timeframes?: Timeframe[];
  /** 観測専用の戦略 id (OBSERVE_ONLY_STRATEGIES)。新規エントリーは発注せず仮想トレード (reason "observe_only") としてだけ記録する */
  private readonly observeOnly: ReadonlySet<string>;
  /** エントリー頻度の目標 (TARGET_ENTRIES_PER_HOUR > 0 のときだけ)。無ければテンポのモードではない (従来どおり) */
  readonly tempo?: TempoController;
  /** 探索を許すか (paper、または live で TEMPO_ALLOW_LIVE_EXPLORE=true)。テンポのモードのときだけ意味を持つ */
  private readonly tempoExploreAllowed: boolean;
  /** 探索のエントリーのサイズの倍率 (TEMPO_EXPLORE_SIZE) */
  private readonly tempoExploreSize: number;
  /** 新規エントリーの最大保有時間 (ms。MAX_HOLD_MINUTES > 0 のときだけ) */
  private readonly maxHoldMs?: number;
  /** 読みの管理 (THESIS_*。手組みの設定 (テスト) で未設定の項目は config の既定値) */
  readonly thesis: ThesisSettings;
  /** 転換で決済 (REVERSAL_*。手組みの設定 (テスト) で未設定の項目は config の既定値) */
  readonly reversal: ReversalSettings;
  /** 建玉 (trade id) ごとに、転換で決済を最後に判定した確定足の開始時刻 (確定足ごとに 1 回だけ判定する。メモリのみ) */
  private readonly reversalEvalAt = new Map<string, number>();
  /** 足がエントリーより新しくて転換で決済を判定できなかった建玉 (監査ログを 1 回だけ残す) */
  private readonly reversalNoHistory = new Set<string>();
  private readonly opt: Required<Omit<EngineOptions, "tickMs" | "intelEveryMs" | "learnEveryMs" | "shadow" | "newsEvalEveryMs" | "forecast">> & {
    tickMs: number;
    intelEveryMs: number;
    learnEveryMs: number;
  };

  /** 銘柄×戦略ごとに最後に評価した主時間足の確定足の時刻 */
  private readonly lastEval = new Map<string, number>();
  /**
   * direction_bias で止めた仮想トレードのエントリー時の情報バイアス (戦略へ渡すものと同じ補正後の sentiment)。
   * キーは仮想トレードの重複判定と同じ 銘柄|戦略|方向 (同時に 1 件だけ)。決済時に情報の効き具合の更新へ渡す。
   * 再起動をまたぐため kv shadowIntel:<mode> に保存する (遅延読み込み)
   */
  private shadowIntel?: Record<string, { ts: number; s: number }>;
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
  /** ダッシュボード用の見出し (ブリーフが変わるまで再計算しない) */
  private headlineCache?: { key: number; value: BriefHeadlines };
  private readonly periodic: PeriodicTask[];
  private readonly periodicAt = new Map<string, number>();
  private readonly periodicRunning = new Set<string>();
  private readonly marketExtras?: MarketExtras;
  private readonly calendar?: MarketCalendar;

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
    this.timeframes = deps.timeframes;
    this.periodic = deps.periodic ?? [];
    this.marketExtras = deps.marketExtras;
    this.calendar = deps.calendar;
    // 手組みの設定 (テスト) で未設定なら config の既定値と同じ扱い
    this.observeOnly = new Set(deps.config.env.OBSERVE_ONLY_STRATEGIES ?? DEFAULT_OBSERVE_ONLY_STRATEGIES.split(","));
    const env = deps.config.env;
    // テンポと最大保有 (手組みの設定 (テスト) で未設定なら無効 = 従来どおり)
    const target = env.TARGET_ENTRIES_PER_HOUR ?? 0;
    if (Number.isFinite(target) && target > 0) this.tempo = new TempoController({ targetPerHour: target, capMultiplier: env.TEMPO_CAP_MULTIPLIER ?? 2, ...(deps.calendar ? { calendar: deps.calendar } : {}) });
    this.tempoExploreAllowed = deps.brokerSet.mode === "paper" || env.TEMPO_ALLOW_LIVE_EXPLORE === true;
    const ex = env.TEMPO_EXPLORE_SIZE;
    this.tempoExploreSize = ex !== undefined && Number.isFinite(ex) && ex > 0 && ex <= 1 ? ex : 0.5;
    const mh = env.MAX_HOLD_MINUTES ?? 0;
    if (Number.isFinite(mh) && mh > 0) this.maxHoldMs = Math.round(mh * 60_000);
    this.thesis = thesisSettingsFromEnv(env);
    this.reversal = reversalSettingsFromEnv(env);
    const o = deps.options ?? {};
    this.opt = {
      equityEveryMs: o.equityEveryMs ?? 60_000,
      maxQuoteAgeMs: o.maxQuoteAgeMs ?? 30_000,
      tickMs: o.tickMs ?? env.SCALP_LOOP_MS,
      intelEveryMs: o.intelEveryMs ?? env.INTEL_LOOP_MS,
      learnEveryMs: o.learnEveryMs ?? env.LEARN_LOOP_MS,
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
      // 新しいポジションの登録はすべてここに来る (成行・指値の約定、一部約定、照会・手動の確定)。テンポのエントリーとして数える
      onOpened: (_p, now) => this.tempo?.recordEntry(now),
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
      // 利確の指値の板置きは paper 専用 (live では LIMIT_TAKE_PROFIT=true でも置かない。起動時に警告する)。
      // 手組みの設定 (テスト) で未設定なら config の既定値 (false) と同じ扱い
      limitTakeProfit: effectiveLimitTakeProfit(env, deps.brokerSet.mode),
      // 読みの管理: 期限で答え合わせをして決済・延長する (無効なら従来の時間切れ)
      thesis: this.thesis,
    });
    const { enabled: shadowEnabled, ...shadowOpts } = o.shadow ?? {};
    if (shadowEnabled !== false) {
      this.shadow = new ShadowTracker({
        store: deps.store,
        mode: deps.brokerSet.mode,
        // 仮想トレードも実際の建玉と同じ読みの管理・転換で決済で決済する (腕の学習をそろえるため)
        // 保有コストのモデル (shadow.holdingCost。省略時は再現の空売りの借入コストだけ) には実際の発注先の mode を渡す
        options: { thesis: this.thesis, reversal: this.reversal, holdingCostMode: deps.brokerSet.mode, ...shadowOpts },
        onClosed: (t) => this.onShadowClosed(t),
        onError: (where, e) => this.warnThrottled(where, this.clock.now(), "仮想トレードの処理に失敗 (取引は継続)", { error: redactedErrMsg(e) }),
      });
    }
    this.priceAt = createPriceAt(this.hub, this.clock);
    this.newsEvalEveryMs = o.newsEvalEveryMs ?? 60_000;
    const { enabled: forecastEnabled, ...forecastOpts } = o.forecast ?? {};
    if (forecastEnabled !== false) {
      this.forecast = new ForecastTracker({ store: deps.store, mode: deps.brokerSet.mode, options: forecastOpts });
      this.learning.attachForecast?.(this.forecast);
    }
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
        this.log.error("手動の解消要求の適用に失敗", { clientId: r.clientId, error: redactedErrMsg(e) });
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
    return q && q.bid > 0 && q.ask > 0 ? quoteMid(q) : undefined;
  }

  private onTradeClosed(t: TradeRecord): void {
    try {
      this.learning.onTradeClosed(t);
    } catch (e) {
      this.log.error("学習への反映に失敗", { tradeId: t.id, error: redactedErrMsg(e) });
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
        this.log.warn("ペーパー口座の復元に失敗", { error: redactedErrMsg(e) });
      }
    }
    if (this.mode === "live" && this.config.env.LIMIT_TAKE_PROFIT === true) {
      // 利確の指値の板置きは paper 専用。live では設定を無視する (起動ごとに 1 回だけ警告し、監査ログに残す)
      this.log.warn("LIMIT_TAKE_PROFIT=true は live では無視します (利確の指値は板に置かず、エンジン側の成行で利確します)。paper 専用の設定です");
      this.store.audit({ ts: now, type: "limit.tp_live_ignored", data: { mode: this.mode, LIMIT_TAKE_PROFIT: true } });
    }
    // エンジン停止中に書かれた解消の要求 (CLI `orders resolve`) を適用する
    await this.applyResolveRequests(now);
    // 板に置いた利確の指値の約定を先に反映する (建玉の突き合わせで外部の決済と誤認しない)
    try {
      await this.positions.pollAllTakeProfits(now);
    } catch (e) {
      this.log.warn("利確の指値の照会に失敗", { error: redactedErrMsg(e) });
    }
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
      this.log.warn("建玉の突き合わせに失敗", { error: redactedErrMsg(e) });
    }
    // 追跡していない建玉の利確の指値 (孤児) を取り消す
    try {
      const n = await this.positions.sweepTakeProfits(now);
      if (n > 0) this.log.warn("追跡していない建玉の利確の指値を取り消しました", { count: n });
    } catch (e) {
      this.log.warn("利確の指値の整理に失敗", { error: redactedErrMsg(e) });
    }
    const tps = this.positions.restingTakeProfits();
    if (tps.length) this.log.info("板に置いた利確の指値を引き継ぎます", { orders: tps.map((t) => `${t.symbol} ${t.price} ${t.clientId}`) });
    this.lastReconcileAt = now;
    const pending = this.positions.pendingOrders();
    if (pending.length) this.log.warn("保留中の注文があります。照会して確定させます", { orders: pending.map((o) => `${o.symbol} ${o.kind} ${o.clientId}`) });
    this.entryPause(now);
    this.seedTempo(now);
    this.warnThesisLive(now);
    this.warnUnwatchedPositions(now);
    this.store.audit({
      ts: now,
      type: "engine.start",
      data: { mode: this.mode, watched: this.hub.watched().map((i) => i.symbol), openPositions: this.journal.list().length, pendingOrders: pending.length },
    });
  }

  /**
   * 監視していない銘柄の建玉 (VENUES を変えた後の古い取引先の建玉など。例: bitbank の BTC/JPY を持ったまま jupiter に切り替えた)。
   * 価格が取れないので損切り・利確・決済が動かない。起動を止めずに警告と監査ログ engine.unwatched_positions を残す
   * (建玉は消さない。`paper reset` で記帳上だけ閉じられる)
   */
  private warnUnwatchedPositions(now: number): void {
    const watched = new Set(this.hub.watched().map((i) => i.symbol));
    const orphan = this.positions.list().filter((p) => !watched.has(p.symbol));
    if (orphan.length === 0) return;
    const list = orphan.map((p) => `${p.symbol} (${p.venue ?? "?"})`);
    this.log.warn(
      `監視していない銘柄の建玉が ${orphan.length} 件あります (いまの VENUES / WATCHLIST に無い取引先・銘柄のため価格が取れず、損切り・決済が動きません)。` +
        (this.mode === "paper" ? "paper なら `npm run trader -- paper reset --equity <円> --confirm` で口座を作り直すことを推奨します" : "取引所で確認してください"),
      { positions: list },
    );
    this.store.audit({ ts: now, type: "engine.unwatched_positions", data: { positions: list } });
  }

  /**
   * live で読みの管理が有効なまま、最大保有・読みの期限のある建玉を引き継いだら、起動時に 1 回だけ警告して監査ログ thesis.enabled_live に残す
   * (以前の時間切れではなく、期限で読み外れ・延長で決済されるため)
   */
  private warnThesisLive(now: number): void {
    if (this.mode !== "live" || !this.thesis.enabled) return;
    const managed = this.positions.list().filter((p) => {
      const plan = this.positions.planOf(p.id);
      return (plan.maxHoldMs ?? 0) > 0 || (plan.expectedMs ?? 0) > 0;
    });
    if (managed.length === 0) return;
    const data = { settings: { ...this.thesis }, positions: managed.map((p) => ({ tradeId: p.id, symbol: p.symbol, entryTs: p.entryTs })) };
    this.log.warn("live: 読みの管理 (THESIS_EXIT) が有効です。保有中の建玉は期限で答え合わせをして決済・延長します (時間切れではありません)", {
      positions: managed.map((p) => p.symbol), ...data.settings,
    });
    this.store.audit({ ts: now, type: "thesis.enabled_live", data });
  }

  /**
   * テンポの復元: この mode の取引のうち直近の窓 (1 時間) にエントリーしたものと、保有中のポジションのエントリー時刻を取り込む
   * (再起動で直近のエントリー数を忘れて、上限を超えて入ったり、テンポを上げすぎたりしない)
   */
  private seedTempo(now: number): void {
    const tc = this.tempo;
    if (!tc) return;
    try {
      // 口座リセットで記帳上だけ閉じた取引など、学習・成績から除く取引は数えない
      const closed = this.store.listTrades({ since: now - tc.windowMs, mode: this.mode }).filter((t) => !isLearningExcludedTrade(t)).map((t) => t.entryTs);
      const ts = tempoSeedTimestamps(closed, this.positions.list().map((p) => p.entryTs), now, tc.windowMs);
      tc.seed(ts);
      if (ts.length) this.log.info("テンポ: 直近のエントリーを復元しました", { entries: ts.length, target: tc.targetPerHour });
    } catch (e) {
      this.log.warn("テンポの復元に失敗 (直近のエントリー 0 件として続行)", { error: redactedErrMsg(e) });
    }
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
    return this.withPendingEntries(this.withTrackedPositions(await this.brokerAccount(now, force)));
  }

  /**
   * journal で追跡中のポジションのうち、ブローカーの建玉一覧に無い・数量が少ない分を想定代金で加える (base は変更しない)。
   * live で約定直後に取引所の一覧の反映が遅れても (口座情報は liveAccountCacheMs キャッシュされる)、
   * 新しい建玉をリスク計算 (最大保有数・1 銘柄上限・資産クラス上限・余力) から漏らさないため。
   * ブローカー側に同じ向きの建玉が既にあれば差分だけを足す (二重計上しない)。paper は PaperBroker と journal が一致するので差は出ない
   */
  private withTrackedPositions(base: AccountState): AccountState {
    const tracked = this.positions.list();
    if (tracked.length === 0) return base;
    const positions = base.positions.map((p) => ({ ...p }));
    let available = D(base.available);
    let added = 0;
    for (const t of tracked) {
      let tq: Decimal;
      try {
        tq = D(t.qty);
      } catch {
        continue;
      }
      if (!tq.isFinite() || !tq.gt(0)) continue;
      const sign = t.direction === "long" ? 1 : -1;
      const same = positions.filter((p) => p.symbol === t.symbol && Number.isFinite(p.qty) && Math.sign(p.qty) === sign);
      const reported = same.reduce((a, p) => a.plus(D(Math.abs(p.qty))), D(0));
      const missing = tq.minus(reported);
      // 数値誤差程度の差は無視する
      if (!missing.gt(tq.mul(1e-9))) continue;
      const inst = this.hub.instrument(t.symbol);
      const mark = this.priceOf(t.symbol);
      const px = mark !== undefined && Number.isFinite(mark) && mark > 0 ? mark : t.lastPrice > 0 ? t.lastPrice : t.entryPrice;
      const cs = t.contractSize ?? inst?.contractSize ?? 1;
      const ccy = inst?.quoteCurrency;
      const meta = { assetClass: t.assetClass, contractSize: cs, ...(ccy ? { quoteCurrency: ccy } : {}) };
      if (same.length > 0) {
        // 一部だけ一覧に出ている: その行を追跡数量まで増やす (行を増やして最大保有数を二重に数えない)
        const row = same[0];
        row.qty = D(Math.abs(row.qty)).plus(missing).mul(sign).toNumber();
        Object.assign(row, meta);
        if (row.price === undefined || !Number.isFinite(row.price)) row.price = px;
      } else {
        positions.push({ symbol: t.symbol, qty: missing.mul(sign).toNumber(), avgPrice: t.entryPrice, price: px, ...meta });
      }
      const rate = ccy ? this.fx.toAccount(ccy) : NaN;
      if (Number.isFinite(rate) && rate > 0 && px > 0) available = available.minus(missing.mul(px).mul(cs).mul(rate));
      added++;
    }
    if (added === 0) return base;
    return { ...base, available: available.toNumber(), positions, trackedUnreported: added };
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
    const fxApprox = new Set<string>();
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
          st.lastError = redactedErrMsg(e);
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
        const approx = fxApproxReason(this.fx, bal.currency, this.fx.baseCurrency, now);
        if (approx && Number.isFinite(rate) && rate > 0) fxApprox.add(approx);
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
      const price = q ? quoteMid(q) : p.avgPrice;
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
      ...(fxApprox.size ? { fxApprox: [...fxApprox] } : {}),
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
      this.log.error("市場データの取得に失敗", { error: redactedErrMsg(e) });
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
    // 2a. 追跡していない建玉の利確の指値 (孤児) を取り消す。待っている指値のエントリーで、気配が損切り価格を越えたものは取消を依頼する
    if (this.positions.tps.size > 0) {
      try {
        await this.positions.sweepTakeProfits(now);
      } catch (e) {
        this.log.warn("利確の指値の整理に失敗", { error: redactedErrMsg(e) });
      }
    }
    // 気配が古い銘柄は判定しない (古い気配による取消は 7 の前に、新規を止める理由として行う)
    this.positions.checkLimitEntries((s) => quotes.get(s) ?? this.hub.latestQuote(s), now, { maxQuoteAgeMs: this.opt.maxQuoteAgeMs });
    // 2b. 見送ったシグナルの仮想トレードの判定 (実際の建玉には影響しない。失敗しても続ける)
    this.shadowUpdate(quotes, now);

    // 3. 手動の解消要求 (CLI `orders resolve`) を適用し、保留中の注文を照会して確定したものを journal に反映する
    //    (状態不明が続いた注文は建玉で確定させる。決済の拒否後の建玉確認もここで行う。venue ごとに並列)
    let entries = 0;
    await this.applyResolveRequests(now);
    if (this.positions.pending.size > 0 || this.positions.hasDeferredChecks()) {
      const sync = await this.positions.syncPending(now);
      entries += sync.opened.length;
      exits += sync.closed.length + sync.reduced;
      await this.afterLimitSync(sync, quotes, now);
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
    // 停止中 (kill switch・日次停止) は待っている指値のエントリーを取り消す (一部約定の分は建玉になり、kill switch なら下で決済する)
    if (killed || this.risk.isHalted(now).halted) {
      const lim = this.positions.pendingOrders().some((o) => o.kind === "entry" && o.limit);
      if (lim) {
        try {
          const r = await this.positions.cancelLimitEntries(() => true, "halted", now);
          await this.afterLimitSync(r, quotes, now);
          entries += r.opened.length;
          if (r.opened.length || r.rejected) {
            this.saveSnapshot();
            this.acctCache = undefined;
          }
        } catch (e) {
          this.log.error("停止による指値のエントリーの取消に失敗", { error: redactedErrMsg(e) });
        }
      }
    }
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
    // テンポはティックの初めに 1 回だけ計算する (無効なら渡さない = 従来どおり)
    const tempo = this.tempo ? { level: this.tempo.level(now), explore: this.tempoExploreAllowed } : undefined;
    const ctx: TickCtx = {
      now,
      brief: this.store.latestBrief(),
      plan: this.store.latestPlan(),
      halted: halted.halted,
      haltReason: halted.reason,
      ...(this.calendar && !this.calendar.isOpen(now) ? { marketClosed: true } : {}),
      account,
      ...(accountBlock ? { entryBlock: accountBlock } : {}),
      timedOut,
      regimes: new Map(),
      intel: new Map(),
      entries,
      exits,
      evaluations: 0,
      ...(tempo ? { tempo } : {}),
    };
    // 7a. 新規エントリーを止める理由 (状態不明の注文・口座情報・気配の古さ・取得の失敗・停止) がある銘柄の、待っている指値のエントリーを取り消す
    //     (テンポの上限は置いた指値を取り消す理由にしない)
    await this.cancelBlockedLimitEntries(ctx, quotes);
    for (const inst of insts) {
      const view = this.hub.getView(inst.symbol, now);
      if (!view) continue;
      try {
        await this.processSymbol(inst, view, ctx);
      } catch (e) {
        this.log.error("銘柄の処理に失敗", { symbol: inst.symbol, error: redactedErrMsg(e) });
      }
    }

    // 7b. 仮想トレードの保存・ニュースと値動きの答え合わせ (失敗しても続ける)
    this.shadowFlush(now);
    this.newsEvaluate(now, quotes);
    // 7c. 値動きの予想の答え合わせ・学習と新しい予想 (intervalMs ごと。失敗しても続ける)
    this.forecastStep(now, quotes);

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
        this.log.error("ポジション管理に失敗", { symbol: pos.symbol, error: redactedErrMsg(e) });
      }
    });
    return exits;
  }

  // ───────── 指値 (maker) のエントリー ─────────

  /**
   * 照会・取消で確定した指値のエントリーの後処理: 約定した建玉には利確の指値を置き、
   * 期限切れで約定しなかったシグナルは仮想トレード (limit_unfilled) として記録する
   */
  private async afterLimitSync(sync: SyncResult, quotes: Map<string, Quote>, now: number): Promise<void> {
    for (const p of sync.opened) {
      try {
        await this.positions.placeTakeProfit(p, quotes.get(p.symbol) ?? this.hub.latestQuote(p.symbol), now);
      } catch (e) {
        this.log.warn("利確の指値の発注に失敗 (次のティックで再試行)", { symbol: p.symbol, error: redactedErrMsg(e) });
      }
    }
    this.recordLimitUnfilled(sync.limitUnfilled, now);
  }

  /**
   * 期限切れで約定しなかった指値のエントリーを仮想トレード (reason "limit_unfilled") として記録する
   * (シグナル時点の気配で成行に入っていたらどうなったか = 指値にしたせいで逃した取引の測定。腕の配分に重み 0.25)。
   * 逆方向のシグナル・損切りの越え・停止・拒否で取り消したものは記録しない
   */
  private recordLimitUnfilled(items: SyncResult["limitUnfilled"], now: number): void {
    for (const { order, cause } of items) {
      if (cause !== "expired") {
        this.skip(`limit_canceled:${cause}`, `${order.symbol}: 指値のエントリーを取り消しました (${cause})`);
        continue;
      }
      this.skip("limit_unfilled", `${order.symbol}: 指値のエントリーが期限内に約定しませんでした`);
      const sh = order.limit?.shadow;
      const inst = this.hub.instrument(order.symbol);
      if (!this.shadow || !sh || !inst) continue;
      try {
        const sim = isSimulatedShort(inst, this.mode, sh.signal.direction);
        const ptf = this.primaryTimeframeOf(sh.signal.strategyId);
        const tf = ptf ? reversalTimeframeFor(this.reversal, ptf) : undefined;
        this.shadow.record({
          instrument: inst, quote: sh.quote, signal: sh.signal, regime: sh.regime, reason: "limit_unfilled", now: sh.signalTs,
          ...(sim ? { simulatedShort: true, borrowRateDaily: this.shortBorrowRateDaily() } : {}),
          ...(tf ? { exitTimeframe: tf } : {}),
        });
      } catch (e) {
        this.warnThrottled("shadow.record", now, "仮想トレードの記録に失敗 (取引は継続)", { error: redactedErrMsg(e) });
      }
    }
  }

  /**
   * 指値のエントリーを待っている銘柄: 発注した戦略を通常と同じタイミング (新しい確定足、板が必須なら毎ティック) で評価し、
   * 逆方向のシグナルなら取り消す (取消 → 照会で確定。一部約定ならその数量で建玉になる)
   */
  private async watchLimitEntry(inst: Instrument, view: MarketView, pl: PendingOrder, ctx: TickCtx): Promise<void> {
    const lim = pl.limit;
    const sid = pl.entry?.input.strategyId;
    if (!lim || lim.cancelReason !== undefined || !sid) return;
    const s = this.strategies.find((x) => x.id === sid);
    if (!s || !s.assetClasses.includes(inst.assetClass)) return;
    if (s.requiresBook) {
      if (!view.book) return;
    } else {
      const c = view.candles[s.primaryTimeframe];
      const last = c && c.length ? c[c.length - 1].ts : undefined;
      if (last === undefined) return;
      const k = `${inst.symbol}|${s.id}`;
      if (this.lastEval.get(k) === last) return;
      this.lastEval.set(k, last);
    }
    let signal: Signal | null;
    try {
      const regime = this.regimeFor(view, s.primaryTimeframe, ctx);
      const intel = this.intelFor(inst, ctx);
      signal = s.evaluate({ market: view, regime, ...(intel ? { intel } : {}), params: this.paramsFor(s, inst), mode: this.mode });
    } catch (e) {
      this.warnThrottled(`limit.watch|${s.id}`, ctx.now, "指値の待機中の戦略の評価に失敗", { symbol: inst.symbol, error: redactedErrMsg(e) });
      return;
    }
    if (!signal || (signal.direction !== "long" && signal.direction !== "short") || signal.direction === lim.direction) return;
    this.log.info("指値のエントリーを待っている間に逆方向のシグナルが出たため取り消します", { symbol: inst.symbol, strategyId: s.id, direction: signal.direction });
    const r = await this.positions.cancelLimitEntries((o) => o.clientId === pl.clientId, "opposite_signal", ctx.now);
    await this.afterLimitSync(r, new Map(), ctx.now);
    if (r.opened.length) {
      ctx.entries += r.opened.length;
      this.saveSnapshot();
      ctx.account = await this.account(ctx.now, true);
    }
  }

  /**
   * 新規エントリーを止める理由がある間は、待っている指値のエントリーも取り消す (取消 → 照会で確定。一部約定ならその数量で建玉)。
   * 理由: 状態不明の注文 (order_unknown) / 口座情報を取得できない (account_unavailable) / 気配が古い・取得の失敗・時間切れ (market_data) /
   * 停止 (halted。kill switch・日次停止は 5 で先に取り消している)。テンポの上限 (tempo_cap) と追跡外の建玉 (live の untracked_position。
   * 待っている指値の約定で照会前に建玉が見えることがある) は、置いた指値を取り消す理由にしない
   */
  private async cancelBlockedLimitEntries(ctx: TickCtx, quotes: Map<string, Quote>): Promise<void> {
    const waiting = this.positions.pendingOrders().filter((o) => o.kind === "entry" && o.limit && o.limit.cancelReason === undefined);
    if (waiting.length === 0) return;
    const paused = this.positions.escalatedOrders().length > 0;
    const reasonOf = (o: PendingOrder): LimitCancelReason | undefined => {
      if (o.limit?.cancelReason !== undefined) return undefined;
      if (ctx.halted) return "halted";
      if (paused) return "order_unknown";
      if (ctx.entryBlock) return "account_unavailable";
      const q = quotes.get(o.symbol) ?? this.hub.latestQuote(o.symbol);
      if (this.hub.lastError(o.symbol) || ctx.timedOut.has(o.symbol) || !q || !(ctx.now - q.ts <= this.opt.maxQuoteAgeMs)) return "market_data";
      return undefined;
    };
    const reasons = new Map<string, LimitCancelReason>();
    for (const o of waiting) {
      const why = reasonOf(o);
      if (why) reasons.set(o.clientId, why);
    }
    if (reasons.size === 0) return;
    this.log.warn("新規エントリーを止める理由があるため、待っている指値のエントリーを取り消します", {
      orders: waiting.filter((o) => reasons.has(o.clientId)).map((o) => `${o.symbol} ${o.clientId} (${reasons.get(o.clientId)})`),
    });
    try {
      const r = await this.positions.cancelLimitEntriesBy((o) => reasons.get(o.clientId), ctx.now);
      await this.afterLimitSync(r, quotes, ctx.now);
      ctx.entries += r.opened.length;
      if (r.opened.length || r.rejected) {
        this.saveSnapshot();
        ctx.account = await this.account(ctx.now, true);
      }
    } catch (e) {
      this.log.error("新規を止める理由による指値のエントリーの取消に失敗", { error: redactedErrMsg(e) });
    }
  }

  /** 新規エントリーの注文の種類: シグナルの指値 (価格あり) → 戦略の entryOrder → 設定 LIMIT_ENTRY (既定 true) */
  private entryOrderFor(s: Strategy, sig: Signal, inst?: Instrument): "market" | "limit" {
    // 成行 (スワップ) だけの取引先 (Jupiter) は常に成行 (LIMIT_ENTRY・シグナルの指値を使わない)
    if (inst && this.marketOnly(inst)) return "market";
    if (sig.entry.type === "limit" && sig.entry.price !== undefined && sig.entry.price > 0) return "limit";
    if (s.entryOrder) return s.entryOrder;
    return (this.config.env.LIMIT_ENTRY ?? true) ? "limit" : "market";
  }

  /** 成行 (スワップ) だけの取引先の銘柄か (発注先の capabilities.marketOnlyVenues) */
  private marketOnly(inst: Instrument): boolean {
    try {
      return this.brokerFor(inst.symbol).capabilities?.marketOnlyVenues?.includes(inst.venue) === true;
    } catch {
      return false;
    }
  }

  /** 指値のエントリーの有効期限: LIMIT_ENTRY_TIMEOUT_MS、未設定なら主時間足の長さ (20 秒〜15 分) */
  private limitTimeoutMs(s: Strategy): number {
    const t = this.config.env.LIMIT_ENTRY_TIMEOUT_MS;
    if (t !== undefined && Number.isFinite(t) && t > 0) return t;
    return Math.min(15 * 60_000, Math.max(20_000, TIMEFRAME_MS[s.primaryTimeframe] ?? 60_000));
  }

  /**
   * 指値の価格: シグナルの価格、無ければ買いは最良の買い気配・売りは最良の売り気配 (板に置く側)。
   * 価格の刻みにそろえる (買いは切り捨て、売りは切り上げ = 置いた瞬間に約定する側へ寄せない)
   */
  private limitPriceFor(inst: Instrument, sig: Signal, q: Quote): number | undefined {
    const raw = sig.entry.type === "limit" && sig.entry.price !== undefined && sig.entry.price > 0 ? sig.entry.price : sig.direction === "long" ? q.bid : q.ask;
    if (!(raw > 0) || !Number.isFinite(raw)) return undefined;
    if (!(inst.tickSize > 0)) return raw;
    const units = D(raw).div(inst.tickSize);
    const px = (sig.direction === "long" ? units.floor() : units.ceil()).mul(inst.tickSize).toNumber();
    return px > 0 ? px : undefined;
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
    // 追跡中の建玉も、待っている指値のエントリーも無ければ照会しない
    // (指値のエントリーを待っている銘柄は、取引所の建玉が説明できる範囲を超えていないかを確かめる)
    const limitPending = this.positions.pendingOrders().some((o) => o.kind === "entry" && o.limit);
    if (this.positions.list().length === 0 && !limitPending) return false;
    // 板に置いた利確の指値の約定を先に反映する (照会までの間の約定を外部の決済と誤認しない)
    try {
      await this.positions.pollAllTakeProfits(now);
    } catch (e) {
      this.log.warn("利確の指値の照会に失敗", { error: redactedErrMsg(e) });
    }
    if (this.positions.list().length === 0 && !limitPending) return true;
    let bp: BrokerPosition[];
    try {
      bp = await this.brokerPositions();
    } catch (e) {
      this.log.warn("建玉の突き合わせに失敗 (次回に再試行)", { error: redactedErrMsg(e) });
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
    // 決済済みの建玉の利確の指値 (孤児) の取消を確かめるまでは入らない (reduceOnly の指値が新しい建玉を決済しないように)
    if (this.positions.hasOrphanTakeProfit(sym)) return { key: "orphan_tp", sample: `${sym}: 決済済みの建玉の利確の指値の取消待ち` };
    // 状態不明の注文がある間はエンジン全体の新規エントリーを止める (確定すれば自動で再開)
    const paused = this.entryPause(ctx.now);
    if (paused) return paused;
    if (ctx.entryBlock) return ctx.entryBlock;
    const err = this.hub.lastError(sym);
    if (err) return { key: "poll_failed", sample: `${sym}: ${redactSecrets(err)}` };
    const screened = this.marketExtras?.entryBlock?.(sym);
    if (screened) return { key: "screen_failed", sample: `${sym}: ${screened}` };
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
      if (sample) s.sample = sample.slice(0, SKIP_SAMPLE_MAX);
    } else this.skips.set(key, { count: 1, sample: (sample ?? key).slice(0, SKIP_SAMPLE_MAX) });
  }

  /** 見送り理由の要約を監査ログへ */
  private flushSkips(now: number): void {
    if (this.skips.size > 0) {
      const summary = Object.fromEntries([...this.skips].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, v]));
      // reasons は集計キー (数字は #) → { count, sample }。samples は数字入りの直近の実例 (キーと同じものは載せない)
      const samples: Record<string, string> = {};
      for (const [k, v] of this.skips) if (v.sample && v.sample !== k) samples[k] = v.sample.slice(0, SKIP_SAMPLE_MAX);
      this.store.audit({ ts: now, type: "engine.skip_summary", data: { since: this.lastSkipFlush ?? now, reasons: summary, samples } });
      this.skips.clear();
    }
    this.lastSkipFlush = now;
  }

  // ───────── 見送ったシグナルの答え合わせ (仮想トレード) ─────────
  // どれも実際の発注・リスク判定・建玉管理には触れず、例外は握りつぶす (ティックを止めない)

  /**
   * 見送ったシグナルを仮想トレードとして記録する。
   * intelSentiment (direction_bias のときだけ渡す) は決済時に情報の効き具合の更新へ使うため覚えておく
   */
  private shadowRecord(key: string, inst: Instrument, view: MarketView, s: Strategy, signal: Signal, regime: RegimeFeatures, now: number, intelSentiment?: number): void {
    if (!this.shadow) return;
    try {
      // paper で再現した空売りは方向別の腕 (…|short) で学習し、借入コストを仮想トレードの R に含める
      const sim = isSimulatedShort(inst, this.mode, signal.direction);
      const created = this.shadow.record({
        instrument: inst, quote: view.quote, signal: { ...signal, horizon: signal.horizon ?? s.horizon }, regime: regime.label, reason: key, now,
        ...(sim ? { simulatedShort: true, borrowRateDaily: this.shortBorrowRateDaily() } : {}),
        // 転換で決済は実際の建玉と同じ時間足 (REVERSAL_EXIT_TF。lower = 主時間足の 1 つ下) で判定する
        exitTimeframe: reversalTimeframeFor(this.reversal, s.primaryTimeframe),
      });
      if (created && key === "direction_bias" && typeof intelSentiment === "number" && Number.isFinite(intelSentiment)) {
        const m = this.shadowIntelMap();
        m[`${inst.symbol}|${signal.strategyId}|${signal.direction}`] = { ts: now, s: intelSentiment };
        this.saveShadowIntel(now);
      }
    } catch (e) {
      this.warnThrottled("shadow.record", now, "仮想トレードの記録に失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  private shadowIntelKey(): string {
    return `shadowIntel:${this.mode}`;
  }

  private shadowIntelMap(): Record<string, { ts: number; s: number }> {
    if (!this.shadowIntel) {
      const saved = this.store.kvGet<Record<string, { ts: number; s: number }>>(this.shadowIntelKey());
      this.shadowIntel = saved && typeof saved === "object" ? { ...saved } : {};
    }
    return this.shadowIntel;
  }

  /** 保存 (決済されずに捨てられた分が残らないよう、8 日より古いものは消す) */
  private saveShadowIntel(now: number): void {
    const m = this.shadowIntelMap();
    for (const [k, v] of Object.entries(m)) if (!v || !(now - v.ts < 8 * 86_400_000)) delete m[k];
    this.store.kvSet(this.shadowIntelKey(), m);
  }

  /** 仮想トレードの決済 → 学習 (direction_bias はエントリー時の情報バイアスを添える) */
  private onShadowClosed(t: ShadowTradeRecord): void {
    let intelSentiment: number | undefined;
    if (t.reason === "direction_bias") {
      try {
        const m = this.shadowIntelMap();
        const k = `${t.symbol}|${t.strategyId}|${t.direction}`;
        const e = m[k];
        if (e && e.ts === t.entryTs) intelSentiment = e.s;
        if (e && e.ts <= t.entryTs) {
          delete m[k];
          this.saveShadowIntel(t.exitTs);
        }
      } catch (e) {
        this.warnThrottled("shadow.intel", t.exitTs, "仮想トレードの情報バイアスの読み書きに失敗 (取引は継続)", { error: redactedErrMsg(e) });
      }
    }
    this.learning.onShadowClosed(t, intelSentiment !== undefined ? { intelSentiment } : {});
  }

  /** paper で再現する空売りの借入コストの日率 (PAPER_SHORT_BORROW_RATE_DAILY) */
  private shortBorrowRateDaily(): number {
    const r = this.config.env.PAPER_SHORT_BORROW_RATE_DAILY;
    return typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : DEFAULT_SHORT_BORROW_RATE_DAILY;
  }

  /**
   * 新規停止中など、戦略を評価しない経路でも仮想トレード用にだけ評価する (腕の乱数・評価回数には触れない)。
   * 戻り値は戦略が返したシグナル (評価に失敗・仮想トレードが無効なら null)
   */
  private shadowEvaluate(s: Strategy, inst: Instrument, view: MarketView, ctx: TickCtx, key: string): Signal | null {
    if (!this.shadow) return null;
    try {
      const regime = this.regimeFor(view, s.primaryTimeframe, ctx);
      const intel = this.intelFor(inst, ctx);
      // 戦略自身が見送ったシグナルも観測用に集める (停止中でも新規エントリーの評価なので渡す)
      const filtered: { signal: Signal; reason: string }[] = [];
      // テンポ (有効なときだけ) も新規エントリーの評価と同じく渡す (入っていたら同じシグナルになるように)
      const signal = s.evaluate({
        market: view, regime, ...(intel ? { intel } : {}), params: this.paramsFor(s, inst), mode: this.mode, ...this.tempoCtx(ctx),
        onFiltered: (fs, reason) => { filtered.push({ signal: fs, reason }); },
      });
      if (signal) this.rememberSignal(inst.symbol, signal, ctx.now);
      // 最大保有 (MAX_HOLD_MINUTES) も実際のエントリーと同じく縮める (hold_limit の中期・長期は戦略のまま)
      if (signal && signal.direction !== "flat") this.shadowRecord(key, inst, view, s, this.holdLimited(s) ? signal : this.clampHold(signal), regime, ctx.now);
      for (const f of filtered) if (f.signal.direction !== "flat") this.shadowRecord(`strategy_filter:${f.reason}`, inst, view, s, f.signal, regime, ctx.now);
      return signal;
    } catch (e) {
      this.warnThrottled("shadow.evaluate", ctx.now, "仮想トレード用の戦略評価に失敗 (取引は継続)", { strategyId: s.id, symbol: inst.symbol, error: redactedErrMsg(e) });
      return null;
    }
  }

  /** 新規エントリーの評価に渡すテンポ (テンポのモードでなければ空 = 従来どおり) */
  private tempoCtx(ctx: TickCtx): Pick<StrategyContext, "tempo" | "tempoExplore"> {
    return ctx.tempo ? { tempo: ctx.tempo.level, tempoExplore: ctx.tempo.explore } : {};
  }

  /** MAX_HOLD_MINUTES が有効なとき、中期・長期の戦略は新規エントリーしない (仮想トレード hold_limit としてだけ記録する) */
  private holdLimited(s: Strategy): boolean {
    return this.maxHoldMs !== undefined && isHoldLimitedHorizon(s.horizon);
  }

  /**
   * MAX_HOLD_MINUTES: シグナルの最大保有を上限までに縮める (0・非有限 = 時間切れ無しも上限にする)。
   * 読みの期限 (expectedMs) があれば同じく上限までに縮める (読みの管理が有効なら MAX_HOLD_MINUTES は読みの期限の上限)。
   * 無効・flat ならそのまま (同じオブジェクト)
   */
  private clampHold(sig: Signal): Signal {
    if (this.maxHoldMs === undefined || sig.direction === "flat") return sig;
    const next = clampMaxHoldMs(sig.maxHoldMs, this.maxHoldMs);
    const exp = sig.expectedMs !== undefined && Number.isFinite(sig.expectedMs) && sig.expectedMs > 0 ? Math.min(sig.expectedMs, this.maxHoldMs) : sig.expectedMs;
    return next === sig.maxHoldMs && exp === sig.expectedMs ? sig : { ...sig, maxHoldMs: next, ...(exp !== undefined ? { expectedMs: exp } : {}) };
  }

  /** 前回の判定以降の 1m 確定足の高値・安値 */
  private candleRange(symbol: string, sinceTs: number, now: number, cache: Map<string, MarketView | undefined>): PriceRange | undefined {
    if (!cache.has(symbol)) cache.set(symbol, this.hub.getView(symbol, now));
    const c = cache.get(symbol)?.candles["1m"];
    if (!c || c.length === 0) return undefined;
    let high = -Infinity;
    let low = Infinity;
    let lastTs: number | undefined;
    for (let i = c.length - 1; i >= 0 && c[i].ts >= sinceTs; i--) {
      high = Math.max(high, c[i].high);
      low = Math.min(low, c[i].low);
      lastTs ??= c[i].ts;
    }
    return lastTs === undefined ? undefined : { high, low, lastCandleTs: lastTs };
  }

  /** 毎ティック: 仮想トレードの損切り・利確・時間切れ・転換で決済の判定。監視をやめた銘柄の分は捨てる */
  private shadowUpdate(quotes: Map<string, Quote>, now: number): void {
    if (!this.shadow || this.shadow.size === 0) return;
    try {
      const watched = new Set(this.hub.watched().map((i) => i.symbol));
      const views = new Map<string, MarketView | undefined>();
      const viewOf = (sym: string) => {
        if (!views.has(sym)) views.set(sym, this.hub.getView(sym, now));
        return views.get(sym);
      };
      this.shadow.update(now, (sym) => quotes.get(sym) ?? this.hub.latestQuote(sym), {
        isWatched: (sym) => watched.has(sym),
        rangeOf: (sym, since) => this.candleRange(sym, since, now, views),
        // 転換で決済: hub の確定足をそのまま渡す (hub は全戦略の時間足と転換で決済の時間足を持つ)
        candlesOf: (sym, tf) => viewOf(sym)?.candles[tf],
      });
    } catch (e) {
      this.warnThrottled("shadow.update", now, "仮想トレードの判定に失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  private shadowFlush(now: number): void {
    try {
      this.shadow?.flush();
    } catch (e) {
      this.warnThrottled("shadow.flush", now, "仮想トレードの保存に失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  // ───────── ニュースと値動きの答え合わせ ─────────

  /** ニュース判定用の銘柄情報 (仲値・1 分あたりの ATR 比・往復コスト比) */
  private newsMarketInfo(inst: Instrument, now: number): NewsMarketInfo {
    const q = this.hub.latestQuote(inst.symbol);
    if (!q || !(q.bid > 0) || !(q.ask >= q.bid)) return { instrument: inst };
    const mid = quoteMid(q);
    let atrPctPerMin: number | undefined;
    const view = this.hub.getView(inst.symbol, now);
    const tfs = (Object.keys(view?.candles ?? {}) as Timeframe[]).sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
    for (const tf of tfs) {
      const c = view!.candles[tf];
      if (!c || c.length < 15) continue;
      const a = atrLast(c, 14);
      if (Number.isFinite(a) && a > 0) {
        // 時間足の ATR を 1 分あたりへ (ランダムウォークの √時間 で換算)
        atrPctPerMin = a / mid / Math.sqrt(Math.max(1, TIMEFRAME_MS[tf] / 60_000));
        break;
      }
    }
    return { instrument: inst, mid, ...(atrPctPerMin !== undefined ? { atrPctPerMin } : {}), costPct: costBps(inst, q) / 10_000 };
  }

  /** 情報ループの後: 分析済みの情報を判定待ちに加える */
  private newsIngest(now: number): void {
    try {
      const items = this.intel.lastItems?.() ?? this.store.listIntel({ since: now - this.learning.news.opts.maxAgeMs, limit: 1000 });
      if (items.length === 0) return;
      const markets = this.hub.watched().map((inst) => this.newsMarketInfo(inst, now));
      const added = this.learning.news.ingest(items, markets, now);
      if (added > 0) this.log.debug("ニュースの答え合わせ待ちに追加", { added });
    } catch (e) {
      this.warnThrottled("news.ingest", now, "ニュースの答え合わせの取り込みに失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  /** newsEvalEveryMs ごと: 判定時刻を過ぎたニュースを値動きと比べる */
  private newsEvaluate(now: number, quotes: Map<string, Quote>): void {
    if (this.lastNewsEvalAt !== undefined && now - this.lastNewsEvalAt < this.newsEvalEveryMs) return;
    this.lastNewsEvalAt = now;
    try {
      const watched = new Set(this.hub.watched().map((i) => i.symbol));
      this.learning.news.evaluate(now, {
        isWatched: (sym) => watched.has(sym),
        midNow: (sym) => {
          const q = quotes.get(sym) ?? this.hub.latestQuote(sym);
          return q && q.bid > 0 && q.ask >= q.bid ? quoteMid(q) : undefined;
        },
        priceAt: this.priceAt,
      });
    } catch (e) {
      this.warnThrottled("news.evaluate", now, "ニュースの答え合わせの判定に失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  // ───────── 値動きの予想 ─────────
  // 予想・判定・学習は取引の判断から独立しており、例外は握りつぶす (ティックを止めない)

  /** 戦略が出したシグナルを覚える (戦略の合意の特徴量。仮想トレード用の評価も含む) */
  private rememberSignal(symbol: string, sig: Signal, now: number): void {
    if (!this.forecast || (sig.direction !== "long" && sig.direction !== "short")) return;
    const list = (this.recentSignals.get(symbol) ?? []).filter((x) => now - x.ts <= SIGNAL_MEMORY_MS);
    list.push({ ts: now, dir: sig.direction === "long" ? 1 : -1, conf: Number.isFinite(sig.confidence) ? Math.min(1, Math.max(0, sig.confidence)) : 0.5 });
    if (list.length > SIGNAL_MEMORY_MAX) list.splice(0, list.length - SIGNAL_MEMORY_MAX);
    this.recentSignals.set(symbol, list);
  }

  /** 戦略の合意 (−1〜1): 直近 (予想時間、15 分〜1 時間) のシグナルの向き × 信頼度の合計 → tanh */
  private consensusFor(symbol: string, horizonMs: number, now: number): number {
    const list = this.recentSignals.get(symbol);
    if (!list || list.length === 0) return 0;
    const win = Math.min(SIGNAL_MEMORY_MS, Math.max(15 * 60_000, horizonMs));
    let sum = 0;
    for (const x of list) if (now - x.ts <= win && x.ts <= now) sum += x.dir * x.conf;
    return Math.tanh(sum / 2);
  }

  /** intervalMs ごと: 期限が来た予想をまとめて判定・学習し、監視銘柄ごとに新しい予想を出す */
  private forecastStep(now: number, quotes: Map<string, Quote>): void {
    const fc = this.forecast;
    if (!fc) return;
    if (this.lastForecastAt !== undefined && now - this.lastForecastAt < fc.opts.intervalMs && now >= this.lastForecastAt) return;
    this.lastForecastAt = now;
    try {
      const insts = this.hub.watched();
      const watched = new Set(insts.map((i) => i.symbol));
      const views = new Map<string, MarketView | undefined>();
      const viewOf = (sym: string) => {
        if (!views.has(sym)) views.set(sym, this.hub.getView(sym, now));
        return views.get(sym);
      };
      const midNow = (sym: string) => {
        const q = quotes.get(sym) ?? this.hub.latestQuote(sym);
        return q && q.bid > 0 && q.ask >= q.bid ? quoteMid(q) : undefined;
      };
      fc.evaluate(now, { isWatched: (sym) => watched.has(sym), midNow, priceAt: (sym, ts) => priceFromCandles(viewOf(sym)?.candles["1m"], ts) });
      for (const s of [...this.recentSignals.keys()]) if (!watched.has(s)) this.recentSignals.delete(s);
      const brief = this.store.latestBrief();
      const biases = brief && now - brief.generatedAt <= FORECAST_BRIEF_MAX_AGE_MS ? brief.biases : {};
      for (const inst of insts) {
        try {
          const view = viewOf(inst.symbol);
          const q = view?.quote;
          if (!view || !q || !(q.bid > 0) || !(q.ask >= q.bid) || now - q.ts > this.opt.maxQuoteAgeMs) continue;
          const b = biasForInstrument(inst, biases);
          fc.forecast({
            instrument: inst,
            candles: view.candles,
            now,
            mid: quoteMid(q),
            costPct: costBps(inst, q) / 10_000,
            news: b.found ? b.sentiment * b.confidence : 0,
            consensus: (h) => this.consensusFor(inst.symbol, h, now),
          });
        } catch (e) {
          this.warnThrottled("forecast.symbol", now, "値動きの予想に失敗 (取引は継続)", { symbol: inst.symbol, error: redactedErrMsg(e) });
        }
      }
      fc.flush();
    } catch (e) {
      this.warnThrottled("forecast.step", now, "値動きの予想・答え合わせに失敗 (取引は継続)", { error: redactedErrMsg(e) });
    }
  }

  /** 予想による新規エントリーのサイズの倍率 (実力が確かめられていなければ 1) */
  private forecastMultiplier(symbol: string, sig: Signal, horizon: Strategy["horizon"], now: number): ReturnType<ForecastTracker["multiplierFor"]> | undefined {
    if (!this.forecast || (sig.direction !== "long" && sig.direction !== "short")) return undefined;
    try {
      return this.forecast.multiplierFor(symbol, sig.direction, horizon, now);
    } catch (e) {
      this.warnThrottled("forecast.multiplier", now, "予想の倍率の計算に失敗 (倍率 1 で続行)", { error: redactedErrMsg(e) });
      return undefined;
    }
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

  /** ベースライン計画と同じ規則で 1 戦略だけ計画する (片側バイアスは情報の効き具合で補正) */
  private baselineFor(inst: Instrument, s: Strategy, regime: RegimeFeatures, armWeight: number, ctx: TickCtx): StrategyPlan {
    return buildBaselinePlan({
      brief: ctx.brief ?? emptyBrief(ctx.now),
      instruments: [inst],
      regimes: { [inst.symbol]: regime },
      strategies: [s],
      armWeights: { [armKey(s.id, regime.label, inst.assetClass)]: armWeight },
      intelInfluence: { [inst.assetClass]: this.learning.intelInfluence(inst.assetClass) },
      lessons: [],
      now: ctx.now,
      mode: this.mode,
    });
  }

  /**
   * 新規エントリーの可否 (計画 → 無ければベースライン計画相当)。ブラックアウトも確認する。
   * armWeight はエントリー時の腕の重み (無効化中の腕は探索に当たったときだけ exploreSize、外れたら 0)。
   * 腕が無効なために外したときは reason "arm_disabled" (呼び出し側が仮想トレード用にだけ戦略を評価する)
   */
  private gate(inst: Instrument, s: Strategy, regime: RegimeFeatures, armWeight: number, ctx: TickCtx): Gate {
    const { now } = ctx;
    const plan = ctx.plan && ctx.plan.validUntil > now ? ctx.plan : undefined;
    const sp = plan?.perSymbol[inst.symbol];
    let blackouts: StrategyPlan["blackouts"];
    let directionBias: Gate["directionBias"];
    let riskMultiplier: number;
    if (plan && sp) {
      if (!sp.enabledStrategies.includes(s.id)) {
        if (!sp.armDisabled?.includes(s.id)) return { ok: false, reason: "plan_disabled", directionBias: "both", riskMultiplier: 0 };
        // 計画作成時に腕が無効だった戦略。今の腕の重みが 0 (無効のまま・探索に外れた) なら見送る
        if (!(armWeight > 0)) return { ok: false, reason: "arm_disabled", directionBias: "both", riskMultiplier: 0 };
        // 探索に当たった・回復した: ベースラインと同じ規則で許可し、計画側の判断 (方向・倍率・ブラックアウト) も守る
        const bp = this.baselineFor(inst, s, regime, armWeight, ctx).perSymbol[inst.symbol];
        if (!bp?.enabledStrategies.includes(s.id)) return { ok: false, reason: "baseline_disabled", directionBias: "both", riskMultiplier: 0 };
        const planActive = sp.enabledStrategies.length > 0;
        directionBias = planActive ? sp.directionBias : bp.directionBias;
        riskMultiplier = planActive ? Math.min(sp.riskMultiplier, bp.riskMultiplier) : bp.riskMultiplier;
        blackouts = plan.blackouts;
      } else {
        directionBias = sp.directionBias;
        riskMultiplier = sp.riskMultiplier;
        blackouts = plan.blackouts;
      }
    } else {
      // 計画がまだ無い (期限切れ・計画後に追加した銘柄を含む): レジームに合う戦略をベースライン計画と同じ規則で許可
      const base = this.baselineFor(inst, s, regime, armWeight, ctx);
      const bp = base.perSymbol[inst.symbol];
      if (!bp?.enabledStrategies.includes(s.id)) {
        const reason = bp?.armDisabled?.includes(s.id) ? "arm_disabled" : "baseline_disabled";
        return { ok: false, reason, directionBias: "both", riskMultiplier: 0 };
      }
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
    let pos = this.positions.get(sym);
    if (!pos) {
      // 指値のエントリーを待っている間は、その戦略が逆方向のシグナルを出したら取り消す
      const pl = this.positions.pendingLimitEntry(sym);
      if (pl) {
        await this.watchLimitEntry(inst, view, pl, ctx);
        // 取消の照会で一部約定が分かると建玉になる: 以降は保有中として扱う (古い pos のまま新規の評価をしない)
        pos = this.positions.get(sym);
      }
      if (!pos) {
        const block = this.entryBlock(inst, ctx);
        if (block) return this.skip(block.key, block.sample);
      }
    }
    const candidates: Candidate[] = [];
    /** このティックで持ち主の戦略の決済シグナル (flat・逆方向) で決済を試みたか (転換で決済を重ねない) */
    let signalExitTried = false;
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
      if (!pos && ctx.marketClosed) {
        this.skip("market_closed");
        continue;
      }
      if (!pos && ctx.halted) {
        this.skip("halted", ctx.haltReason);
        // 新規停止中も戦略を評価し、出たシグナルは仮想トレードとしてだけ記録する (発注・腕の乱数には触れない)
        this.shadowEvaluate(s, inst, view, ctx, "halted");
        continue;
      }
      const regime = this.regimeFor(view, s.primaryTimeframe, ctx);
      if (!pos && this.observeOnly.has(s.id)) {
        // 観測専用 (OBSERVE_ONLY_STRATEGIES): 評価とシグナルの生成は通常どおり行い、新規エントリーは発注せず
        // 仮想トレード (reason "observe_only") としてだけ記録する。candidates に入れないので発注・RiskManager には届かず、
        // 腕の乱数 (armWeight) も引かない。
        // 判定は腕・計画の判定 (gate) より前に置く: gate の後ろだと、腕が止まっているときは arm_disabled として
        // (回復判定用に) 記録され、AI の計画で外れると plan_disabled で何も記録されず、観測が腕・計画の状態に左右されるため。
        // 戦略自身の対象レジームと低流動性の停止だけは通常の経路 (ベースライン計画) と同じく守る (有効にしたら入るはずのシグナルだけを測る)。
        // 保有中 (pos あり) は通常の経路のまま (観測専用にする前に建てた建玉の決済シグナルを止めない)
        if (regime.label === "low_liquidity" || !s.regimes.includes(regime.label)) continue;
        const sig = this.shadowEvaluate(s, inst, view, ctx, "observe_only");
        if (sig && sig.direction !== "flat") this.skip("observe_only", `${sym} ${s.id}: 観測専用のため発注しません`);
        continue;
      }
      if (!pos && this.holdLimited(s)) {
        // 最大保有 (MAX_HOLD_MINUTES): 中期・長期の戦略は保有の上限に収まらないので、観測専用と同じ扱いにする
        // (腕・計画の判定より前、対象レジームと低流動性の停止は守る。仮想トレード "hold_limit" は observe_only と同じく
        // 腕の配分に重み 0.25 で入り、腕を止める判定には使わない)。保有中の建玉の決済シグナルは通常の経路のまま
        if (regime.label === "low_liquidity" || !s.regimes.includes(regime.label)) continue;
        const sig = this.shadowEvaluate(s, inst, view, ctx, "hold_limit");
        if (sig && sig.direction !== "flat") {
          this.skip("hold_limit", `${sym} ${s.id}: 最大保有 ${Math.round(this.maxHoldMs! / 60_000)} 分に収まらない時間軸 (${s.horizon}) のため発注しません`);
        }
        continue;
      }
      let gate: Gate | undefined;
      let armWeight = 1;
      // paper で空売りを再現する銘柄か (live では常に false。src/core/short.ts)
      const simShortInst = isSimulatedShort(inst, this.mode);
      /** 買いの腕が無効でも、再現した空売りの腕 (…|short) が有効なときの計画の判定 (空売りのシグナルにだけ使う) */
      let shortOnly: { gate: Gate; armWeight: number } | undefined;
      if (!pos) {
        // 探索 (無効化中の腕を exploreProb で試す) の乱数はエントリー時のここだけで引く (計画は決定的な重み)
        armWeight = this.learning.armWeight(s.id, regime.label, inst.assetClass, this.rng);
        gate = this.gate(inst, s, regime, armWeight, ctx);
        if (!gate.ok && gate.reason === "arm_disabled" && simShortInst) {
          // 買いと空売り (paper 再現) は別の腕。買いの腕が止まっていても空売りの腕が有効なら評価を続ける
          const w = this.learning.armWeight(s.id, regime.label, inst.assetClass, this.rng, true);
          const g = this.gate(inst, s, regime, w, ctx);
          if (g.ok) shortOnly = { gate: g, armWeight: w };
        }
        if (!gate.ok && !shortOnly) {
          this.skip(gate.reason!);
          // 腕が無効なために外したときも戦略を評価し、シグナルは仮想トレードとしてだけ記録する (回復の判定に使う。発注しない)。
          // 評価は通常の評価と同じタイミング (新しい確定足ごと) に 1 回だけ
          if (gate.reason === "arm_disabled") this.shadowEvaluate(s, inst, view, ctx, "arm_disabled");
          continue;
        }
      }
      const params = this.paramsFor(s, inst);
      const intel = this.intelFor(inst, ctx);
      const filtered: { signal: Signal; reason: string }[] = [];
      const sctx: StrategyContext = {
        market: view,
        regime,
        ...(intel ? { intel } : {}),
        ...(owner ? { position: this.positions.view(owner) } : {}),
        params,
        // 空売りの再現は paper だけ (戦略は canShort(inst, mode) で判定する)
        mode: this.mode,
        // 新規エントリーの評価のときだけ、戦略が自分で見送ったシグナルを観測用に集める (記録だけ。発注・腕の学習には使わない)
        ...(owner ? {} : { onFiltered: (fs: Signal, reason: string) => { filtered.push({ signal: fs, reason }); } }),
        // テンポも新規エントリーの評価のときだけ渡す (保有中の決済判定は従来どおり)
        ...(owner ? {} : this.tempoCtx(ctx)),
      };
      ctx.evaluations++;
      let signal: Signal | null;
      try {
        signal = s.evaluate(sctx);
      } catch (e) {
        this.log.error("戦略の評価に失敗", { strategyId: s.id, symbol: sym, error: redactedErrMsg(e) });
        continue;
      }
      for (const f of filtered) if (f.signal.direction !== "flat") this.shadowRecord(`strategy_filter:${f.reason}`, inst, view, s, f.signal, regime, ctx.now);
      if (!signal) continue;
      this.rememberSignal(sym, signal, ctx.now);

      if (owner) {
        const opposite = (signal.direction === "long" && owner.direction === "short") || (signal.direction === "short" && owner.direction === "long");
        if (signal.direction === "flat" || opposite) {
          signalExitTried = true;
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
      // 最大保有 (MAX_HOLD_MINUTES): シグナルの最大保有を上限までに縮める (無効ならそのまま)
      signal = this.clampHold(signal);
      if (simShortInst && signal.direction === "short") {
        // paper で再現した空売り: 配分倍率・停止は空売りの腕 (…|short) で決める (買いの腕の成績と混ぜない)
        if (shortOnly) {
          gate = shortOnly.gate;
          armWeight = shortOnly.armWeight;
        } else {
          armWeight = this.learning.armWeight(s.id, regime.label, inst.assetClass, this.rng, true);
        }
      } else if (shortOnly) {
        // 買いの腕が止まっている (空売りの腕だけ有効) ときの買いのシグナルは従来どおり仮想トレードとしてだけ記録する
        this.skip("arm_disabled");
        this.shadowRecord("arm_disabled", inst, view, s, signal, regime, ctx.now);
        continue;
      }
      if (gate!.directionBias !== "both" && gate!.directionBias !== signal.direction) {
        this.skip("direction_bias");
        // 情報の効き具合の答え合わせ用に、戦略へ渡したものと同じ (補正後の) 情報バイアスを添える
        this.shadowRecord("direction_bias", inst, view, s, signal, regime, ctx.now, intel?.sentiment);
        continue;
      }
      if (!(armWeight > 0)) {
        this.skip("arm_disabled");
        this.shadowRecord("arm_disabled", inst, view, s, signal, regime, ctx.now);
        continue;
      }
      // 計画のリスク倍率 × 腕の重み (上限は計画と同じ MAX_RISK_MULTIPLIER)
      const riskMultiplier = Math.min(MAX_RISK_MULTIPLIER, gate!.riskMultiplier * armWeight);
      candidates.push({
        strategy: s, signal, regime, params, intel, armWeight, riskMultiplier,
        score: signal.confidence * armWeight * signal.expectedEdgeBps,
      });
    }
    if (pos) {
      // 転換で決済 (REVERSAL_EXIT): 戦略の決済シグナルと同じく確定足で判断する (同じ確定足で両方なら signal を優先)
      const cur = this.positions.get(sym);
      if (cur && cur.id === pos.id) await this.reversalExit(inst, view, cur, ctx, signalExitTried);
      return;
    }
    if (candidates.length === 0) return;
    // 同じ銘柄で複数の戦略がシグナルを出したら confidence × 腕の重み × 期待値幅 が最大のもの
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    if (candidates.length > 1) {
      this.skip("lower_score", `${sym}: ${candidates.length} 件中 ${best.strategy.id} を採用`);
      for (const c of candidates) if (c !== best) this.shadowRecord("lower_score", inst, view, c.strategy, c.signal, c.regime, ctx.now);
    }
    // テンポの上限: 直近 1 時間のエントリーが 目標 × TEMPO_CAP_MULTIPLIER (切り上げ) に達したら新規エントリーを止める
    // (このティックで先に入った分も数える)。見送ったシグナルは通常の仮想トレードとして記録する
    if (this.tempo?.capped(ctx.now)) {
      const snap = this.tempo.snapshot(ctx.now);
      this.skip("tempo_cap", `${sym}: 直近 1 時間のエントリー ${snap.entriesInWindow} 回が上限 ${snap.capAt} 回に到達 (目標 ${snap.target} 回/時)`);
      this.shadowRecord("tempo_cap", inst, view, best.strategy, best.signal, best.regime, ctx.now);
      return;
    }
    await this.enter(inst, view, best, ctx);
  }

  /**
   * 戦略の主時間足。登録している戦略 (この engine の一覧 → ALL_STRATEGIES) に無ければ、廃止した戦略の値 (RETIRED_STRATEGIES)。
   * 再起動前に建てた廃止した戦略の建玉も、転換で決済を同じ時間足で判定できるようにする。どれにも無ければ undefined
   */
  private primaryTimeframeOf(strategyId: string): Timeframe | undefined {
    const s = this.strategies.find((x) => x.id === strategyId) ?? ALL_STRATEGIES.find((x) => x.id === strategyId);
    return s?.primaryTimeframe ?? (Object.hasOwn(RETIRED_STRATEGIES, strategyId) ? RETIRED_STRATEGIES[strategyId].primaryTimeframe : undefined);
  }

  /**
   * 転換で決済 (REVERSAL_EXIT。src/engine/reversalExit.ts)。保有中の建玉を、REVERSAL_EXIT_TF の時間足
   * (lower (既定) = 持ち主の戦略の主時間足の 1 つ下、same = 主時間足。hub がその足を持たなければ主時間足) の新しい確定足ごとに 1 回判定する。
   * エントリー後に確定したスイングが無ければ、REVERSAL_EXIT_FALLBACK=true のときだけエントリーした足の安値 (買い) / 高値 (売り) を水準にする (監査ログに fallback: true)。
   * 買いはエントリー後にできた押し安値 (確定したスイングロー) を確定足の終値が割ったら、売りは戻り高値を越えたら、
   * 利確・損切りの手前でも成行で決済する (理由 "reversal")。含み益でも含み損でも同じ。
   * - 損切り・利確・トレーリング・読みの管理はティックごとに manageExits で先に判定している (そちらが先)。
   * - 戦略の決済シグナル (flat・逆方向) と同じ確定足で両方が出たら signal を優先する (signalTried のときは判定済みとして見送る)。
   *   したがって signal の件数は REVERSAL_EXIT=false のときと変わらず、reversal は「シグナルでは決済しなかった」転換だけ。
   * - 決済の手続きが進んでいる建玉 (保留中・状態不明の注文、読みの決済の再試行、一部約定の残り、利確の指値の取消中) には重ねない
   *   (PositionManager.exitInProgress。進んでいる間は判定せず、終われば同じ確定足で判定する)。
   * - 決済はシグナルと同じ通常の close() (利確の指値の取消確認・reduceOnly・状態不明の扱いはそのまま)。
   *   発注レートの上限・再試行待ち (throttled) なら次のティックで判定し直す。
   * - 読みの管理の建玉・延長中の建玉も対象 (読みの決済が決まっていれば上書きしない)。
   * - 足がエントリーより新しい (履歴が足りない) 建玉は判定しない (監査ログ position.reversal_no_history を 1 回だけ)。
   * 判定の根拠は監査ログ position.reversal_exit (水準・終値・スイングの足の時刻など) に残す。
   */
  private async reversalExit(inst: Instrument, view: MarketView, pos: OpenTrade, ctx: TickCtx, signalTried: boolean): Promise<void> {
    if (!reversalAppliesTo(this.reversal, pos.strategyId)) return;
    // 持ち主の戦略の主時間足 (廃止した戦略の建玉は src/strategies/retired.ts の値)。分からなければ判定しない
    const primaryTf = this.primaryTimeframeOf(pos.strategyId);
    if (!primaryTf) return;
    // 判定の時間足 (REVERSAL_EXIT_TF。lower = 主時間足の 1 つ下)。hub がその足を持たなければ主時間足で判定する
    const want = reversalTimeframeFor(this.reversal, primaryTf);
    const tf = view.candles[want]?.length ? want : primaryTf;
    const tfMs = TIMEFRAME_MS[tf];
    const c = view.candles[tf];
    const lastBar = c && c.length ? c[c.length - 1] : undefined;
    // エントリーした後に確定した足がまだ無ければ何もしない
    if (!c || !lastBar || lastBar.ts + tfMs <= pos.entryTs) return;
    if (this.reversalEvalAt.get(pos.id) === lastBar.ts) return;
    if (this.reversalEvalAt.size > 256) {
      const open = new Set(this.positions.list().map((p) => p.id));
      for (const id of [...this.reversalEvalAt.keys()]) if (!open.has(id)) this.reversalEvalAt.delete(id);
      for (const id of [...this.reversalNoHistory]) if (!open.has(id)) this.reversalNoHistory.delete(id);
    }
    if (signalTried) {
      this.reversalEvalAt.set(pos.id, lastBar.ts);
      return;
    }
    if (this.positions.exitInProgress(inst.symbol)) return;
    this.reversalEvalAt.set(pos.id, lastBar.ts);
    const r = checkReversal(c, pos.entryTs, pos.direction, {
      pivotN: this.reversal.pivotN, bufferAtr: this.reversal.bufferAtr, tfMs, fallback: this.reversal.fallback,
    });
    if (r.skip === "no_history" && !this.reversalNoHistory.has(pos.id)) {
      this.reversalNoHistory.add(pos.id);
      const data = { tradeId: pos.id, symbol: inst.symbol, strategyId: pos.strategyId, timeframe: tf, entryTs: pos.entryTs, firstBarTs: c[0].ts };
      this.store.audit({ ts: ctx.now, type: "position.reversal_no_history", data });
      this.log.warn("足がエントリーより新しいため、この建玉は転換で決済を判定できません (損切り・利確などは従来どおり)", data);
    }
    if (!r.exit) return;
    const intended = pos.direction === "long" ? view.quote.bid : view.quote.ask;
    const risk = Math.abs(pos.entryPrice - pos.initialStop);
    const data = {
      tradeId: pos.id, symbol: inst.symbol, strategyId: pos.strategyId, direction: pos.direction, detail: reversalDetailLabel(pos.direction),
      timeframe: tf, primaryTimeframe: primaryTf, pivotN: this.reversal.pivotN, bufferAtr: this.reversal.bufferAtr,
      level: r.level, pivotTs: r.pivotTs, ...(r.fallback ? { fallback: true } : {}), close: r.close, barTs: r.barTs,
      ...(Number.isFinite(r.atr) ? { atr: r.atr } : {}), threshold: r.threshold, entryPrice: pos.entryPrice, entryTs: pos.entryTs,
      initialStop: pos.initialStop, ...(pos.takeProfit !== undefined ? { takeProfit: pos.takeProfit } : {}), intendedPrice: intended,
      // 判定した終値での値動きの R (手数料を含めない。含み益なら正)
      ...(risk > 0 ? { grossR: Number((((pos.direction === "long" ? 1 : -1) * (r.close - pos.entryPrice)) / risk).toFixed(4)) } : {}),
    };
    this.log.info(`転換で決済します (${data.detail})`, data);
    const res = await this.positions.close(inst.symbol, "reversal", intended, ctx.now);
    this.store.audit({ ts: ctx.now, type: "position.reversal_exit", data: { ...data, status: res.status, ...(res.reason ? { result: res.reason } : {}) } });
    // 発注レートの上限・決済の再試行待ちは発注していないので、次のティックで判定し直す
    if (res.status === "throttled") this.reversalEvalAt.delete(pos.id);
    if (res.status === "closed" || res.status === "reduced") {
      ctx.exits++;
      ctx.account = await this.account(ctx.now, true);
    }
  }

  private async enter(inst: Instrument, view: MarketView, c: Candidate, ctx: TickCtx): Promise<void> {
    const { now } = ctx;
    const q = view.quote;
    const sym = inst.symbol;
    const sig = c.signal;
    if (now - q.ts > this.opt.maxQuoteAgeMs) return this.skip("stale_quote");
    const rate = this.fx.toAccount(inst.quoteCurrency);
    if (!Number.isFinite(rate) || !(rate > 0)) {
      this.shadowRecord("fx_unknown", inst, view, c.strategy, sig, c.regime, now);
      return this.skip("fx_unknown", `${inst.quoteCurrency} → ${this.fx.baseCurrency}`);
    }
    if (this.mode === "live") {
      // live: 為替が概算表・古い気配・取れない場合は、その通貨に関わる新規エントリーをしない (決済・評価額の計算は続ける)
      const approx = fxApproxReason(this.fx, inst.quoteCurrency, this.fx.baseCurrency, now);
      if (approx) {
        this.shadowRecord("fx_approx", inst, view, c.strategy, sig, c.regime, now);
        return this.skip("fx_approx", `${sym}: 為替が不確か (${approx}) のため新規エントリーしません`);
      }
    }
    try {
      this.brokerFor(sym); // 発注先が無い銘柄はリスク判定の前に見送る
    } catch (e) {
      this.shadowRecord("no_broker", inst, view, c.strategy, sig, c.regime, now);
      return this.skip("no_broker", redactedErrMsg(e));
    }
    // ミームの流動性: Jupiter の銘柄はトークン情報の liquidity (定期的に取り直す)、それ以外は 24 時間の出来高からの推定
    const liquidityUsd = !enabledProfile(inst.assetClass)?.requiresLiquidityCheck
      ? undefined
      : this.marketExtras?.venues.includes(inst.venue)
        ? this.marketExtras.liquidityUsd(sym)
        : liquidityUsdFor(inst, view, (ccy) => this.fx.toUsd(ccy));
    const acct = ctx.account;
    // 値動きの予想: 実力が確かめられた (予想時間, 資産クラス) だけサイズを 0.7〜1.2 倍にする。
    // 上限は計画と同じ MAX_RISK_MULTIPLIER のまま。RiskManager の判定 (上限・停止) はそのまま通す
    const fm = this.forecastMultiplier(sym, sig, sig.horizon ?? c.strategy.horizon, now);
    const forecastApplied = fm !== undefined && fm.mult !== 1 && Number.isFinite(fm.mult) && fm.mult > 0;
    const forecastRiskMultiplier = forecastApplied ? Math.min(MAX_RISK_MULTIPLIER, c.riskMultiplier * fm!.mult) : c.riskMultiplier;
    // テンポの探索: コスト控除後の期待値が 0 以下のシグナル (テンポで下限を下げて通ったもの) はサイズを TEMPO_EXPLORE_SIZE 倍に絞り、
    // 取引に印 (features.tempoExplore = 1) を付ける。テンポのモードでなければ従来どおり
    const tempoExplore = ctx.tempo !== undefined && sig.edgeIsNet === true && sig.expectedEdgeBps <= 0;
    const riskMultiplier = tempoExplore ? forecastRiskMultiplier * this.tempoExploreSize : forecastRiskMultiplier;
    // 注文の種類 (指値なら価格を決め、RiskManager のサイズの計算にもその価格を使う)
    const limitPrice = this.entryOrderFor(c.strategy, sig, inst) === "limit" ? this.limitPriceFor(inst, sig, q) : undefined;
    const riskSignal: Signal = limitPrice !== undefined ? { ...sig, entry: { type: "limit", price: limitPrice } } : sig;
    const decision = this.risk.evaluateEntry({
      signal: riskSignal,
      instrument: inst,
      quote: q,
      equity: acct.equity,
      available: acct.available,
      positions: acct.positions,
      riskMultiplier,
      now,
      ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
      instruments: new Map(this.hub.watched().map((i) => [i.symbol, i])),
      prices: acct.prices,
      toAccount: (ccy) => this.fx.toAccount(ccy),
      // テンポのモードのときだけ渡す (コスト比の判定だけが変わる。無ければ従来どおり)
      ...(ctx.tempo ? { tempo: ctx.tempo.level, tempoExplore: ctx.tempo.explore } : {}),
      // Jupiter: 実際の代金でのコスト (固定手数料 / 代金 + 代金と流動性の価格影響) でも期待値を確かめる
      ...(this.marketExtras?.costBpsAt && this.marketExtras.venues.includes(inst.venue)
        ? { costBpsAt: (n: number) => this.marketExtras!.costBpsAt!(sym, n) }
        : {}),
    });
    if (!decision.ok) {
      const key = `risk: ${normalizeReason(decision.reason)}`;
      this.shadowRecord(key, inst, view, c.strategy, sig, c.regime, now);
      return this.skip(key, `${sym} ${c.strategy.id}: ${decision.reason}`);
    }

    const side = sig.direction === "long" ? "buy" : "sell";
    const intended = side === "buy" ? q.ask : q.bid;
    // 実際の代金でのコスト (Jupiter) があればそれを記録する (要因分析のコストもそろえる)
    const cost = decision.costBps ?? costBps(inst, q);
    const entryContext: EntryContext = {
      regime: c.regime,
      ...(c.intel ? { intel: c.intel } : {}),
      confidence: sig.confidence,
      expectedEdgeBps: sig.expectedEdgeBps,
      costBps: cost,
      params: { ...c.params },
      // テンポのモードでは、エントリー時のテンポ (tempoLevel) と探索の印 (tempoExplore = 1) を残す (report で分けて集計する)
      features: { ...sig.features, ...(ctx.tempo ? { tempoLevel: ctx.tempo.level, ...(tempoExplore ? { tempoExplore: 1 } : {}) } : {}) },
      riskMultiplier,
      reason: sig.reason,
    };
    const broker = this.brokerFor(sym);
    const postOnly = limitPrice !== undefined && broker.capabilities?.postOnly === true;
    const req: OrderRequest =
      limitPrice !== undefined
        ? {
            clientId: this.positions.newClientId("e", now),
            symbol: sym,
            side,
            type: "limit",
            qty: decision.qty,
            limitPrice,
            tif: "GTC",
            ...(postOnly ? { postOnly: true } : {}),
            strategyId: c.strategy.id,
            // 取引所側の保護ストップ (成行と同じく渡す。対応するアダプターだけが付ける。いまの発注先 (paper) は付けない。
            // 損切りの判定はエンジン側で続ける)
            protectiveStop: sig.stopLoss,
          }
        : {
            clientId: this.positions.newClientId("e", now),
            symbol: sym,
            side,
            type: "market",
            qty: decision.qty,
            strategyId: c.strategy.id,
            // 取引所側の保護ストップ (対応するアダプターだけが付ける。プロセス停止時の保険)
            protectiveStop: sig.stopLoss,
          };
    const limit: PendingLimit | undefined =
      limitPrice !== undefined
        ? {
            price: limitPrice,
            expiresAt: now + this.limitTimeoutMs(c.strategy),
            ...(postOnly ? { postOnly: true } : {}),
            stopLoss: sig.stopLoss,
            direction: sig.direction === "long" ? "long" : "short",
            shadow: { signal: { ...sig, horizon: sig.horizon ?? c.strategy.horizon }, quote: { bid: q.bid, ask: q.ask }, regime: c.regime.label, signalTs: now },
          }
        : undefined;
    const entry: PendingEntry = {
      input: {
        mode: this.mode,
        symbol: sym,
        venue: inst.venue,
        assetClass: inst.assetClass,
        strategyId: c.strategy.id,
        horizon: sig.horizon,
        direction: sig.direction === "long" ? "long" : "short",
        // paper で再現した空売り (取引所では空売りできない現物)。TradeRecord に引き継ぎ、学習・表示を買いと分ける
        ...(isSimulatedShort(inst, this.mode, sig.direction) ? { simulatedShort: true } : {}),
        entryTs: now,
        intendedEntryPrice: intended,
        initialStop: sig.stopLoss,
        ...(sig.takeProfit !== undefined ? { takeProfit: sig.takeProfit } : {}),
        entryContext,
        ...(inst.contractSize !== undefined ? { contractSize: inst.contractSize } : {}),
        entryOrderType: limit ? "limit" : "market",
      },
      plan: {
        ...(sig.trailingStopPct !== undefined ? { trailingStopPct: sig.trailingStopPct } : {}),
        ...(sig.maxHoldMs !== undefined ? { maxHoldMs: sig.maxHoldMs } : {}),
        ...(sig.expectedMs !== undefined && sig.expectedMs > 0 ? { expectedMs: sig.expectedMs } : {}),
      },
      audit: {
        direction: sig.direction,
        ...(isSimulatedShort(inst, this.mode, sig.direction) ? { simulatedShort: true } : {}),
        intendedPrice: intended,
        ...(limit ? { orderType: "limit", limitPrice: limit.price, expiresAt: limit.expiresAt, postOnly: limit.postOnly === true } : { orderType: "market" }),
        stop: sig.stopLoss,
        ...(sig.takeProfit !== undefined ? { takeProfit: sig.takeProfit } : {}),
        confidence: Number(sig.confidence.toFixed(3)),
        expectedEdgeBps: Number(sig.expectedEdgeBps.toFixed(1)),
        costBps: Number(cost.toFixed(1)),
        armWeight: Number(c.armWeight.toFixed(3)),
        riskMultiplier: Number(riskMultiplier.toFixed(3)),
        ...(forecastApplied
          ? { forecast: { horizon: fm!.horizon, direction: fm!.direction, pUp: Number((fm!.pUp ?? 0.5).toFixed(3)), mult: Number(fm!.mult.toFixed(3)), baseRiskMultiplier: Number(c.riskMultiplier.toFixed(3)) } }
          : {}),
        regime: c.regime.label,
        ...(ctx.tempo
          ? { tempo: { level: Number(ctx.tempo.level.toFixed(3)), ...(tempoExplore ? { explore: true, exploreSize: this.tempoExploreSize } : {}) } }
          : {}),
        ...(c.intel ? { intel: { sentiment: Number(c.intel.sentiment.toFixed(3)), confidence: Number(c.intel.confidence.toFixed(3)) } } : {}),
        ...(liquidityUsd !== undefined ? { liquidityUsd: Math.round(liquidityUsd) } : {}),
        reason: sig.reason,
        notes: decision.notes,
      },
    };
    let r: EntryResult;
    try {
      r = await this.positions.enter(req, entry, now, limit);
    } catch (e) {
      const msg = redactedErrMsg(e);
      this.log.error("エントリーの処理に失敗", { symbol: sym, error: msg });
      this.store.audit({ ts: now, type: "engine.order_error", data: { symbol: sym, strategyId: c.strategy.id, error: msg } });
      return this.skip("order_error", msg);
    }
    if (r.status === "opened") {
      ctx.entries++;
      // 値動きの予想: シグナルと同じ向きで発注に使われた予想を記録する (LIVE でなくても記録。LIVE 判定で「適用した予想の成績」を見るため)
      // 再現した空売りは「適用した予想」に数えない (LIVE 判定の applied は live でも起こりうる発注での的中を見るため)
      if (fm && sig.direction !== "flat" && !isSimulatedShort(inst, this.mode, sig.direction)) {
        try {
          this.forecast?.markApplied(sym, sig.direction, sig.horizon ?? c.strategy.horizon, now);
        } catch {
          // 学習用の記録だけなので無視する
        }
      }
      if (r.position) {
        try {
          await this.positions.placeTakeProfit(r.position, q, now);
        } catch (e) {
          this.log.warn("利確の指値の発注に失敗 (次のティックで再試行)", { symbol: sym, error: redactedErrMsg(e) });
        }
      }
      this.saveSnapshot();
      ctx.account = await this.account(now, true);
      return;
    }
    if (r.status === "pending") {
      // 保留中のエントリーを想定代金で口座情報に加え、同じティックの後続の銘柄のリスク判定に反映する
      ctx.account = await this.account(now);
      if (limit) return this.skip("limit_placed", `${sym}: 指値 ${limit.price} で約定待ち (期限 ${new Date(limit.expiresAt).toISOString()})`);
      return this.skip("order_pending", `${sym}: ${r.reason ?? "未確定"}`);
    }
    this.acctCache = undefined;
    // ブローカーが受け付けなかった (発注されていない) ものは仮想トレードとして答え合わせする
    this.shadowRecord("order_rejected", inst, view, c.strategy, sig, c.regime, now);
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
        // 計画は乱数を使わない決定的な重み (無効化中の腕は 0 → armDisabled)。探索はエントリー時だけ
        armWeights[armKey(s.id, r.label, inst.assetClass)] = this.learning.armPlanWeight(s.id, r.label, inst.assetClass);
      }
    }
    return buildStrategyPlan({
      brief,
      instruments,
      regimes,
      strategies: [...this.strategies],
      armWeights,
      // 片側バイアスも戦略へ渡す情報バイアスと同じく情報の効き具合で補正する
      intelInfluence: this.learning.intelInfluences(),
      lessons: this.store.listLessons({ status: "active", limit: 50 }),
      now,
      mode: this.mode,
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
      this.newsIngest(now);
      const plan = await this.buildPlan(brief, now);
      if (this.stopped) return undefined;
      this.store.savePlan(plan);
      const active = Object.values(plan.perSymbol).filter((p) => p.enabledStrategies.length > 0).length;
      this.store.audit({ ts: now, type: "engine.plan", data: { activeSymbols: active, blackouts: plan.blackouts.length, riskOn: brief.riskOn, stubBrief: brief.stub } });
      return plan;
    } catch (e) {
      const msg = redactedErrMsg(e);
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
      const msg = redactedErrMsg(e);
      this.log.warn("学習ループに失敗 (取引は継続)", { error: msg });
      if (!this.stopped) this.store.audit({ ts: now, type: "engine.learning_error", data: { error: msg } });
      return undefined;
    }
  }

  // ───────── 定期の処理・監視銘柄の追加と削除 ─────────

  /** 定期の処理を 1 つ実行する (同じ処理の重複は避ける。失敗はログだけ) */
  async runPeriodic(task: PeriodicTask, now: number = this.clock.now()): Promise<void> {
    if (this.stopped || this.periodicRunning.has(task.name)) return;
    this.periodicRunning.add(task.name);
    this.periodicAt.set(task.name, now);
    const p = (async () => {
      try {
        await task.run(now);
      } catch (e) {
        this.warnThrottled(`periodic:${task.name}`, now, `定期の処理 (${task.name}) に失敗 (取引は継続)`, { error: redactedErrMsg(e) });
      }
    })();
    this.background.add(p);
    try {
      await p;
    } finally {
      this.background.delete(p);
      this.periodicRunning.delete(task.name);
    }
  }

  /** 期限が来た定期の処理を順に実行する (シミュレーション・テスト用。実時間は start のタイマー) */
  async runDuePeriodic(now: number = this.clock.now()): Promise<void> {
    for (const t of this.periodic) {
      const last = this.periodicAt.get(t.name);
      if (last === undefined || now - last >= t.everyMs) await this.runPeriodic(t, now);
    }
  }

  /**
   * 実行中に監視銘柄を加える (Jupiter の自動探索)。hub に feed つきで登録し、PaperBroker にも銘柄定義を渡す。
   * 既にあれば false
   */
  watchInstrument(inst: Instrument, feed: MarketDataFeed): boolean {
    if (this.hub.instrument(inst.symbol)) return false;
    this.hub.watch(inst, feed);
    this.brokerSet.paper?.addInstrument(inst);
    // 監査ログは呼び出し側 (Jupiter の自動探索の jupiter.watch_add) が残す
    return true;
  }

  /**
   * 実行中に監視銘柄を外す。建玉・保留中の注文・利確の指値・仮想トレードの追跡中の銘柄は外さない (false)。
   * PaperBroker の銘柄定義は残す (スナップショット・過去の約定の評価のため)
   */
  unwatchInstrument(symbol: string): boolean {
    if (!this.hub.instrument(symbol)) return true;
    if (this.positions.get(symbol) || this.positions.hasPending(symbol) || this.positions.hasOrphanTakeProfit(symbol)) return false;
    if (!this.hub.unwatch(symbol)) return false;
    for (const k of [...this.lastEval.keys()]) if (k.startsWith(`${symbol}|`)) this.lastEval.delete(k);
    // 監査ログは呼び出し側 (jupiter.watch_remove) が残す
    return true;
  }

  /** 保有中・保留中の注文のある銘柄 (自動探索で外さない) */
  heldSymbols(): string[] {
    return [...new Set([...this.positions.list().map((p) => p.symbol), ...this.positions.pendingOrders().map((o) => o.symbol)])];
  }

  // ───────── シミュレーション・実時間ループ ─────────

  /** シミュレーション用: tick に加えて、期限が来た情報ループ・学習ループを順に実行する */
  async advance(now: number): Promise<TickResult> {
    const r = await this.tick(now);
    if (this.lastIntelAt === undefined || now - this.lastIntelAt >= this.opt.intelEveryMs) await this.runIntel(now);
    if (this.lastLearnAt === undefined) this.lastLearnAt = now;
    else if (now - this.lastLearnAt >= this.opt.learnEveryMs) await this.runLearning(now);
    await this.runDuePeriodic(now);
    return r;
  }

  private async safeTick(): Promise<void> {
    if (this.inflight) return; // 前のティックが終わっていなければ飛ばす
    try {
      await this.tick(this.clock.now());
    } catch (e) {
      this.log.error("ティックの処理に失敗", { error: redactedErrMsg(e) });
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
    for (const t of this.periodic) {
      void this.runPeriodic(t, this.clock.now());
      this.timers.push(setInterval(() => void this.runPeriodic(t, this.clock.now()), Math.max(1_000, t.everyMs)));
    }
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
      this.log.warn("停止時の評価額の保存に失敗", { error: redactedErrMsg(e) });
    }
    this.saveSnapshot();
    this.flushSkips(now);
    try {
      this.shadow?.flush();
    } catch (e) {
      this.log.warn("停止時の仮想トレードの保存に失敗", { error: redactedErrMsg(e) });
    }
    try {
      this.forecast?.flush();
    } catch (e) {
      this.log.warn("停止時の予想の保存に失敗", { error: redactedErrMsg(e) });
    }
    this.store.audit({ ts: now, type: "engine.stop", data: { openPositions: this.journal.list().length, pendingOrders: this.positions.pending.size } });
  }

  // ───────── 状態 (ダッシュボード) ─────────

  /** ブリーフの集計対象期間の情報 → 件数と見出し (ブリーフごとに 1 回だけ計算する) */
  private briefHeadlinesFor(generatedAt: number): BriefHeadlines {
    if (this.headlineCache?.key === generatedAt) return this.headlineCache.value;
    const items = this.store.listIntel({ since: generatedAt - BRIEF_LOOKBACK_MS, limit: 1000 });
    const value = briefHeadlines(items);
    this.headlineCache = { key: generatedAt, value };
    return value;
  }

  async status(): Promise<EngineStatus> {
    const now = this.clock.now();
    const acct = await this.account(now);
    const rs = this.risk.state();
    const halted = this.risk.isHalted(now);
    const paperM = this.brokerSet.paper?.markToMarket();
    const positions: PositionStatus[] = this.positions.list().map((p) => {
      const inst = this.hub.instrument(p.symbol);
      const q = this.hub.latestQuote(p.symbol);
      const last = q ? quoteMid(q) : p.lastPrice;
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
        ...((() => {
          const th = this.positions.thesisView(p, q, now);
          return th ? { thesis: th } : {};
        })()),
      };
    });
    const plan = this.store.latestPlan();
    const brief = this.store.latestBrief();
    // paper の口座リセット (paper reset) 以降だけを成績・推移に使う (当初の評価額もリセット後の評価額)
    const paperReset = this.mode === "paper" ? latestPaperReset(this.store) : undefined;
    const eq = equitySinceReset(this.store.listEquity({ since: now - 7 * 86_400_000, mode: this.mode }), paperReset);
    return {
      now,
      mode: this.mode,
      ...(this.config.liveBlockedReason ? { liveBlockedReason: this.config.liveBlockedReason } : {}),
      baseCurrency: this.config.env.BASE_CURRENCY,
      watched: this.hub.watched().map((i) => ({
        symbol: i.symbol, venue: i.venue, assetClass: i.assetClass,
        ...((() => {
          const q = this.hub.latestQuote(i.symbol);
          const px = q ? quoteMid(q) : NaN;
          return Number.isFinite(px) && px > 0 ? { lastPrice: px } : {};
        })()),
        ...(this.hub.lastError(i.symbol) ? { lastError: redactSecrets(this.hub.lastError(i.symbol)!) } : {}),
        ...((() => {
          const f = this.forecast?.statusFor(i.symbol, now);
          return f ? { forecast: f } : {};
        })()),
      })),
      equity: {
        current: acct.equity,
        initial: this.mode === "paper" ? (paperReset?.toEquity ?? this.config.env.PAPER_INITIAL_EQUITY) : (eq[0]?.equity ?? acct.equity),
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
        // 実効値 (.env + ダッシュボードの上書き)。RiskManager の判定に使っている値を表示する
        limits: this.risk.limits,
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
              biases: (() => {
                // 監視銘柄の資産は信頼度に関係なく必ず含め、残りは信頼度の高い順に上位を出す (ダッシュボードの強気・弱気の表示用)
                const watchedAssets = new Set(this.hub.watched().map((i) => i.baseCurrency.toUpperCase()));
                const all = Object.values(brief.biases).sort((a, b) => b.confidence - a.confidence);
                const picked = [...all.filter((b) => watchedAssets.has(b.asset.toUpperCase())), ...all.filter((b) => !watchedAssets.has(b.asset.toUpperCase())).slice(0, 20)];
                return picked.map((b) => ({
                  asset: b.asset, sentiment: b.sentiment, confidence: b.confidence, eventRisk: b.eventRisk,
                  ...(b.blackoutUntil !== undefined && b.blackoutUntil > now ? { blackoutUntil: b.blackoutUntil } : {}),
                }));
              })(),
              events: brief.events
                .filter((e) => e.ts >= now - 3_600_000)
                .sort((a, b) => a.ts - b.ts)
                .slice(0, 10)
                .map((e) => ({ ts: e.ts, title: e.title, ...(e.currency ? { currency: e.currency } : {}), impact: e.impact })),
              ...this.briefHeadlinesFor(brief.generatedAt),
            },
          }
        : {}),
      equityHistory: downsample(eq.map((p) => ({ ts: p.ts, equity: p.equity })), 300),
      ...(this.lastTickAt !== undefined ? { lastTickAt: this.lastTickAt } : {}),
      tickCount: this.tickCount,
      tickMs: this.opt.tickMs,
      account: (() => {
        const fxApprox = this.fxApproxList(now, acct);
        return {
          ...(acct.incomplete ? { incomplete: true } : {}),
          ...(acct.missing?.length ? { missing: [...acct.missing] } : {}),
          ...(acct.degradedReason ? { degradedReason: redactSecrets(acct.degradedReason) } : {}),
          ...(fxApprox.length ? { fxApprox } : {}),
        };
      })(),
      tempo: this.tempoStatus(now),
      maxHoldMinutes: this.maxHoldMs !== undefined ? this.maxHoldMs / 60_000 : 0,
      thesis: { ...this.thesis },
      reversal: { ...this.reversal, strategies: [...this.reversal.strategies] },
      limitOrders: {
        limitEntry: this.config.env.LIMIT_ENTRY ?? true,
        limitTakeProfit: effectiveLimitTakeProfit(this.config.env, this.mode),
        stats: readLimitStats(this.store, this.mode),
        pendingEntries: this.positions
          .pendingOrders()
          .filter((o) => o.kind === "entry" && o.limit)
          .map((o) => ({
            symbol: o.symbol, clientId: o.clientId, price: o.limit!.price, expiresAt: o.limit!.expiresAt,
            ...(o.limit!.cancelReason ? { cancelReason: o.limit!.cancelReason } : {}),
          })),
        restingTakeProfits: this.positions.restingTakeProfits().map((t) => ({
          symbol: t.symbol, tradeId: t.tradeId, price: t.price, qty: t.qty, filledQty: t.appliedQty, status: t.status, ...(t.exit ? { exiting: t.exit.reason } : {}),
        })),
      },
    };
  }

  /** ダッシュボード・status 用のテンポの状態 (テンポのモードでなければ enabled: false) */
  tempoStatus(now: number = this.clock.now()): TempoStatusView {
    return tempoStatusView(this.tempo, now, this.tempoExploreAllowed);
  }

  /**
   * live: 概算表・古い気配で換算している通貨 (口座残高の通貨・監視銘柄と保有銘柄のクオート通貨)。paper は空
   * (paper は従来どおり概算表で換算し、新規エントリーも止めない)
   */
  private fxApproxList(now: number, acct: AccountState): string[] {
    if (this.mode !== "live") return [];
    const out = new Set(acct.fxApprox ?? []);
    const ccys = new Set<string>();
    for (const i of this.hub.watched()) if (i.quoteCurrency) ccys.add(normalizeCurrency(i.quoteCurrency));
    for (const p of this.positions.list()) {
      const c = this.hub.instrument(p.symbol)?.quoteCurrency;
      if (c) ccys.add(normalizeCurrency(c));
    }
    for (const c of ccys) {
      const r = fxApproxReason(this.fx, c, this.fx.baseCurrency, now);
      if (r) out.add(r);
    }
    return [...out];
  }
}
