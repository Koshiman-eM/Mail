/**
 * 全モジュール共通の型定義 (契約)。
 *
 * 数値の扱い:
 * - 指標・統計・シグナル計算は number (浮動小数点) でよい。
 * - 残高・約定・手数料・損益などの会計値は decimal.js で計算し、境界では number に変換して保持する
 *   (`src/core/decimal.ts` のヘルパーを使う)。
 *
 * 時刻はすべて UNIX ミリ秒 (number)。
 */

// ───────────────────────── 基本列挙 ─────────────────────────

export type AssetClass = "crypto" | "meme" | "fx" | "stock";
/** トレードの時間軸。scalp と short をメインに据える */
export type Horizon = "scalp" | "short" | "mid" | "long";
export type Side = "buy" | "sell";
/** flat はポジション解消 (エグジット) シグナル */
export type Direction = "long" | "short" | "flat";
export type Timeframe = "1s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";
export type TradingMode = "paper" | "live" | "backtest";

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1s": 1_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

// ───────────────────────── 銘柄・市場データ ─────────────────────────

export interface Instrument {
  /** 統一シンボル。例: "BTC/USDT", "USD/JPY", "AAPL", "BONK/SOL" */
  symbol: string;
  /** 取引先。例: "paper", "ccxt:bitflyer", "oanda", "alpaca", "dex:solana" */
  venue: string;
  assetClass: AssetClass;
  baseCurrency: string;
  quoteCurrency: string;
  /** 価格の最小刻み */
  tickSize: number;
  /** 数量の最小刻み */
  lotSize: number;
  minQty: number;
  minNotional?: number;
  /** 手数料率 (0.001 = 0.1%) */
  takerFeeRate: number;
  makerFeeRate: number;
  /** 空売り (ショート) 可能か */
  allowShort: boolean;
  /** 1 単位あたりの契約サイズ (FX/先物用。現物は 1) */
  contractSize?: number;
  /** 取引先固有の情報 (DEX のペアアドレス、流動性 USD など) */
  meta?: Record<string, string | number>;
}

export interface Candle {
  /** 足の開始時刻 */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  ts: number;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  last?: number;
}

export interface OrderBook {
  ts: number;
  /** 価格降順 [price, size] */
  bids: [number, number][];
  /** 価格昇順 [price, size] */
  asks: [number, number][];
}

export interface TradePrint {
  ts: number;
  price: number;
  size: number;
  /** 約定の主導側 (taker side) */
  side: Side;
}

/** 戦略へ渡す時点の市場情報。candles は確定足のみ・昇順 (末尾が直近の確定足) */
export interface MarketView {
  instrument: Instrument;
  now: number;
  quote: Quote;
  book?: OrderBook;
  /** 直近の約定履歴 (スキャルピング用、昇順) */
  prints?: TradePrint[];
  candles: Partial<Record<Timeframe, Candle[]>>;
}

// ───────────────────────── レジーム (相場環境) ─────────────────────────

export type RegimeLabel = "trend_up" | "trend_down" | "range" | "high_vol" | "low_liquidity";

export interface RegimeFeatures {
  label: RegimeLabel;
  /** -1 (強い下降) 〜 1 (強い上昇) */
  trend: number;
  /** ADX 相当 0〜100 */
  trendStrength: number;
  /** ATR / 価格 (例: 0.012 = 1.2%) */
  volatility: number;
  /** 過去分布に対するボラティリティのパーセンタイル 0〜1 */
  volatilityPercentile: number;
  spreadBps: number;
}

// ───────────────────────── 情報収集 (インテル) ─────────────────────────

export type IntelKind = "news" | "social" | "metric" | "calendar" | "trending";

export interface IntelItem {
  /** 安定 ID (source + URL/ID のハッシュ等)。重複排除に使う */
  id: string;
  /** 情報源 ID。例: "rss:coindesk", "fng:alternative.me", "dexscreener", "calendar:ff" */
  source: string;
  kind: IntelKind;
  title: string;
  summary?: string;
  url?: string;
  publishedAt: number;
  fetchedAt: number;
  /** 関連資産 (正規化済み)。例: ["BTC", "ETH"], ["USD", "JPY"], ["AAPL"] */
  assets: string[];
  /** -1 (弱気) 〜 1 (強気)。未分析なら undefined */
  sentiment?: number;
  /** 0〜1 */
  importance?: number;
  /** 数値指標 (Fear&Greed 値, 出来高急増率など) */
  metrics?: Record<string, number>;
}

/** 経済指標・イベント (ブラックアウト判定に使う) */
export interface EconEvent {
  ts: number;
  title: string;
  currency?: string;
  impact: "low" | "medium" | "high";
  source: string;
}

/** 資産ごとの情報バイアス。戦略・アロケーターへ渡す */
export interface IntelBias {
  asset: string;
  /** -1〜1 */
  sentiment: number;
  /** 0〜1 */
  confidence: number;
  /** 0〜1 (直近の重要イベントの近さ・大きさ) */
  eventRisk: number;
  /** 重要イベント前後で新規エントリーを止める期限 */
  blackoutUntil?: number;
  /** 判断に使った IntelItem.id (学習で情報源の信頼度を更新するのに使う) */
  sourceIds: string[];
  /** 判断に使った情報源 ID ごとの寄与 (-1〜1)。情報源信頼度の学習に使う */
  sourceContrib: Record<string, number>;
  notes?: string;
}

export interface MarketBrief {
  generatedAt: number;
  /** -1 (リスクオフ) 〜 1 (リスクオン) */
  riskOn: number;
  summary: string;
  biases: Record<string, IntelBias>;
  /** ミームコイン等の新規監視候補 (統一シンボル) */
  watchlist: string[];
  events: EconEvent[];
  /** LLM を使わずに作ったか */
  stub: boolean;
}

export interface SymbolPlan {
  symbol: string;
  enabledStrategies: string[];
  directionBias: "long" | "short" | "both";
  /** 0〜1.5。リスク予算に掛ける倍率 */
  riskMultiplier: number;
  notes?: string;
}

export interface StrategyPlan {
  generatedAt: number;
  validUntil: number;
  perSymbol: Record<string, SymbolPlan>;
  blackouts: { start: number; end: number; assetClasses: AssetClass[]; reason: string }[];
  rationale: string;
}

// ───────────────────────── 戦略 ─────────────────────────

/**
 * 戦略パラメータ。学習 (tuner) が自動調整できるよう、該当する場合は次の標準名を使う:
 * - stopAtr: 損切り幅 (ATR の倍数)
 * - tpAtr: 利確幅 (ATR の倍数)
 * - trailAtr: トレーリング幅 (ATR の倍数, 0 なら無効)
 * - entryThreshold: エントリー閾値 (大きいほど厳選)
 * - maxHoldBars: 最大保有本数 (主時間足)
 */
export type Params = Record<string, number>;

export interface PositionView {
  symbol: string;
  /** 符号付き数量 (ロング +, ショート -) */
  qty: number;
  avgPrice: number;
  openedAt: number;
  strategyId: string;
  stopLoss: number;
  takeProfit?: number;
  /** 保有中の最高値・最安値 (トレーリング用) */
  highWater: number;
  lowWater: number;
}

export interface StrategyContext {
  market: MarketView;
  regime: RegimeFeatures;
  intel?: IntelBias;
  /** この戦略が持っているポジション (なければ undefined) */
  position?: PositionView;
  params: Params;
}

export interface Signal {
  strategyId: string;
  horizon: Horizon;
  symbol: string;
  direction: Direction;
  /** 0〜1 */
  confidence: number;
  /** 期待される値幅 (手数料控除前, bps)。手数料・スプレッドとの比較に使う */
  expectedEdgeBps: number;
  entry: { type: "market" | "limit"; price?: number };
  /** エントリー時の損切り価格 (flat の場合は 0 でよい) */
  stopLoss: number;
  takeProfit?: number;
  /** トレーリングストップ幅 (0.01 = 1%) */
  trailingStopPct?: number;
  /** 最大保有時間 */
  maxHoldMs: number;
  reason: string;
  /** 学習用の特徴量 (判断に使った指標値) */
  features: Record<string, number>;
}

export interface Strategy {
  id: string;
  horizon: Horizon;
  assetClasses: AssetClass[];
  /** この戦略が適するレジーム (計画・要因分析で使う) */
  regimes: RegimeLabel[];
  /** 板情報が必須か (板がない場合は evaluate が null を返す) */
  requiresBook?: boolean;
  /** 主時間足 */
  primaryTimeframe: Timeframe;
  /** 必要な時間足 */
  timeframes: Timeframe[];
  /** 判定に必要な最小本数 (主時間足) */
  warmup: number;
  defaultParams: Params;
  /** 学習による自動調整の上下限 */
  paramBounds: Record<string, [number, number]>;
  /** 純粋関数。副作用なし・同じ入力なら同じ出力 */
  evaluate(ctx: StrategyContext): Signal | null;
}

// ───────────────────────── 発注・約定 ─────────────────────────

export type OrderType = "market" | "limit";
export type TimeInForce = "GTC" | "IOC" | "FOK";
export type OrderStatus = "open" | "partially_filled" | "filled" | "canceled" | "rejected";

export interface OrderRequest {
  /** 冪等キー */
  clientId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  /** 数量 (decimal 文字列) */
  qty: string;
  limitPrice?: number;
  tif?: TimeInForce;
  reduceOnly?: boolean;
  strategyId: string;
  /**
   * 取引所側に置く保護用ストップ価格 (対応アダプターのみ。エンジン側の損切りが主で、これはプロセス停止時の保険)。
   * 決済時に取引所側で自動的に取り消されることが保証できるアダプターだけが付ける。
   */
  protectiveStop?: number;
}

export interface Fill {
  orderId: string;
  clientId: string;
  ts: number;
  price: number;
  /**
   * 実際に増減した数量 (decimal 文字列)。手数料がベース通貨で差し引かれた場合は差し引き後の数量
   * (アダプターが補正する)。
   */
  qty: string;
  /**
   * 手数料 (decimal 文字列)。feeCurrency が無ければクオート通貨建て。
   * アダプターは可能ならクオート通貨建てへ換算して feeCurrency を省く。
   * 換算できない通貨 (BNB、口座通貨など) のときだけ feeCurrency を付け、エンジンが為替換算する。
   */
  fee: string;
  feeCurrency?: string;
  liquidity: "maker" | "taker";
}

/**
 * 発注結果。status が "open" / "partially_filled" の注文は「保留中」として扱い、
 * Broker.getOrder で確定させてから建玉管理 (journal) に反映する (未約定を不成立とみなして再送しない)。
 */
export interface OrderResult {
  orderId: string;
  clientId: string;
  status: OrderStatus;
  /** これまでの全約定 (getOrder の結果では累計) */
  fills: Fill[];
  reason?: string;
}

export interface Balance {
  /** 口座通貨 (例: "JPY", "USDT", "USD") */
  currency: string;
  /** 評価額 (decimal 文字列) */
  equity: string;
  /** 余力 (decimal 文字列) */
  available: string;
}

export interface BrokerPosition {
  symbol: string;
  /** 符号付き数量 (decimal 文字列) */
  qty: string;
  avgPrice: number;
}

/** 発注先。ペーパーと実口座で同じインターフェース */
export interface Broker {
  readonly venue: string;
  readonly mode: "paper" | "live";
  getBalance(): Promise<Balance>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string, symbol: string): Promise<void>;
  /**
   * 注文の最新状態 (累計の約定を含む)。clientId で照会し、取引所が clientId 照会に未対応なら orderId を使う。
   * orderId も無い (発注が例外で終わった) 場合、hint (発注時刻・売買方向・数量) で注文一覧と突き合わせてよい
   * (候補がちょうど 1 件のときだけ採用する)。
   * undefined は「取引所がその注文は無いと答えた」ときだけ。照会できない・通信に失敗したときは例外を投げる。
   */
  getOrder(clientId: string, symbol: string, orderId?: string, hint?: OrderLookupHint): Promise<OrderResult | undefined>;
}

/** clientId で照会できない取引所向けの手がかり (エンジンの保留中の注文から渡す) */
export interface OrderLookupHint {
  /** 発注した時刻 (エンジンの時計、ミリ秒) */
  createdAt: number;
  side: Side;
  /** 発注数量 (decimal 文字列) */
  qty: string;
}

/** 市場データの取得元 */
export interface MarketDataFeed {
  readonly venue: string;
  listInstruments(): Promise<Instrument[]>;
  fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]>;
  fetchQuote(symbol: string): Promise<Quote>;
  fetchOrderBook?(symbol: string, depth?: number): Promise<OrderBook>;
  fetchPrints?(symbol: string, limit?: number): Promise<TradePrint[]>;
}

// ───────────────────────── リスク ─────────────────────────

export interface RiskLimits {
  /** 1 トレードで許容する損失 (口座評価額比, 0.005 = 0.5%) */
  riskPerTrade: number;
  /** 日次損失上限 (到達で当日停止) */
  maxDailyLoss: number;
  /** 最大ドローダウン (到達で手動再開まで停止) */
  maxDrawdown: number;
  maxOpenPositions: number;
  /** 資産クラス別の最大エクスポージャー (評価額比) */
  maxExposureByClass: Record<AssetClass, number>;
  /** 1 銘柄あたりの最大ポジション (評価額比) */
  maxPositionPct: number;
  /** 1 分あたりの最大発注数 */
  maxOrdersPerMinute: number;
  /** 期待値幅が (手数料+スプレッド) の何倍以上でないと入らないか */
  minEdgeToCostRatio: number;
  /** ミームコインの最低流動性 (USD) */
  memeMinLiquidityUsd: number;
}

export type RiskDecision =
  | { ok: true; qty: string; notes: string[] }
  | { ok: false; reason: string };

export interface RiskState {
  dayStartEquity: number;
  peakEquity: number;
  /** 当日停止 (日次損失上限) */
  haltedUntil?: number;
  /** 手動再開が必要な停止 (最大 DD・異常検知) */
  killSwitch?: { at: number; reason: string };
  recentOrderTs: number[];
}

// ───────────────────────── 学習 (トレード記録・要因分析) ─────────────────────────

export type ExitReason = "stop" | "take_profit" | "trailing" | "signal" | "time" | "kill_switch" | "manual";

export interface EntryContext {
  regime: RegimeFeatures;
  intel?: IntelBias;
  confidence: number;
  expectedEdgeBps: number;
  /** エントリー時のコスト見積り (手数料往復 + スプレッド, bps) */
  costBps: number;
  params: Params;
  features: Record<string, number>;
  /** 計画上のリスク倍率 */
  riskMultiplier: number;
  reason: string;
}

export interface TradeRecord {
  id: string;
  mode: TradingMode;
  symbol: string;
  venue: string;
  assetClass: AssetClass;
  strategyId: string;
  horizon: Horizon;
  direction: "long" | "short";
  qty: number;
  entryTs: number;
  entryPrice: number;
  /** シグナル時点の想定価格 (スリッページ計測用) */
  intendedEntryPrice: number;
  exitTs: number;
  exitPrice: number;
  intendedExitPrice: number;
  initialStop: number;
  takeProfit?: number;
  /** 損益はクオート通貨建て */
  grossPnl: number;
  fees: number;
  netPnl: number;
  /** 純損益 / 建玉額 */
  returnPct: number;
  /** 純損益 / 当初リスク額 */
  rMultiple: number;
  /** 保有中の最大含み益・最大含み損 (エントリー価格比, 正の値) */
  mfePct: number;
  maePct: number;
  exitReason: ExitReason;
  entryContext: EntryContext;
  /** エグジット後一定時間の値動き (方向付き, エントリー方向に有利なら正)。後から埋める */
  postExitMovePct?: number;
  /**
   * 約定を確認できず、建玉の照会や手動の申告から数量・価格を推定した部分を含む (学習には渡さない)。
   * 推定の価格は照会時点の現在値など
   */
  estimated?: boolean;
}

export type CauseCode =
  | "wrong_direction" // 方向感の誤り
  | "stop_too_tight" // 損切りが近すぎ (刈られた後に戻った)
  | "late_exit" // 利益を取り逃がした (MFE を大きく吐き出した)
  | "early_exit" // 早すぎる利確 (エグジット後も伸びた)
  | "fee_drag" // 手数料・スプレッド負け
  | "slippage" // 約定ずれ
  | "regime_mismatch" // 戦略とレジームの不一致
  | "news_shock" // 突発ニュース・イベント
  | "intel_misled" // 情報バイアスが逆だった
  | "time_decay" // 時間切れ (動かなかった)
  | "good_process"; // 判断は妥当 (運による損失 or 計画通りの利益)

export interface Cause {
  code: CauseCode;
  /** 0〜1 (複数要因の寄与度) */
  weight: number;
  evidence: string;
}

export interface TradeAttribution {
  tradeId: string;
  outcome: "win" | "loss" | "breakeven";
  causes: Cause[];
  createdAt: number;
}

export interface ParamAdjustment {
  id: string;
  strategyId: string;
  /** 調整のスコープ (資産クラス単位) */
  assetClass: AssetClass;
  param: string;
  from: number;
  to: number;
  reason: string;
  /** バックテスト等で検証した結果 */
  validation?: { baselineScore: number; candidateScore: number; trades: number };
  status: "proposed" | "applied" | "rejected" | "reverted";
  createdAt: number;
}

export interface Lesson {
  id: string;
  createdAt: number;
  /** 例: "strategy:scalp_obi", "assetClass:meme", "global" */
  scope: string;
  text: string;
  evidence: string;
  /** LLM 由来か、ルール由来か */
  origin: "llm" | "rule";
  status: "active" | "retired";
}

/** 戦略×レジーム×資産クラス ごとの成績 (アロケーター用) */
export interface ArmStats {
  key: string;
  /** ベータ分布 (勝率) */
  alpha: number;
  beta: number;
  n: number;
  sumR: number;
  sumR2: number;
  /** 指数加重平均 R */
  ewmaR: number;
  updatedAt: number;
}

/** 情報源の信頼度 (情報バイアスとその後の値動きの一致度) */
export interface SourceReliability {
  source: string;
  n: number;
  hits: number;
  /** 指数加重の的中度 -1〜1 */
  ewmaScore: number;
  /** 現在の重み 0〜2 (1 が中立) */
  weight: number;
  updatedAt: number;
  /** 重み付きの有効件数 (トレード 1 件 = 1、ニュース判定 1 件 = newsWeight)。無ければ n */
  effN?: number;
  /** ニュースと値動きの答え合わせの判定件数・的中数 (n / hits はトレード由来のみ) */
  newsN?: number;
  newsHits?: number;
}

// ───────────────────────── 仮想トレード (見送ったシグナルの答え合わせ) ─────────────────────────

/** 仮想トレードの決済理由。unwatched は監視をやめたため捨てたもの (学習には使わない) */
export type ShadowExitReason = "stop" | "take_profit" | "time" | "unwatched";

/**
 * 見送ったシグナルの仮想トレード (決済済み)。R は統計値なので number。
 * - 1R = |エントリー価格 (買い: ask / 売り: bid) − 損切り|
 * - grossR = 方向 × (決済の基準価格 − エントリー時の仲値) / 1R
 * - costR = (往復 taker 手数料 + エントリー時のスプレッド (半分 × 2) + 約定ずれ 片道 × 2) / 1R
 * - netR = grossR − costR
 */
export interface ShadowTradeRecord {
  id: string;
  mode: TradingMode;
  symbol: string;
  assetClass: AssetClass;
  strategyId: string;
  horizon: Horizon;
  regime: RegimeLabel;
  direction: "long" | "short";
  /** 見送り理由 (正規化したキー。engine.skip_summary と同じ) */
  reason: string;
  confidence: number;
  expectedEdgeBps: number;
  entryTs: number;
  /** 買いなら ask、売りなら bid */
  entryPrice: number;
  entryMid: number;
  entrySpread: number;
  stopLoss: number;
  takeProfit?: number;
  maxHoldMs: number;
  takerFeeRate: number;
  slippageBps: number;
  exitTs: number;
  /** 決済の基準価格 (損切り・利確は水準、時間切れは仲値。窓開けで損切りを越えた場合は仲値) */
  exitPrice: number;
  exitReason: ShadowExitReason;
  grossR: number;
  costR: number;
  netR: number;
  /** 最大含み益・最大含み損 (R, 正の値) */
  mfeR: number;
  maeR: number;
}

export interface ShadowTradeFilter {
  since?: number;
  mode?: TradingMode;
  strategyId?: string;
  reason?: string;
  limit?: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  mode: TradingMode;
}

/** 監査ログ (発注・停止・パラメータ変更など) */
export interface AuditEvent {
  ts: number;
  type: string;
  data: Record<string, unknown>;
}

// ───────────────────────── 永続化 ─────────────────────────

export interface TradeFilter {
  since?: number;
  until?: number;
  strategyId?: string;
  symbol?: string;
  assetClass?: AssetClass;
  mode?: TradingMode;
  limit?: number;
}

/** 永続化インターフェース。同期 API (node:sqlite / メモリ) */
export interface Store {
  saveTrade(t: TradeRecord): void;
  updateTrade(id: string, patch: Partial<TradeRecord>): void;
  listTrades(f?: TradeFilter): TradeRecord[];

  saveAttribution(a: TradeAttribution): void;
  getAttribution(tradeId: string): TradeAttribution | undefined;
  listAttributions(since?: number): TradeAttribution[];

  saveIntel(items: IntelItem[]): number;
  listIntel(opts?: { since?: number; assets?: string[]; kinds?: IntelKind[]; limit?: number }): IntelItem[];
  getIntel(ids: string[]): IntelItem[];

  saveBrief(b: MarketBrief): void;
  latestBrief(): MarketBrief | undefined;
  savePlan(p: StrategyPlan): void;
  latestPlan(): StrategyPlan | undefined;

  saveLesson(l: Lesson): void;
  listLessons(opts?: { status?: Lesson["status"]; scope?: string; limit?: number }): Lesson[];

  saveAdjustment(a: ParamAdjustment): void;
  listAdjustments(opts?: { strategyId?: string; status?: ParamAdjustment["status"] }): ParamAdjustment[];

  saveEquity(p: EquityPoint): void;
  listEquity(opts?: { since?: number; mode?: TradingMode }): EquityPoint[];

  /** 決済済みの仮想トレード (同じ id は上書き)。list は exitTs の昇順、limit は最新 N 件 */
  saveShadowTrade(t: ShadowTradeRecord): void;
  listShadowTrades(f?: ShadowTradeFilter): ShadowTradeRecord[];
  /** exitTs < before の仮想トレードを消す。消した件数を返す */
  pruneShadowTrades(before: number): number;

  audit(e: AuditEvent): void;
  listAudit(opts?: { since?: number; type?: string; limit?: number }): AuditEvent[];

  /** 学習状態 (ArmStats, SourceReliability, 現行パラメータ, RiskState 等) の汎用 KV */
  kvGet<T>(key: string): T | undefined;
  kvSet<T>(key: string, value: T): void;

  /**
   * fn の中の書き込み (trades・kv など) をまとめて確定する (途中で例外なら何も書かない)。
   * fn は同期関数 (中で await しない)。入れ子は外側に参加する。未対応の実装では fn をそのまま実行する
   */
  transaction?<T>(fn: () => T): T;

  close(): void;
}

// ───────────────────────── 時計 ─────────────────────────

/** 本番は実時間、バックテストは仮想時間 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
