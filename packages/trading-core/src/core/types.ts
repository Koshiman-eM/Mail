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

/**
 * 資産クラス (仮想通貨だけ)。meme は Jupiter のミームコイン (JUPITER_TOKENS の SOL・JUP 以外と自動探索の銘柄) と、
 * WATCHLIST で "venue|symbol|meme" と明示した銘柄。ccxt の銘柄は自動では meme に分類しない。
 * fx / stock は廃止した。DB の古い記録 (取引・仮想トレード・腕・パラメータ・振り返り・予想の集計) には "fx" / "stock" が残りうるので、
 * 記録の assetClass を読むコードは未知のクラスでも例外にしない (クラス別の表を引くときは既定値に落とす)
 */
export type { AssetClass } from "./assetClasses";
import type { AssetClass } from "./assetClasses";
/**
 * トレードの時間軸。登録している戦略は scalp と short だけ。mid / long の戦略は廃止したが、
 * 古い取引・仮想トレードの記録と MAX_HOLD_MINUTES の規則 (isHoldLimitedHorizon) のために残す
 */
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
  /** 統一シンボル。例: "BTC/USDT", "BTC/JPY", "SOL/USDC" */
  symbol: string;
  /** 取引先。例: "paper", "ccxt:bitbank" (古い paper のスナップショットには廃止した "gmo" / "oanda" / "dex:solana" などが残りうる) */
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
  /** 空売り (ショート) 可能か (取引所の仕様。paper の空売り再現でも書き換えない) */
  allowShort: boolean;
  /**
   * paper で空売りを再現する銘柄 (allowShort=false の現物暗号資産だけ。src/core/short.ts の markSimulatedShort が付ける)。
   * 実効の空売り可否は必ず canShort(inst, mode) で判定する (live では常に無視される)
   */
  simulatedShort?: boolean;
  /** 1 単位あたりの契約サイズ (先物用。現物は 1) */
  contractSize?: number;
  /**
   * 約定ごとに掛かる固定の手数料 (クオート通貨建て。Jupiter: Solana のネットワーク手数料 JUPITER_NETWORK_FEE_USD)。
   * takerFeeRate とは別に 1 回の約定ごとに掛かる。コストの見積もり (bps) では costRefNotional で率に直す (src/core/fees.ts)
   */
  fixedFeePerOrder?: number;
  /**
   * コストの見積もりの前提 (DEX の銘柄だけ。無ければ資産クラスの既定値):
   * refNotional = 代表的な約定代金 (クオート通貨建て。固定手数料を bps に直すのに使う)、
   * spreadBps = 全幅のスプレッド相当 (片道の価格影響 × 2)、slippageBps = 片道の約定ずれ (価格影響がスプレッドに含まれていれば 0)。
   * バックテスト・パラメータ検証・仮想トレードのコストに使う
   */
  costModel?: { refNotional: number; spreadBps: number; slippageBps: number };
  /** 取引先固有の情報 (古いスナップショットには廃止した GMO の holdingFeeDaily が残りうる。読まない) */
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
  /**
   * false なら出来高が不明 (Jupiter の価格のポーリングで作った足。volume は 0 だが「出来高 0」ではない)。
   * 省略 (undefined) は出来高が分かっている (ccxt・合成データの足)。出来高を使う戦略は不明なら条件を満たさない (fail-closed)
   */
  volumeKnown?: boolean;
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
  /** 情報源 ID。例: "rss:coindesk", "fng:alternative.me", "coingecko", "calendar:ff" */
  source: string;
  kind: IntelKind;
  title: string;
  summary?: string;
  url?: string;
  publishedAt: number;
  fetchedAt: number;
  /** 関連資産 (正規化済み)。例: ["BTC", "ETH"], ["SOL"], ["USD"] */
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
  /**
   * 腕 (戦略×レジーム×資産クラス) が無効化されているため外した戦略。
   * エンジンはエントリー時の探索 (既定 5%) と仮想トレードの記録 (arm_disabled) にだけ使う。AI では再開できない
   */
  armDisabled?: string[];
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
  /**
   * 取引 mode (エンジンが渡す)。空売りの再現 (simulatedShort) は mode === "paper" のときだけ効く。
   * 省略時 (バックテスト・パラメータ検証) は取引所の allowShort だけで判定する
   */
  mode?: TradingMode;
  /**
   * 戦略が自分の条件 (コストなど) で見送ったシグナルを観測用に知らせる。エンジンは仮想トレードとしてだけ記録し、
   * 発注・腕の学習には使わない。バックテスト・パラメータ検証では渡さない (挙動は変わらない)。
   */
  onFiltered?: (signal: Signal, reason: string) => void;
  /**
   * テンポ (0〜1)。エントリー頻度の目標に届かないときにエンジンが上げる (`src/engine/tempo.ts`)。
   * 戦略は決められた範囲だけ条件を緩める (コスト控除後の期待値 > 0 などは緩めない。例外は tempoExplore)。
   * 省略時は 0 と同じ (従来どおり)。バックテスト・パラメータ検証では渡さない
   */
  tempo?: number;
  /**
   * 探索を許すか (テンポのモードで、paper または live で TEMPO_ALLOW_LIVE_EXPLORE=true のときだけ true)。
   * true なら、コスト控除後の期待値の下限を tempoNetEdgeFloor (往復コストの tempo 倍まで) に下げる。
   * 省略時・false は従来どおり。バックテスト・パラメータ検証では渡さない
   */
  tempoExplore?: boolean;
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
  /**
   * expectedEdgeBps がコスト控除後 (往復コストを引いた期待値) なら true。
   * RiskManager とバックテストのエントリーの判定は、テンポの有無によらず、コストを二重に数えないよう
   * 「期待値 ≥ max(0, MIN_EDGE_TO_COST − 1) × コスト かつ 期待値 > 0」で判定する (テンポのモードは比率を緩めてから同じ規則)
   */
  edgeIsNet?: boolean;
  entry: { type: "market" | "limit"; price?: number };
  /** エントリー時の損切り価格 (flat の場合は 0 でよい) */
  stopLoss: number;
  takeProfit?: number;
  /** トレーリングストップ幅 (0.01 = 1%) */
  trailingStopPct?: number;
  /** 最大保有時間 */
  maxHoldMs: number;
  /**
   * いつ頃までに利益が出る読みか (エントリーからの ms。読みの期限)。省略時は maxHoldMs を読みの期限にする。
   * 読みの管理 (THESIS_EXIT) が有効なら、期限で利益が出ていなければ決済し、出ていれば延長する (src/engine/thesis.ts)。
   * MAX_HOLD_MINUTES が有効なら maxHoldMs と同じく丸める
   */
  expectedMs?: number;
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
  /**
   * 出来高 (主時間足の直近 21 本) が必要か。出来高が後から分かる feed (Jupiter: volumeKnown が false → true) で、
   * 出来高が不明な間は評価済みにせず次のティックで取り直す (足が確定してから 10 分まで)。
   * 1m の戦略には付けない (足が出来高の判明より先に次の足へ置き換わる)。volumeKnown を持たない足 (ccxt・合成) では何も変わらない
   */
  needsVolume?: boolean;
  /** 主時間足 */
  primaryTimeframe: Timeframe;
  /** 必要な時間足 */
  timeframes: Timeframe[];
  /** 判定に必要な最小本数 (主時間足) */
  warmup: number;
  defaultParams: Params;
  /** 学習による自動調整の上下限 */
  paramBounds: Record<string, [number, number]>;
  /**
   * 新規エントリーの注文の種類。未指定ならエンジンの設定 (LIMIT_ENTRY、既定 true = 指値) に従う。
   * シグナルが entry.type === "limit" で価格を持つときは、そちらを優先する
   */
  entryOrder?: "market" | "limit";
  /**
   * 決済を自分で管理する戦略 (trend_4h など。中期のトレンドフォローで、保有を数日〜数週間に伸ばすため)。
   * この戦略が持ち主の建玉・仮想トレードには、汎用の決済の上乗せを掛けない: 建値ストップ (BREAKEVEN_TRIGGER_R)・
   * 転換で決済 (REVERSAL_EXIT)・読みの管理 (THESIS_EXIT。代わりに従来の maxHold の時間切れ)・最大保有の上限 (MAX_HOLD_MINUTES。
   * isHoldLimitedHorizon による観測専用の扱いもしない)。
   * 掛けるもの: 当初の損切り、戦略自身の決済シグナル (トレーリング・チャネル割れ)、戦略の maxHoldBars の時間切れ、RiskManager
   * (日次損失・ドローダウンのキルスイッチ・上限) と新規エントリーのすべての判定。
   * エンジン・バックテスト・パラメータ検証・仮想トレードで同じ。復元した建玉は持ち主の戦略を id で引く (未知・廃止した id は従来どおり)
   */
  managesOwnExit?: true;
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
  /**
   * 指値を板に置く側だけで受け付ける (post-only。置いた瞬間に約定する価格なら取引所が拒否・取消する)。
   * Broker.capabilities.postOnly が true のアダプターだけが解釈する
   */
  postOnly?: boolean;
  strategyId: string;
  /**
   * 取引所側に置く保護用ストップ価格 (対応アダプターのみ。エンジン側の損切りが主で、これはプロセス停止時の保険)。
   * 決済時に取引所側で自動的に取り消されることが保証できるアダプターだけが付ける (いまの発注先の paper は付けない)。
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

/**
 * 発注先の能力 (任意)。無い・false の能力はエンジンが使わない (従来の動き)。
 * - postOnly: 指値の post-only (OrderRequest.postOnly) を取引所の機能で扱える
 * - restingTakeProfit: reduceOnly の指値 (利確) を板に置いたまま、照会・取消で追跡できる
 *   (エンジンは決済の成行の前に必ず取り消し、取消の結果を照会で確かめてから残りだけを成行で送る)
 */
export interface BrokerCapabilities {
  postOnly?: boolean;
  restingTakeProfit?: boolean;
  /**
   * 成行 (スワップ) しか受け付けない取引先 (venue)。DEX (Jupiter) には板に置く指値が無いので、
   * エンジンは新規エントリーを常に成行にし (LIMIT_ENTRY を無視)、利確の指値も置かない
   */
  marketOnlyVenues?: readonly string[];
}

/** 発注先。ペーパーと実口座で同じインターフェース */
export interface Broker {
  readonly venue: string;
  readonly mode: "paper" | "live";
  readonly capabilities?: BrokerCapabilities;
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
  /** 使う資産クラス (アプリが選んだクラス) ごとの上限。キーの無いクラスの新規エントリーは拒否する */
  maxExposureByClass: Partial<Record<AssetClass, number>>;
  /** 1 銘柄あたりの最大ポジション (評価額比) */
  maxPositionPct: number;
  /** 1 分あたりの最大発注数 */
  maxOrdersPerMinute: number;
  /** 期待値幅が (手数料+スプレッド) の何倍以上でないと入らないか */
  minEdgeToCostRatio: number;
  /**
   * テンポのモード (EntryParams.tempo あり) で minEdgeToCostRatio を緩める下限 (既定 1.0。1.0 未満は 1.0 として扱う)。
   * 設定が下限より低ければ設定のまま (締めも緩めもしない)
   */
  tempoMinEdgeToCost?: number;
  /** 資産クラス meme の最低流動性 (USD。Jupiter はトークン情報の liquidity、ほかは 24 時間の出来高から推定) */
  memeMinLiquidityUsd: number;
}

export type RiskDecision =
  /** costBps: サイズを決めた後の実際の代金での往復コスト (bps。EntryParams.costBpsAt を渡したときだけ) */
  | { ok: true; qty: string; notes: string[]; costBps?: number }
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

/**
 * 決済理由。thesis_failed: 読みの期限の途中で読み外れ / thesis_timeout: 期限で読み外れ / thesis_cap: 読み当たりで延長した上限
 * (読みの管理。src/engine/thesis.ts)。
 * reversal: 転換で決済 (保有後にできた押し安値を確定足の終値が割った / 戻り高値を越えた。src/engine/reversalExit.ts)
 */
export type ExitReason =
  | "stop" | "take_profit" | "trailing" | "signal" | "time" | "kill_switch" | "manual"
  | "thesis_failed" | "thesis_timeout" | "thesis_cap" | "reversal"
  /** paper の口座のリセット (`paper reset`) で、保有中の建玉を最後の価格で記帳上だけ閉じた。学習・成績の集計には使わない */
  | "wallet_reset";

/**
 * 学習・成績の集計から除く取引 (paper の口座のリセットで閉じた建玉など)。
 * 腕・要因分析・ParamTuner・振り返り・情報源の信頼度・report / ダッシュボードの成績はこれを除く
 */
export const isLearningExcludedTrade = (t: Pick<TradeRecord, "learningExcluded" | "exitReason">): boolean =>
  t.learningExcluded === true || t.exitReason === "wallet_reset";

/** 時間に関する決済理由 (従来の時間切れ time と読みの管理の 3 つ)。要因分析・パラメータ調整で time と同じ扱いにする */
export const TIME_LIKE_EXIT_REASONS: readonly string[] = ["time", "thesis_failed", "thesis_timeout", "thesis_cap"];

/** 時間に関する決済理由か (TIME_LIKE_EXIT_REASONS) */
export const isTimeLikeExit = (reason: string | undefined): boolean => reason !== undefined && TIME_LIKE_EXIT_REASONS.includes(reason);

/**
 * 確定足で判断して成行で決済する理由 (戦略の決済シグナル signal と 転換で決済 reversal)。
 * 要因分析 (early_exit)・パラメータ調整では signal と同じ扱いにする
 */
export const SIGNAL_LIKE_EXIT_REASONS: readonly string[] = ["signal", "reversal"];

/** 確定足で判断した決済 (signal / reversal) か (SIGNAL_LIKE_EXIT_REASONS) */
export const isSignalLikeExit = (reason: string | undefined): boolean => reason !== undefined && SIGNAL_LIKE_EXIT_REASONS.includes(reason);

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
  /**
   * エントリー約定時点の仲値 (気配の中値)。古い取引には無い。
   * mfePct/maePct は約定価格 (買いは ask + 価格影響) 比なので、仲値がエントリーのコスト分だけ動くまで MFE が 0 のまま。
   * 値動きそのもの (方向の正誤) は仲値基準の mfeMidPct/maeMidPct で見る
   */
  entryMid?: number;
  /** 保有中の仲値の最大の有利・不利な動き (entryMid 比, 正の値。決済の約定価格は含めない)。古い取引には無い */
  mfeMidPct?: number;
  maeMidPct?: number;
  exitReason: ExitReason;
  entryContext: EntryContext;
  /** エグジット後一定時間の値動き (方向付き, エントリー方向に有利なら正)。後から埋める */
  postExitMovePct?: number;
  /**
   * 約定を確認できず、建玉の照会や手動の申告から数量・価格を推定した部分を含む (学習には渡さない)。
   * 推定の価格は照会時点の現在値など
   */
  estimated?: boolean;
  /**
   * paper で再現した空売り (取引所では空売りできない現物の売り建て)。live では実行できない取引なので、
   * 腕は方向別のキー (…|short) で学習し、パラメータ調整・振り返り・情報源の信頼度には使わない。表示も買いと分ける
   */
  simulatedShort?: boolean;
  /** エントリーの注文の種類 (記録の無い古い取引は成行とみなす) */
  entryOrderType?: "market" | "limit";
  /** 1 単位あたりの契約サイズ (1 以外のときだけ。手数料率の集計に使う) */
  contractSize?: number;
  /** 決済の注文の種類 (板に置いた利確の指値で決済したら limit。一部だけ指値の約定でも limit) */
  exitOrderType?: "market" | "limit";
  /** 手数料の内訳 (約定の liquidity 別、クオート通貨建て。maker は受け取りなら負)。古い取引には無い */
  makerFees?: number;
  takerFees?: number;
  /**
   * 読みの管理 (THESIS_EXIT) の記録。読みの管理を使った取引だけ (古い取引・無効のときは無い)。
   * thesisExpectedMs: 読みの期限までの時間 / thesisDeadlineTs: 期限の時刻 (エントリー時刻 + thesisExpectedMs) /
   * thesisExtendedAt: 期限で読み当たりとして延長した時刻 / thesisOutcome: 答え合わせの結果 /
   * thesisNetRAtDeadline: 期限の時点の純 R の見積り (延長・期限で読み外れのときだけ) /
   * thesisStopExit: 延長後の保護ストップ (建値・トレーリング) での決済 (exitReason は trailing。戦略のトレーリングとは別。
   * ParamTuner はトレーリングの調整の根拠に使わない)
   */
  thesisExpectedMs?: number;
  thesisDeadlineTs?: number;
  thesisExtendedAt?: number;
  thesisOutcome?: "failed_early" | "timeout" | "extended" | "none";
  thesisNetRAtDeadline?: number;
  thesisStopExit?: boolean;
  /**
   * 建値ストップ (BREAKEVEN_TRIGGER_R。src/engine/breakeven.ts) での決済 (exitReason は trailing。戦略のトレーリングとは別。
   * ParamTuner はトレーリングの調整の根拠に使わない)。古い取引には無い
   */
  breakevenStopExit?: boolean;
  /**
   * 学習・成績の集計から除く (paper の口座のリセット `wallet_reset` で記帳上だけ閉じた建玉)。
   * 判定は isLearningExcludedTrade を使う
   */
  learningExcluded?: boolean;
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
  /** 調整した mode (学習状態は paper / live で分ける)。列追加前の旧データは paper とみなす */
  mode?: TradingMode;
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

/**
 * 仮想トレードの決済理由。unwatched は監視をやめたため捨てたもの (学習には使わない)。
 * trailing・thesis_* は読みの管理 (延長後の建値・トレーリング、途中・期限での読み外れ、延長の上限)。reversal は転換で決済
 */
export type ShadowExitReason =
  | "stop" | "take_profit" | "time" | "unwatched" | "trailing" | "thesis_failed" | "thesis_timeout" | "thesis_cap" | "reversal";

/**
 * 見送ったシグナルの仮想トレード (決済済み)。R は統計値なので number。
 * - 1R = |エントリー価格 (買い: ask / 売り: bid) − 損切り|
 * - grossR = 方向 × (決済の仲値換算 − エントリー時の仲値) / 1R (決済の仲値換算 = exitPrice ± (決済時の半スプレッド + 約定ずれ))
 * - netR = (方向 × (exitPrice − エントリーの約定) − 往復 taker 手数料) / 1R (エントリーの約定 = 仲値 ± (半スプレッド + 約定ずれ))
 * - costR = grossR − netR (手数料 + スプレッド + 約定ずれ。約定ずれは資産クラス別 = バックテストの既定値)
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
  /**
   * 決済の約定価格 (推定。決済側 = 買いは bid 側、売りは ask 側)。損切りはストップ価格 (窓開けで越えていれば決済側の気配) に
   * 約定ずれを不利側に加えた値、利確は指値、時間切れは決済側の気配 ∓ 約定ずれ。
   * (以前の記録は仲値ベースの基準価格: 損切り・利確は水準、時間切れ・窓開けは仲値)
   */
  exitPrice: number;
  exitReason: ShadowExitReason;
  grossR: number;
  costR: number;
  netR: number;
  /** 最大含み益・最大含み損 (R, 正の値) */
  mfeR: number;
  maeR: number;
  /** paper で再現した空売りの仮想トレード (腕は方向別のキー …|short で学習する)。借入コストは costR / netR に含める */
  simulatedShort?: boolean;
  /** 空売りの借入コストの日率 (simulatedShort のときだけ。記録時の PAPER_SHORT_BORROW_RATE_DAILY) */
  borrowRateDaily?: number;
  /**
   * 読みの管理 (シグナルに最大保有・読みの期限があったものだけ。古い記録には無い)。
   * thesisExpectedMs: 読みの期限までの時間 / thesisExtendedAt: 延長した時刻 / thesisNetRAtDeadline: 期限の時点の純 R /
   * thesisOutcome: 答え合わせの結果 (読みの管理で判定したときだけ)
   */
  thesisExpectedMs?: number;
  thesisExtendedAt?: number;
  thesisNetRAtDeadline?: number;
  thesisOutcome?: "failed_early" | "timeout" | "extended" | "none";
}

export interface ShadowTradeFilter {
  since?: number;
  mode?: TradingMode;
  strategyId?: string;
  reason?: string;
  limit?: number;
}

// ───────────────────────── 値動きの予想 (判定済みの記録) ─────────────────────────

/** 予想の方向。flat は「ノイズの範囲内」 */
export type ForecastDirection = "up" | "down" | "flat";

/**
 * 判定済みの予想 1 件 (銘柄 × 予想時間)。確率・統計なので number。
 * outcome: 実際の動き (ノイズの範囲内は flat、価格が取れなかったものは expired)
 */
export interface ForecastOutcomeRecord {
  id: string;
  mode: TradingMode;
  symbol: string;
  assetClass: AssetClass;
  /** 予想時間 (ミリ秒) */
  horizonMs: number;
  madeAt: number;
  dueAt: number;
  judgedAt: number;
  pUp: number;
  direction: ForecastDirection;
  outcome: ForecastDirection | "expired";
  /** (判定価格 − 予想時の仲値) / 予想時の仲値 */
  changePct?: number;
  /** ノイズの範囲 (比率) */
  noisePct?: number;
  /** 方向の予想 (up/down) と方向の結果 (up/down) の両方があるときだけ */
  hit?: boolean;
  /** 特徴量 (FORECAST_FEATURES の順) */
  features: number[];
}

export interface ForecastOutcomeFilter {
  since?: number;
  mode?: TradingMode;
  symbol?: string;
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
export interface OperationalCutoffs {
  audit?: number;
  intel?: number;
  briefs?: number;
  plans?: number;
  equity?: number;
}

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
  /** generatedAt が [since, until] のブリーフ (昇順)。パラメータ検証で「その時点のバイアス」を再現するのに使う (未対応の実装は省略可) */
  listBriefs?(opts?: { since?: number; until?: number }): MarketBrief[];
  savePlan(p: StrategyPlan): void;
  latestPlan(): StrategyPlan | undefined;

  saveLesson(l: Lesson): void;
  listLessons(opts?: { status?: Lesson["status"]; scope?: string; limit?: number }): Lesson[];

  saveAdjustment(a: ParamAdjustment): void;
  /** createdAt の昇順。limit を渡すと最新 N 件 (昇順) だけを返す。mode は未記録 (旧データ) を paper とみなして絞り込む */
  listAdjustments(opts?: { strategyId?: string; status?: ParamAdjustment["status"]; mode?: TradingMode; limit?: number }): ParamAdjustment[];

  saveEquity(p: EquityPoint): void;
  listEquity(opts?: { since?: number; mode?: TradingMode }): EquityPoint[];

  /** 決済済みの仮想トレード (同じ id は上書き)。list は exitTs の昇順、limit は最新 N 件 */
  saveShadowTrade(t: ShadowTradeRecord): void;
  listShadowTrades(f?: ShadowTradeFilter): ShadowTradeRecord[];
  /** exitTs < before の仮想トレードを消す。消した件数を返す */
  pruneShadowTrades(before: number): number;

  /** 判定済みの予想 (同じ id は上書き)。list は judgedAt の昇順、limit は最新 N 件 */
  saveForecastOutcomes(records: ForecastOutcomeRecord[]): void;
  listForecastOutcomes(f?: ForecastOutcomeFilter): ForecastOutcomeRecord[];
  /** judgedAt < before の記録を消す。消した件数を返す */
  pruneForecastOutcomes(before: number): number;

  /**
   * 運用ログ系の表の古い行を消す (各 cutoff より古いもの)。消した件数を返す。
   * 対象は audit / intel (fetchedAt) / briefs / plans (最新 1 件は残す) / equity のみ。
   * 学習データ (trades, attributions, lessons, adjustments, shadow_trades, forecast_outcomes, kv) は消さない。
   */
  pruneOperational(cutoffs: OperationalCutoffs): Record<keyof OperationalCutoffs, number>;

  audit(e: AuditEvent): void;
  listAudit(opts?: { since?: number; type?: string; limit?: number }): AuditEvent[];

  /** 学習状態 (ArmStats, SourceReliability, 現行パラメータ, RiskState 等) の汎用 KV */
  kvGet<T>(key: string): T | undefined;
  kvSet<T>(key: string, value: T): void;
  /** prefix で始まる kv のキー一覧 (昇順)。学習状態の移行などで使う */
  kvKeys(prefix: string): string[];

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
