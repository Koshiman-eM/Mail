import type {
  Candle,
  EquityPoint,
  Instrument,
  IntelBias,
  OrderBook,
  Params,
  Signal,
  Strategy,
  Timeframe,
  TradePrint,
  TradeRecord,
} from "../core/types";
import type { RegimeOptions } from "../regime/detect";
import type { ThesisSettings } from "../engine/thesis";
import type { ReversalSettings } from "../engine/reversalExit";
import type { BreakevenSettings } from "../engine/breakeven";

export interface SizerArgs {
  /** 現在の評価額 (クオート通貨) */
  equity: number;
  /** 想定エントリー価格 */
  price: number;
  stopLoss: number;
  riskPerTrade: number;
  riskMultiplier: number;
  /** 1 単位あたりの契約サイズ */
  contractSize: number;
  signal: Signal;
  instrument: Instrument;
}

/** 数量を返す (刻み・最小数量への丸めはエンジン側で行う) */
export type Sizer = (a: SizerArgs) => number;

/** 固定のバイアス、または時刻 → バイアスの関数 */
export type IntelSource = IntelBias | ((ts: number) => IntelBias | undefined);

export interface MarketExtras {
  book?: OrderBook;
  prints?: TradePrint[];
}

export interface BacktestOptions {
  strategy: Strategy;
  instrument: Instrument;
  /** 基準足 (確定足・昇順) */
  candles: Candle[];
  /** 基準足の時間足 (省略時は足間隔から推定) */
  baseTimeframe?: Timeframe;
  /** defaultParams への上書き */
  params?: Params;
  /** 初期評価額 (既定 1,000,000) */
  initialEquity?: number;
  /** 1 トレードのリスク (評価額比, 既定は config の RISK_PER_TRADE) */
  riskPerTrade?: number;
  /** 計画上のリスク倍率 (既定 1) */
  riskMultiplier?: number;
  /** 1 ポジションの建玉上限 (評価額比, 既定は config の MAX_POSITION_PCT。0 以下で上限なし) */
  maxPositionPct?: number;
  /** スプレッド (bps, 全幅)。既定は資産クラス別 */
  spreadBps?: number;
  /** 成行・逆指値のスリッページ (bps, 片道)。既定は資産クラス別 */
  slippageBps?: number;
  /** サイズ計算の差し替え */
  sizer?: Sizer;
  /** インテル (固定 or 時刻 → バイアス) */
  intel?: IntelSource;
  /** バーごとの板・約定 (scalp_obi 等の検証用) */
  marketExtras?: (bar: Candle, now: number) => MarketExtras | undefined;
  /** レジーム判定の設定上書き */
  regime?: Partial<RegimeOptions>;
  /**
   * expectedEdgeBps がコストの何倍未満なら見送るか (既定 0 = フィルターなし)。
   * コスト控除後の期待値 (signal.edgeIsNet) は「期待値 ≥ max(0, 比率 − 1) × コスト かつ 期待値 > 0」で判定する (ライブの RiskManager と同じ)。
   * edgeIsNet の「期待値 > 0」は比率 0 (既定) でも常に求める
   */
  minEdgeToCostRatio?: number;
  /** エグジット後の値動きを測る本数 (主時間足, 既定 10) */
  postExitBars?: number;
  /** 戦略へ渡す各時間足の最大本数 (既定 max(300, warmup + 100)) */
  historyBars?: number;
  /** true なら主時間足の確定を待たず基準足ごとに判定する (既定 false) */
  evaluateEveryBar?: boolean;
  /** この時刻以降の足からトレードを開始する (それ以前はウォームアップ専用) */
  tradeFromTs?: number;
  /** 終了時に保有中ポジションを最終足の終値で決済する (既定 true, exitReason "manual") */
  closeAtEnd?: boolean;
  /** 評価額曲線の記録間隔 (既定 max(主時間足, 1h)) */
  equitySampleMs?: number;
  /** TradeRecord.id の接頭辞 (既定 "bt") */
  idPrefix?: string;
  /**
   * 指値 (maker) の利用 (ライブの LIMIT_ENTRY / LIMIT_TAKE_PROFIT / LIMIT_ENTRY_TIMEOUT_MS と同じ前提)。
   * 省略時は従来どおり (エントリーは成行、利確は従来の判定)。
   * - entry: 戦略の entryOrder が無ければ指値でエントリーする (シグナルの指値 (価格あり) は常に優先)。
   *   価格は買いなら買い気配 (終値 − 半スプレッド)、売りなら売り気配。次の足から、安値 (買い) が指値を「下回った」
   *   (売りは高値が「上回った」) ときだけ指値の価格で maker 約定する。期限 (entryTimeoutMs を足の本数に換算) 内に
   *   約定しなければ取引なし。待っている間に逆方向のシグナルが出たら取り消す。
   * - takeProfit: 利確は板に置いた指値として、高値 (買い) が利確価格を「越えた」ときだけ利確価格で maker 約定する。
   *   同じ足で損切りにも届いたら損切りを優先する (保守的)。実運用では paper 専用 (live では使わない) なので、
   *   limitOrdersFromEnv は現在の mode で有効なときだけ true にする。
   * - 指値で約定した足では、有利な側の極値 (約定前だったかもしれない) をトレーリング・MFE に使わない (約定価格から追う)。
   */
  limitOrders?: { entry?: boolean; takeProfit?: boolean; entryTimeoutMs?: number };
  /**
   * 最大保有 (分。ライブの MAX_HOLD_MINUTES と同じ前提)。シグナルの maxHoldMs をこの分数までに縮める
   * (maxHoldMs が 0 = 時間切れ無しのシグナルもこの分数にする)。省略・0 以下なら従来どおり。
   * 時間軸による扱い (中期・長期は運用で新規エントリーしない) は呼び出し側が決める (isHoldLimitedHorizon)
   */
  maxHoldMinutes?: number;
  /**
   * 読みの管理 (ライブの THESIS_* と同じ src/engine/thesis.ts の規則。省略・無効なら従来の時間切れ)。
   * 判定はバーの終値 (∓ 半スプレッド、手数料の見積り込みの純 R) で行い、決済は次のバーの始値。延長後の保護ストップは次のバーから効く
   */
  thesis?: ThesisSettings;
  /**
   * 転換で決済 (ライブの REVERSAL_* と同じ src/engine/reversalExit.ts の規則。省略・無効・戦略が対象外なら従来どおり)。
   * 主時間足が確定したバーの終値で判定し (エントリー後の押し安値 / 戻り高値を終値が越えたか)、決済は次のバーの始値の成行
   * (理由 reversal。戦略の決済シグナルと同じタイミング。同じバーで決済シグナルも出たら signal を優先)
   */
  reversal?: ReversalSettings;
  /**
   * 建値ストップ (ライブの BREAKEVEN_TRIGGER_R と同じ src/engine/breakeven.ts の規則。省略・0 なら従来どおり)。
   * バーの終値で発動を判定し、往復コスト込みの建値のストップは次のバーから効く
   */
  breakeven?: BreakevenSettings;
}

export interface BacktestMetrics {
  netPnl: number;
  /** netPnl / 初期評価額 */
  returnPct: number;
  /** 年率換算 (評価額曲線の記録間隔ベース, 24/365 前提) */
  sharpe: number;
  sortino: number;
  /** 最大ドローダウン (ピーク比, 0.1 = 10%) */
  maxDrawdown: number;
  winRate: number;
  /** 総利益 / 総損失 (損失 0 なら 100 で頭打ち) */
  profitFactor: number;
  /** R 倍数の平均 */
  expectancyR: number;
  trades: number;
  avgHoldMs: number;
  /** 手数料合計 */
  fees: number;
  grossPnl: number;
  finalEquity: number;
}

export interface BacktestStats {
  /** 戦略を評価した回数 */
  evaluations: number;
  /** エントリーシグナル数 */
  entrySignals: number;
  entries: number;
  /** 反転 (flat) シグナルによる決済数 */
  signalExits: number;
  /** 転換で決済 (reversal) による決済数 */
  reversalExits?: number;
  /** 見送り理由ごとの件数 (size / edge / short / equity) */
  skipped: Record<string, number>;
  /** 指値のエントリー (limitOrders.entry のとき): 置いた / 約定 / 期限切れ / 逆シグナルで取消 */
  limitEntries?: { placed: number; filled: number; expired: number; canceled: number };
}

export interface BacktestResult {
  trades: TradeRecord[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  params: Params;
  baseTimeframe: Timeframe;
  stats: BacktestStats;
}
