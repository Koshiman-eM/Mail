import type {
  AssetClass,
  Candle,
  EntryContext,
  EquityPoint,
  ExitReason,
  IntelBias,
  Instrument,
  MarketView,
  PositionView,
  Quote,
  RegimeFeatures,
  Signal,
  StrategyContext,
  Timeframe,
  TradeRecord,
} from "../core/types";
import { TIMEFRAME_MS } from "../core/types";
import { costFeeRate, fixedFeeOf } from "../core/fees";
import { roundTripCostBps } from "../core/costs";
import { profileOrDefault } from "../core/assetClasses";
import { D, Decimal, floorToStep } from "../core/decimal";
import { defaultRiskLimits } from "../core/config";
import { resample } from "../indicators/resample";
import { detectRegime, regimeOptionsFor } from "../regime/detect";
import { computeMetrics } from "./metrics";
import { clampMaxHoldMs } from "../engine/tempo";
import {
  activeThesisMs, advancePeak, decideThesis, initialRiskPerUnit, THESIS_DISABLED, thesisGrossR, thesisNetR, thesisOutcomeOf, thesisTrailStop, type ThesisPricing,
} from "../engine/thesis";
import { breakevenEnabled, breakevenStopPrice, breakevenTriggered } from "../engine/breakeven";
import { checkReversal, entryBarIndex, REVERSAL_ATR_WINDOW, reversalAppliesTo, reversalBacktestTimeframe } from "../engine/reversalExit";
import { netEdgeMinBps } from "../risk/manager";
import type { BacktestOptions, BacktestResult, BacktestStats, IntelSource, Sizer } from "./types";

/**
 * イベント駆動バックテスト。ライブと同じ Strategy オブジェクトを使う。
 *
 * タイミング (先読み禁止):
 *   - バー i の終了時刻 (ts_i + 基準足幅) を now とし、その時点で確定している足だけを戦略へ渡す。
 *   - 上位足は resample の確定足のみ。判定は主時間足が確定したバーでだけ行う (evaluateEveryBar で変更可)。
 *   - シグナルの約定はバー i+1 の始値 ± 半スプレッド ± スリッページ。
 * 決済:
 *   - 損切り/利確はバー内の高値・安値で判定。同一バーで両方に触れたら損切り優先 (保守的)。
 *   - 始値で損切り価格を越えていたら始値で約定 (ギャップ)。
 *   - トレーリングは前バーまでの最高値 (最安値) から計算する (同一バーの高値を使わない)。
 *   - 利確は指値扱い (スリッページなし)。判定は「高値 × (1 - 半スプレッド) >= 利確価格」(ロング)。
 *   - 保有時間が maxHoldMs に達したら次のバーの始値で成行決済 (time)。
 * 会計: 残高・手数料・損益は decimal.js。手数料は instrument.takerFeeRate (往復)。
 * 制約: 1 戦略 1 ポジション (ピラミッディング・ドテンなし)。
 * 指値 (opts.limitOrders。省略時は従来どおり、指値のシグナルも成行として扱う):
 *   - entry: シグナルの次の足から、安値 (買い) が指値を「下回った」(売りは高値が「上回った」) ときだけ指値の価格で約定する
 *     (触れただけでは約定しない = 保守的)。手数料は makerFeeRate。期限 (足の本数) 内に約定しなければ取引なし。
 *     待っている間に逆方向のシグナルが出たら取り消す。約定した足では利確を判定しない (足の中の順序が分からないため。損切りは判定する)。
 *     成行の戦略 (entryOrder: "market") は従来どおり。
 *   - takeProfit: 高値 (買い) が利確価格を「越えた」ときだけ利確価格で maker 約定する。同じ足で損切りにも届けば損切りを優先する。
 * 最大保有 (opts.maxHoldMinutes。省略時は従来どおり): シグナルの maxHoldMs をその分数までに縮めて保有する (ライブの MAX_HOLD_MINUTES と同じ)。
 *   シグナルの読みの期限 (expectedMs) も同じ分数までに縮める。
 * 読みの管理 (opts.thesis。省略・無効なら従来の時間切れ。ライブの THESIS_* と同じ src/engine/thesis.ts の規則):
 *   - バー i の終値で判定する (期限は純 R = 決済できる価格 (終値 ∓ 半スプレッド) と手数料の見積り込み、途中で読み外れは値動きだけの R =
 *     終値を仲値として)。決済はバー i+1 の始値の成行
 *     (従来の時間切れと同じタイミング。始値で損切りを越えていれば損切りの理由)。
 *   - 延長した建玉の保護ストップ (建値・トレーリング) はバー i+1 から効く。極値は延長から測り (判定した終値の決済できる価格から始め、
 *     バー i+1 以降の高値・安値 ∓ 半スプレッドで進める)、前バーまでの値を使う (先読みしない)。理由は trailing (thesisStopExit)。
 * 建値ストップ (opts.breakeven。省略・0 なら従来どおり。ライブの BREAKEVEN_TRIGGER_R と同じ src/engine/breakeven.ts の規則):
 *   - バー i の終値 (仲値とみなす) が エントリーの基準 (entryMid: 成行は始値、指値は指値の価格) から triggerR × 当初のリスク 有利に動いたら発動。
 *     ストップ = 往復コスト込みの建値 (エントリー手数料/単位 + 決済の taker・固定手数料 (1 単位換算) + 半スプレッド)。
 *   - バー i の損切りの判定の後に発動するので、ストップはバー i+1 から効く (先読みしない)。一度上げたら戻さない。
 *     実効のストップは当初・トレーリング・読みの管理の保護ストップ・建値ストップのうち最もきついもの。理由は trailing (breakevenStopExit)。
 * 転換で決済 (opts.reversal。省略・無効・戦略が対象外なら従来どおり。ライブの REVERSAL_* と同じ src/engine/reversalExit.ts の規則):
 *   - 判定の時間足 (REVERSAL_EXIT_TF。lower = 主時間足の 1 つ下、same = 主時間足) が確定したバー i の終値で、
 *     エントリー後に確定した押し安値 (売りは戻り高値。REVERSAL_EXIT_FALLBACK なら無いときエントリーした足の安値・高値) を終値が越えたかを判定し、
 *     バー i+1 の始値の成行で決済する (理由 reversal。戦略の決済シグナルと同じタイミング・同じ約定)。
 *     基準足 (baseTimeframe) から lower の時間足が作れない (基準足の方が粗い) ときは same (主時間足) に戻す。
 *   - 同じバーで戦略の決済シグナル (flat・逆方向) も出たら signal を優先する (ライブと同じ)。主時間足が確定していないバーでは
 *     戦略を評価せず (evaluateEveryBar を除く)、転換で決済だけを判定する。
 *   - 足は判定の時間足の確定足 (その時点で見えている分) をエントリーした足の N 本前から渡す (戦略へ渡す historyBars の制限は受けない)。
 */

/**
 * 資産クラスの既定コスト (スプレッドは全幅 bps、スリッページは片道 bps。src/core/assetClasses.ts のプロファイル)。
 * 使わないクラス・未知のクラス (trader の古い fx / stock の記録など) は最初に選んだクラス (crypto) の値
 */
export function defaultCosts(assetClass: AssetClass): { spreadBps: number; slippageBps: number } {
  return { ...profileOrDefault(assetClass).defaultCosts };
}

/**
 * 銘柄のコストの前提。銘柄が costModel (Jupiter: 代わりのスリッページのモデルを代表的な約定代金で評価した値) を持てばそれ、
 * 無ければ資産クラスの既定値 (従来どおり)
 */
function instrumentCosts(inst: Pick<Instrument, "assetClass"> & Partial<Pick<Instrument, "costModel">>): { spreadBps: number; slippageBps: number } {
  const m = inst.costModel;
  if (m && Number.isFinite(m.spreadBps) && m.spreadBps >= 0 && Number.isFinite(m.slippageBps) && m.slippageBps >= 0) {
    return { spreadBps: m.spreadBps, slippageBps: m.slippageBps };
  }
  return defaultCosts(inst.assetClass);
}

/** 足の間隔から時間足を推定する */
export function inferTimeframe(candles: readonly Candle[]): Timeframe {
  let minDiff = Infinity;
  for (let i = 1; i < Math.min(candles.length, 500); i++) {
    const d = candles[i].ts - candles[i - 1].ts;
    if (d > 0 && d < minDiff) minDiff = d;
  }
  const tf = (Object.keys(TIMEFRAME_MS) as Timeframe[]).find((k) => TIMEFRAME_MS[k] === minDiff);
  if (!tf) throw new Error(`基準足の時間足を推定できません (間隔 ${minDiff}ms)。baseTimeframe を指定してください`);
  return tf;
}

/** 既定のサイズ計算: 評価額 × riskPerTrade × riskMultiplier / 損切り幅 */
export const riskBasedSizer: Sizer = (a) => {
  const perUnit = Math.abs(a.price - a.stopLoss) * a.contractSize;
  if (!(perUnit > 0)) return 0;
  return (a.equity * a.riskPerTrade * a.riskMultiplier) / perUnit;
};

const resolveIntel = (src: IntelSource | undefined, ts: number): IntelBias | undefined =>
  typeof src === "function" ? src(ts) : src;

interface OpenPos {
  dir: 1 | -1;
  qty: Decimal;
  qtyNum: number;
  entryIdx: number;
  entryTs: number;
  entryPrice: number;
  intendedEntryPrice: number;
  /**
   * 約定の基準にした価格 (成行は始値 = 半スプレッド・スリッページを足す前。指値は指値の価格)。
   * TradeRecord.entryMid (要因分析の仲値基準の MFE) に使う
   */
  entryMid: number;
  entryFee: Decimal;
  initialStop: number;
  takeProfit?: number;
  trailPct?: number;
  maxHoldMs: number;
  /** トレーリング用 (前バーまで) */
  highWater: number;
  lowWater: number;
  /** MFE/MAE 用の保有中の極値 */
  maxHigh: number;
  minLow: number;
  context: EntryContext;
  /** 指値で約定したエントリー (約定した足の番号。その足では利確を判定しない) */
  limitFillIdx?: number;
  entryLiq: "maker" | "taker";
  /** 読みの期限 (シグナルの expectedMs を最大保有で丸めたもの。無ければ maxHoldMs を使う) */
  expectedMs?: number;
  /** 読みの管理で延長した時刻・期限の時点の純 R */
  extendedAt?: number;
  netRAtDeadline?: number;
  /**
   * 延長後の有利な極値 (決済できる価格: 買いは高値 × (1 − 半スプレッド)、売りは安値 × (1 + 半スプレッド))。
   * 延長を判定した終値の決済できる価格から始め、延長した足以降の高値・安値だけで進める (その足の判定には使わない)
   */
  thesisPeak?: number;
  /** 建値ストップ (発動したバーの次のバーから効く。一度上げたら戻さない) */
  breakevenStop?: number;
}

type Pending =
  | { kind: "entry"; signal: Signal; qty: Decimal; intended: number; context: EntryContext }
  | { kind: "limit"; signal: Signal; qty: Decimal; intended: number; price: number; expiresIdx: number; context: EntryContext }
  | { kind: "exit"; intended: number; reason: "signal" | "reversal" };

export function runBacktest(opts: BacktestOptions): BacktestResult {
  const { strategy, instrument } = opts;
  const candles = opts.candles;
  const params = { ...strategy.defaultParams, ...(opts.params ?? {}) };
  const stats: BacktestStats = { evaluations: 0, entrySignals: 0, entries: 0, signalExits: 0, skipped: {} };
  const skip = (r: string) => (stats.skipped[r] = (stats.skipped[r] ?? 0) + 1);

  const initialEquity = opts.initialEquity ?? 1_000_000;
  if (candles.length === 0) {
    const curve: EquityPoint[] = [];
    return {
      trades: [],
      equityCurve: curve,
      metrics: computeMetrics([], curve, initialEquity),
      params,
      baseTimeframe: opts.baseTimeframe ?? strategy.primaryTimeframe,
      stats,
    };
  }

  const baseTf = opts.baseTimeframe ?? inferTimeframe(candles);
  const baseMs = TIMEFRAME_MS[baseTf];
  const primary = strategy.primaryTimeframe;
  const primaryMs = TIMEFRAME_MS[primary];
  const tfs = [...new Set<Timeframe>([...strategy.timeframes, primary])];
  for (const tf of tfs) {
    const ms = TIMEFRAME_MS[tf];
    if (ms < baseMs || ms % baseMs !== 0) throw new Error(`基準足 ${baseTf} から ${tf} は作れません`);
  }
  // 転換で決済の判定の時間足 (戦略へ渡す view には入れない。基準足から作れなければ主時間足)
  const revTf = opts.reversal ? reversalBacktestTimeframe(opts.reversal, primary, baseTf) : primary;
  const revMs = TIMEFRAME_MS[revTf];
  const seriesTfs = tfs.includes(revTf) ? tfs : [...tfs, revTf];

  const costs = instrumentCosts(instrument);
  const spreadBps = opts.spreadBps ?? costs.spreadBps;
  const slippageBps = opts.slippageBps ?? costs.slippageBps;
  const hs = spreadBps / 2 / 1e4;
  const slip = slippageBps / 1e4;
  const feeRate = D(instrument.takerFeeRate);
  const makerRate = D(Number.isFinite(instrument.makerFeeRate) ? instrument.makerFeeRate : instrument.takerFeeRate);
  /** 約定ごとの固定手数料 (Jupiter のネットワーク手数料。クオート通貨建て。無ければ 0 = 従来どおり) */
  const fixedFee = D(fixedFeeOf(instrument));
  const limitOpts = opts.limitOrders;
  // 最大保有 (ライブの MAX_HOLD_MINUTES と同じ前提)。無効なら undefined (シグナルのまま)
  const holdLimitMs = opts.maxHoldMinutes !== undefined && Number.isFinite(opts.maxHoldMinutes) && opts.maxHoldMinutes > 0
    ? Math.round(opts.maxHoldMinutes * 60_000)
    : undefined;
  const limitTp = limitOpts?.takeProfit === true;
  const thesis = opts.thesis ?? THESIS_DISABLED;
  // 建値ストップ (有効なときだけ。無ければ従来どおり)
  const breakeven = breakevenEnabled(opts.breakeven) ? opts.breakeven : undefined;
  // 転換で決済 (有効で、この戦略が対象のときだけ。無ければ従来どおり)
  const reversal = opts.reversal && reversalAppliesTo(opts.reversal, strategy.id) ? opts.reversal : undefined;
  if (reversal) stats.reversalExits = 0;
  /** シグナルの読みの期限 (最大保有で丸める。無ければ undefined = maxHoldMs を期限にする) */
  const expectedOf = (sig: Signal): number | undefined =>
    sig.expectedMs !== undefined && Number.isFinite(sig.expectedMs) && sig.expectedMs > 0
      ? holdLimitMs !== undefined ? Math.min(sig.expectedMs, holdLimitMs) : sig.expectedMs
      : undefined;
  const limitTimeoutMs = limitOpts?.entryTimeoutMs !== undefined && limitOpts.entryTimeoutMs > 0
    ? limitOpts.entryTimeoutMs
    : Math.min(15 * 60_000, Math.max(20_000, TIMEFRAME_MS[strategy.primaryTimeframe]));
  if (limitOpts) stats.limitEntries = { placed: 0, filled: 0, expired: 0, canceled: 0 };
  const cs = instrument.contractSize ?? 1;
  const csD = D(cs);
  const riskPerTrade = opts.riskPerTrade ?? defaultRiskLimits().riskPerTrade;
  const riskMultiplier = opts.riskMultiplier ?? 1;
  const maxPositionPct = opts.maxPositionPct ?? defaultRiskLimits().maxPositionPct;
  const sizer = opts.sizer ?? riskBasedSizer;
  const costBps = roundTripCostBps(costFeeRate(instrument), spreadBps, slippageBps);
  const minEdgeRatio = opts.minEdgeToCostRatio ?? 0;
  const historyBars = opts.historyBars ?? Math.max(300, strategy.warmup + 100);
  const regimeOpts = regimeOptionsFor(instrument.assetClass, opts.regime);
  const closeAtEnd = opts.closeAtEnd ?? true;
  const sampleMs = opts.equitySampleMs ?? Math.max(primaryMs, TIMEFRAME_MS["1h"]);
  const idPrefix = opts.idPrefix ?? "bt";
  const postExitBase = Math.max(1, Math.round(((opts.postExitBars ?? 10) * primaryMs) / baseMs));

  // 上位足は全期間を一度だけ集約し、各バーでは「その時点で確定している本数」だけ見せる
  const series = {} as Record<Timeframe, Candle[]>;
  const visible = {} as Record<Timeframe, number>;
  for (const tf of seriesTfs) {
    series[tf] = tf === baseTf ? candles : resample(candles, baseTf, tf);
    visible[tf] = 0;
  }

  const n = candles.length;
  const startIdx = opts.tradeFromTs !== undefined ? candles.findIndex((c) => c.ts >= opts.tradeFromTs!) : 0;
  const trades: TradeRecord[] = [];
  const exitIdx: number[] = [];
  const curve: EquityPoint[] = [];

  let cash = D(initialEquity);
  let pos: OpenPos | null = null;
  let pending: Pending | null = null;
  let lastSample = NaN;
  // バー単位のドローダウン (記録間隔より細かく追跡)
  let peakEquity = initialEquity;
  let barMaxDd = 0;

  /** 読みの管理: 純 R・建値の計算に使う値 (エントリー手数料は実際の額を 1 単位あたりに) */
  const pricingOf = (p: OpenPos): ThesisPricing => {
    const units = p.qtyNum * cs;
    return {
      direction: p.dir === 1 ? "long" : "short",
      entryPrice: p.entryPrice,
      risk: initialRiskPerUnit(p.entryPrice, p.initialStop),
      entryFeePerUnit: units > 0 ? p.entryFee.toNumber() / units : 0,
      takerFeeRate: costFeeRate(instrument),
    };
  };
  /**
   * 転換で決済: 判定の時間足の確定足 (今見えている分) を、エントリーした足の N 本前 (ATR の分も含む) から渡して判定する。
   * 決済するなら次のバーの始値で決済する pending を返す
   */
  const reversalPending = (p: OpenPos, close: number): Pending | null => {
    if (!reversal) return null;
    const ps = series[revTf];
    const end = visible[revTf];
    const e = entryBarIndex(ps, p.entryTs, revMs);
    if (!(e >= 0 && e < end)) return null;
    const from = Math.max(0, Math.min(e - reversal.pivotN, end - REVERSAL_ATR_WINDOW));
    const r = checkReversal(ps.slice(from, end), p.entryTs, p.dir === 1 ? "long" : "short", {
      pivotN: reversal.pivotN, bufferAtr: reversal.bufferAtr, tfMs: revMs, fallback: reversal.fallback,
    });
    return r.exit ? { kind: "exit", intended: close, reason: "reversal" } : null;
  };
  /** 読みの管理を使う建玉なら期限 (ms) */
  const thesisMsOf = (p: OpenPos) => activeThesisMs(thesis, p.expectedMs, p.maxHoldMs, initialRiskPerUnit(p.entryPrice, p.initialStop));

  const currentStop = (p: OpenPos): { stop: number; reason: ExitReason; byThesis: boolean; byBreakeven: boolean } => {
    let stop = p.initialStop;
    let reason: ExitReason = "stop";
    let byThesis = false;
    let byBreakeven = false;
    if (p.trailPct !== undefined && p.trailPct > 0) {
      const trail = p.dir === 1 ? p.highWater * (1 - p.trailPct) : p.lowWater * (1 + p.trailPct);
      if (p.dir === 1 ? trail > p.initialStop : trail < p.initialStop) {
        stop = trail;
        reason = "trailing";
      }
    }
    // 読みの管理で延長した建玉: 建値 (手数料込み) と 延長後の極値 (前バーまで) − THESIS_TRAIL_R × リスク の有利な方 (きつい方を使う)
    if (p.extendedAt !== undefined && thesisMsOf(p) !== undefined) {
      const t = thesisTrailStop(pricingOf(p), p.thesisPeak ?? Number.NaN, thesis.trailR);
      if (t !== undefined && (p.dir === 1 ? t > stop : t < stop)) {
        stop = t;
        reason = "trailing";
        byThesis = true;
      }
    }
    // 建値ストップ (発動済みなら。きつい方を使う)
    if (p.breakevenStop !== undefined && (p.dir === 1 ? p.breakevenStop > stop : p.breakevenStop < stop)) {
      stop = p.breakevenStop;
      reason = "trailing";
      byThesis = false;
      byBreakeven = true;
    }
    return { stop, reason, byThesis, byBreakeven };
  };

  /** 建値ストップの発動 (バーの終値で判定。発動したらストップを保存し、次のバーから効く) */
  const armBreakeven = (p: OpenPos, close: number) => {
    if (!breakeven || p.breakevenStop !== undefined) return;
    const risk = initialRiskPerUnit(p.entryPrice, p.initialStop);
    if (!breakevenTriggered(breakeven, p.dir === 1 ? "long" : "short", p.entryMid > 0 ? p.entryMid : p.entryPrice, risk, close)) return;
    const units = p.qtyNum * cs;
    const st = breakevenStopPrice({
      direction: p.dir === 1 ? "long" : "short",
      entryPrice: p.entryPrice,
      entryFeePerUnit: units > 0 ? p.entryFee.toNumber() / units : 0,
      exitFeeRate: costFeeRate(instrument, units > 0 ? p.entryPrice * units : undefined),
      halfSpreadRate: hs,
    });
    if (st !== undefined) p.breakevenStop = st;
  };

  /** byThesis: 延長後の保護ストップでの決済 (TradeRecord.thesisStopExit) / byBreakeven: 建値ストップでの決済 (TradeRecord.breakevenStopExit) */
  const closePosition = (
    i: number, px: number, ts: number, reason: ExitReason, intended: number, liq: "maker" | "taker" = "taker", byThesis = false, byBreakeven = false,
  ) => {
    const p = pos!;
    const exitFee = D(px).mul(p.qty).mul(csD).mul(liq === "maker" ? makerRate : feeRate).plus(fixedFee);
    const gross = D(px).minus(p.entryPrice).mul(p.qty).mul(csD).mul(p.dir);
    cash = cash.plus(gross).minus(exitFee);
    const fees = p.entryFee.plus(exitFee);
    const net = gross.minus(fees);
    const notional = D(p.entryPrice).mul(p.qty).mul(csD);
    const risk = D(p.entryPrice).minus(p.initialStop).abs().mul(p.qty).mul(csD);
    const maxHigh = Math.max(p.maxHigh, px);
    const minLow = Math.min(p.minLow, px);
    const fav = p.dir === 1 ? maxHigh - p.entryPrice : p.entryPrice - minLow;
    const adv = p.dir === 1 ? p.entryPrice - minLow : maxHigh - p.entryPrice;
    // 仲値基準の MFE/MAE (ライブの journal の仲値の高値・安値に合わせる): 保有中の足の高値・安値と想定決済価格
    // (損切り・利確・始値など、足の値動きが届いた基準の価格) を使い、スプレッド・スリッページ込みの決済の約定価格は含めない
    const ref = Number.isFinite(intended) && intended > 0 ? intended : p.entryMid;
    const midHigh = Math.max(p.entryMid, p.maxHigh, ref);
    const midLow = Math.min(p.entryMid, p.minLow, ref);
    const favMid = p.dir === 1 ? midHigh - p.entryMid : p.entryMid - midLow;
    const advMid = p.dir === 1 ? p.entryMid - midLow : midHigh - p.entryMid;
    trades.push({
      id: `${idPrefix}-${strategy.id}-${instrument.symbol}-${p.entryTs}`,
      mode: "backtest",
      symbol: instrument.symbol,
      venue: instrument.venue,
      assetClass: instrument.assetClass,
      strategyId: strategy.id,
      horizon: strategy.horizon,
      direction: p.dir === 1 ? "long" : "short",
      qty: p.qtyNum,
      entryTs: p.entryTs,
      entryPrice: p.entryPrice,
      intendedEntryPrice: p.intendedEntryPrice,
      exitTs: ts,
      exitPrice: px,
      intendedExitPrice: intended,
      initialStop: p.initialStop,
      takeProfit: p.takeProfit,
      grossPnl: gross.toNumber(),
      fees: fees.toNumber(),
      netPnl: net.toNumber(),
      returnPct: notional.gt(0) ? net.div(notional).toNumber() : 0,
      rMultiple: risk.gt(0) ? net.div(risk).toNumber() : 0,
      mfePct: Math.max(0, fav / p.entryPrice),
      maePct: Math.max(0, adv / p.entryPrice),
      ...(p.entryMid > 0 && Number.isFinite(p.entryMid)
        ? { entryMid: p.entryMid, mfeMidPct: Math.max(0, favMid / p.entryMid), maeMidPct: Math.max(0, advMid / p.entryMid) }
        : {}),
      exitReason: reason,
      entryContext: p.context,
      ...(() => {
        const ms = thesisMsOf(p);
        if (ms === undefined) return {};
        return {
          thesisExpectedMs: ms,
          thesisDeadlineTs: p.entryTs + ms,
          ...(p.extendedAt !== undefined ? { thesisExtendedAt: p.extendedAt } : {}),
          thesisOutcome: thesisOutcomeOf(reason, p.extendedAt !== undefined),
          ...(p.netRAtDeadline !== undefined && Number.isFinite(p.netRAtDeadline) ? { thesisNetRAtDeadline: p.netRAtDeadline } : {}),
          ...(byThesis && reason === "trailing" ? { thesisStopExit: true } : {}),
        };
      })(),
      ...(byBreakeven && reason === "trailing" ? { breakevenStopExit: true } : {}),
      ...(limitOpts
        ? {
            entryOrderType: p.entryLiq === "maker" ? ("limit" as const) : ("market" as const),
            exitOrderType: liq === "maker" ? ("limit" as const) : ("market" as const),
            makerFees: (p.entryLiq === "maker" ? p.entryFee : D(0)).plus(liq === "maker" ? exitFee : 0).toNumber(),
            takerFees: (p.entryLiq === "taker" ? p.entryFee : D(0)).plus(liq === "taker" ? exitFee : 0).toNumber(),
          }
        : {}),
    });
    exitIdx.push(i);
    pos = null;
  };

  /** 成行約定価格 (買いは +、売りは -) */
  const marketFill = (mid: number, buy: boolean) => mid * (buy ? 1 + hs + slip : 1 - hs - slip);

  const checkStops = (i: number, bar: Candle) => {
    const p = pos!;
    const { stop, reason, byThesis, byBreakeven: byBe } = currentStop(p);
    // 指値で約定した足では利確を判定しない (足の中で約定と利確の順序が分からない。損切りは判定する = 保守的)
    const tp = p.limitFillIdx === i ? undefined : p.takeProfit;
    const end = bar.ts + baseMs;
    if (limitTp) {
      // 利確は板に置いた指値: 価格が利確価格を越えたときだけ利確価格で maker 約定 (触れただけでは約定しない)。損切りを先に判定する
      if (p.dir === 1) {
        if (bar.open <= stop) return closePosition(i, marketFill(bar.open, false), bar.ts, reason, stop, "taker", byThesis, byBe);
        if (tp !== undefined && bar.open > tp) return closePosition(i, tp, bar.ts, "take_profit", tp, "maker");
        if (bar.low <= stop) return closePosition(i, marketFill(stop, false), end, reason, stop, "taker", byThesis, byBe);
        if (tp !== undefined && bar.high > tp) return closePosition(i, tp, end, "take_profit", tp, "maker");
      } else {
        if (bar.open >= stop) return closePosition(i, marketFill(bar.open, true), bar.ts, reason, stop, "taker", byThesis, byBe);
        if (tp !== undefined && bar.open < tp) return closePosition(i, tp, bar.ts, "take_profit", tp, "maker");
        if (bar.high >= stop) return closePosition(i, marketFill(stop, true), end, reason, stop, "taker", byThesis, byBe);
        if (tp !== undefined && bar.low < tp) return closePosition(i, tp, end, "take_profit", tp, "maker");
      }
      return;
    }
    if (p.dir === 1) {
      if (bar.open <= stop) return closePosition(i, marketFill(bar.open, false), bar.ts, reason, stop, "taker", byThesis, byBe);
      if (tp !== undefined && bar.open * (1 - hs) >= tp) return closePosition(i, bar.open * (1 - hs), bar.ts, "take_profit", tp);
      if (bar.low <= stop) return closePosition(i, marketFill(stop, false), end, reason, stop, "taker", byThesis, byBe);
      if (tp !== undefined && bar.high * (1 - hs) >= tp) return closePosition(i, tp, end, "take_profit", tp);
    } else {
      if (bar.open >= stop) return closePosition(i, marketFill(bar.open, true), bar.ts, reason, stop, "taker", byThesis, byBe);
      if (tp !== undefined && bar.open * (1 + hs) <= tp) return closePosition(i, bar.open * (1 + hs), bar.ts, "take_profit", tp);
      if (bar.high >= stop) return closePosition(i, marketFill(stop, true), end, reason, stop, "taker", byThesis, byBe);
      if (tp !== undefined && bar.low * (1 + hs) <= tp) return closePosition(i, tp, end, "take_profit", tp);
    }
  };

  const markEquity = (close: number): Decimal => {
    if (!pos) return cash;
    const p: OpenPos = pos;
    return cash.plus(D(close).minus(p.entryPrice).mul(p.qty).mul(csD).mul(p.dir));
  };

  for (let i = 0; i < n; i++) {
    const bar = candles[i];
    const now = bar.ts + baseMs;
    const trading = i >= startIdx && startIdx >= 0;

    // 1. 前バーで決まった注文を始値で約定
    if (pending) {
      const pd: Pending = pending;
      pending = null;
      if (pd.kind === "exit" && pos) {
        closePosition(i, marketFill(bar.open, pos.dir === -1), bar.ts, pd.reason, pd.intended);
        if (pd.reason === "reversal") stats.reversalExits = (stats.reversalExits ?? 0) + 1;
        else stats.signalExits++;
      } else if (pd.kind === "entry" && !pos) {
        const dir: 1 | -1 = pd.signal.direction === "long" ? 1 : -1;
        const px = marketFill(bar.open, dir === 1);
        const entryFee = D(px).mul(pd.qty).mul(csD).mul(feeRate).plus(fixedFee);
        cash = cash.minus(entryFee);
        pos = {
          dir,
          qty: pd.qty,
          qtyNum: pd.qty.toNumber(),
          entryIdx: i,
          entryTs: bar.ts,
          entryPrice: px,
          intendedEntryPrice: pd.intended,
          entryMid: bar.open,
          entryFee,
          initialStop: pd.signal.stopLoss,
          takeProfit: pd.signal.takeProfit,
          trailPct: pd.signal.trailingStopPct,
          maxHoldMs: clampMaxHoldMs(pd.signal.maxHoldMs, holdLimitMs),
          ...(expectedOf(pd.signal) !== undefined ? { expectedMs: expectedOf(pd.signal) } : {}),
          highWater: bar.open,
          lowWater: bar.open,
          maxHigh: -Infinity,
          minLow: Infinity,
          context: pd.context,
          entryLiq: "taker",
        };
        stats.entries++;
      } else if (pd.kind === "limit" && !pos) {
        // 板に置いた指値: 安値 (買い) が指値を下回った (売りは高値が上回った) ときだけ、指値の価格で maker 約定
        const dir: 1 | -1 = pd.signal.direction === "long" ? 1 : -1;
        const crossed = dir === 1 ? bar.low < pd.price : bar.high > pd.price;
        if (crossed) {
          const entryFee = D(pd.price).mul(pd.qty).mul(csD).mul(makerRate).plus(fixedFee);
          cash = cash.minus(entryFee);
          pos = {
            dir,
            qty: pd.qty,
            qtyNum: pd.qty.toNumber(),
            entryIdx: i,
            entryTs: bar.ts,
            entryPrice: pd.price,
            intendedEntryPrice: pd.intended,
            // 指値の maker 約定はスプレッドを払わないので、約定価格そのものを基準にする
            entryMid: pd.price,
            entryFee,
            initialStop: pd.signal.stopLoss,
            takeProfit: pd.signal.takeProfit,
            trailPct: pd.signal.trailingStopPct,
            maxHoldMs: clampMaxHoldMs(pd.signal.maxHoldMs, holdLimitMs),
            ...(expectedOf(pd.signal) !== undefined ? { expectedMs: expectedOf(pd.signal) } : {}),
            highWater: pd.price,
            lowWater: pd.price,
            maxHigh: -Infinity,
            minLow: Infinity,
            context: pd.context,
            limitFillIdx: i,
            entryLiq: "maker",
          };
          stats.entries++;
          stats.limitEntries!.filled++;
        } else if (i >= pd.expiresIdx) {
          stats.limitEntries!.expired++;
          skip("limit_unfilled");
        } else pending = pd;
      }
    }

    // 2. 時間切れ・読みの管理 (前バーの終値 = この足の始値の時刻までに確定した価格で判定し、この足の始値で決済する。
    //    エントリーしたバーより後だけ。読みの管理が無効・使えない建玉は従来どおり maxHoldMs で time)
    if (pos && i > pos.entryIdx) {
      const p: OpenPos = pos;
      const ms = thesisMsOf(p);
      let netR = NaN;
      let grossR = NaN;
      const close = candles[i - 1].close;
      const mark = p.dir === 1 ? close * (1 - hs) : close * (1 + hs);
      if (ms !== undefined) {
        netR = thesisNetR(pricingOf(p), mark);
        // 途中で読み外れは値動きだけ (終値を仲値として) で判定する (コストだけでは切らない)
        grossR = thesisGrossR(pricingOf(p), close);
      }
      const d = decideThesis(
        { elapsedMs: bar.ts - p.entryTs, expectedMs: p.expectedMs, maxHoldMs: p.maxHoldMs, extended: p.extendedAt !== undefined, netR, grossR },
        ms !== undefined ? thesis : THESIS_DISABLED,
      );
      if (d.extend) {
        // 延長: 保護ストップ (建値・トレーリング) はこの足 (判定した足の次) から効く。
        // 延長後の極値は判定に使った終値の決済できる価格から始める (延長より前の高値・安値は使わない)
        p.extendedAt = bar.ts;
        p.netRAtDeadline = d.extend.netR;
        p.thesisPeak = mark;
      }
      if (d.exit) {
        if (d.exit.reason === "thesis_timeout" && d.exit.netR !== undefined) p.netRAtDeadline = d.exit.netR;
        const { stop, reason, byThesis, byBreakeven } = currentStop(p);
        const gapped = p.dir === 1 ? bar.open <= stop : bar.open >= stop;
        closePosition(
          i, marketFill(bar.open, p.dir === -1), bar.ts, gapped ? reason : d.exit.reason, gapped ? stop : bar.open, "taker", gapped && byThesis, gapped && byBreakeven,
        );
      }
    }

    // 3. 損切り・利確 (バー内)
    if (pos) checkStops(i, bar);

    // 4. 保有中の極値を更新 (次バーのトレーリング・MFE/MAE 用)
    if (pos) {
      const p: OpenPos = pos;
      if (p.limitFillIdx === i) {
        // 指値で約定した足: 有利な側の極値は約定より前だったかもしれない (足の中の順序が分からない) ので使わず、約定価格から始める
        // (トレーリングを約定前の高値で引き上げない・MFE を水増ししない)。不利な側は指値を越えた = 約定の後 (以降) なので含める (保守的)
        const px = p.entryPrice;
        if (p.dir === 1) {
          p.highWater = Math.max(p.highWater, px);
          p.maxHigh = Math.max(p.maxHigh, px);
          p.lowWater = Math.min(p.lowWater, bar.low);
          p.minLow = Math.min(p.minLow, bar.low);
        } else {
          p.lowWater = Math.min(p.lowWater, px);
          p.minLow = Math.min(p.minLow, px);
          p.highWater = Math.max(p.highWater, bar.high);
          p.maxHigh = Math.max(p.maxHigh, bar.high);
        }
      } else {
        p.highWater = Math.max(p.highWater, bar.high);
        p.lowWater = Math.min(p.lowWater, bar.low);
        p.maxHigh = Math.max(p.maxHigh, bar.high);
        p.minLow = Math.min(p.minLow, bar.low);
      }
      // 延長後の極値 (延長した足以降の足だけ。この足の損切りの判定の後なので次の足から効く)
      if (p.extendedAt !== undefined && p.extendedAt <= bar.ts) {
        p.thesisPeak = advancePeak(p.dir === 1 ? "long" : "short", p.thesisPeak, p.dir === 1 ? bar.high * (1 - hs) : bar.low * (1 + hs));
      }
      // 建値ストップの発動 (この足の終値で判定。この足の損切りの判定の後なので次の足から効く)
      armBreakeven(p, bar.close);
    }

    // 5. 最終バーで決済
    if (i === n - 1 && pos && closeAtEnd) {
      closePosition(i, marketFill(bar.close, pos.dir === -1), now, "manual", bar.close);
    }

    // 6. 評価額
    if (trading) {
      const eq = markEquity(bar.close).toNumber();
      if (eq > peakEquity) peakEquity = eq;
      if (peakEquity > 0) barMaxDd = Math.max(barMaxDd, (peakEquity - eq) / peakEquity);
      if (curve.length === 0) curve.push({ ts: bar.ts, equity: initialEquity, mode: "backtest" });
      const bucket = Math.floor(now / sampleMs);
      if (bucket !== lastSample || i === n - 1) {
        curve.push({ ts: now, equity: eq, mode: "backtest" });
        lastSample = bucket;
      }
    }

    // 7. 確定足の更新と戦略判定
    let primaryClosed = false;
    let revClosed = false;
    for (const tf of seriesTfs) {
      const s = series[tf];
      const ms = TIMEFRAME_MS[tf];
      let v = visible[tf];
      while (v < s.length && s[v].ts + ms <= now) v++;
      if (tf === primary && v > visible[tf]) primaryClosed = true;
      if (tf === revTf && v > visible[tf]) revClosed = true;
      visible[tf] = v;
    }
    if (!trading || i >= n - 1) continue;
    if (!primaryClosed && !opts.evaluateEveryBar) {
      // 主時間足は未確定でも、判定の時間足 (lower) が確定したら転換で決済だけを判定する
      if (pos && reversal && revClosed) {
        const pd = reversalPending(pos, bar.close);
        if (pd) pending = pd;
      }
      continue;
    }
    if (visible[primary] < strategy.warmup) continue;

    const quote: Quote = { ts: now, bid: bar.close * (1 - hs), ask: bar.close * (1 + hs), last: bar.close };
    const extras = opts.marketExtras?.(bar, now);
    const view: MarketView = { instrument, now, quote, book: extras?.book, prints: extras?.prints, candles: {} };
    for (const tf of tfs) {
      const v = visible[tf];
      view.candles[tf] = series[tf].slice(Math.max(0, v - historyBars), v);
    }
    const regime: RegimeFeatures = detectRegime(view.candles[primary] ?? [], quote, regimeOpts);
    const intel = resolveIntel(opts.intel, now);
    let position: PositionView | undefined;
    if (pos) {
      const p: OpenPos = pos;
      position = {
        symbol: instrument.symbol,
        qty: p.dir * p.qtyNum,
        avgPrice: p.entryPrice,
        openedAt: p.entryTs,
        strategyId: strategy.id,
        stopLoss: currentStop(p).stop,
        takeProfit: p.takeProfit,
        highWater: p.highWater,
        lowWater: p.lowWater,
      };
    }
    const ctx: StrategyContext = { market: view, regime, intel, position, params };
    stats.evaluations++;
    const signal = strategy.evaluate(ctx);

    if (pos) {
      const p: OpenPos = pos;
      const opposite = signal !== null && ((signal.direction === "long" && p.dir === -1) || (signal.direction === "short" && p.dir === 1));
      if (signal && (signal.direction === "flat" || opposite)) pending = { kind: "exit", intended: bar.close, reason: "signal" };
      else if (reversal && revClosed) {
        const pd = reversalPending(p, bar.close);
        if (pd) pending = pd;
      }
      continue;
    }
    if (!signal) continue;
    if (signal.direction === "flat") continue;
    if (pending && pending.kind === "limit") {
      // 指値のエントリーを待っている: 逆方向のシグナルなら取り消す (同じ方向なら置いたまま待つ)
      if (signal.direction !== pending.signal.direction) {
        pending = null;
        stats.limitEntries!.canceled++;
        skip("limit_canceled");
      }
      continue;
    }
    stats.entrySignals++;
    if (signal.direction === "short" && !instrument.allowShort) {
      skip("short");
      continue;
    }
    // 期待値 / コストの比 (ライブの RiskManager と同じ規則)。コスト控除後の期待値 (edgeIsNet) のシグナルは
    // 「期待値 ≥ max(0, 比率 − 1) × コスト かつ 期待値 > 0」(コストを二重に数えない)。「期待値 > 0」は比率が 0 (フィルターなし) でも求める
    // (NaN も通さない)。それ以外のシグナルは比率 > 0 のときだけ「期待値 ≥ 比率 × コスト」
    {
      const edge = signal.expectedEdgeBps;
      const edgeOk = signal.edgeIsNet === true
        ? edge > 0 && (minEdgeRatio > 0 ? edge >= netEdgeMinBps(minEdgeRatio, costBps) : true)
        : !(minEdgeRatio > 0) || edge >= minEdgeRatio * costBps;
      if (!edgeOk) {
        skip("edge");
        continue;
      }
    }
    // 指値にするか (limitOrders があるときだけ): シグナルの指値 (価格あり) → 戦略の entryOrder → limitOrders.entry
    const signalLimit = signal.entry.type === "limit" && signal.entry.price !== undefined && signal.entry.price > 0;
    const useLimit = limitOpts !== undefined && (signalLimit || (strategy.entryOrder ? strategy.entryOrder === "limit" : limitOpts.entry === true));
    const marketPx = signal.direction === "long" ? quote.ask : quote.bid;
    // 指値の価格: シグナルの価格、無ければ買いは買い気配・売りは売り気配 (板に置く側)。サイズの計算もこの価格
    const limitPx = useLimit ? (signalLimit ? signal.entry.price! : signal.direction === "long" ? quote.bid : quote.ask) : undefined;
    const intended = limitPx ?? (signalLimit ? signal.entry.price! : marketPx);
    const validStop = signal.direction === "long" ? signal.stopLoss < intended : signal.stopLoss > intended;
    if (!validStop || !(signal.stopLoss > 0)) {
      skip("stop");
      continue;
    }
    const equity = cash.toNumber();
    if (!(equity > 0)) {
      skip("equity");
      continue;
    }
    let qtyRaw = sizer({ equity, price: intended, stopLoss: signal.stopLoss, riskPerTrade, riskMultiplier, contractSize: cs, signal, instrument });
    const capQty = (equity * maxPositionPct) / (intended * cs);
    if (maxPositionPct > 0 && qtyRaw > capQty) qtyRaw = capQty;
    if (!(qtyRaw > 0) || !Number.isFinite(qtyRaw)) {
      skip("size");
      continue;
    }
    const qty = floorToStep(qtyRaw, instrument.lotSize);
    const notional = qty.mul(intended).mul(cs).toNumber();
    if (qty.lte(0) || qty.lt(instrument.minQty) || (instrument.minNotional !== undefined && notional < instrument.minNotional)) {
      skip("size");
      continue;
    }
    const context: EntryContext = {
      regime,
      intel,
      confidence: signal.confidence,
      expectedEdgeBps: signal.expectedEdgeBps,
      costBps,
      params: { ...params },
      features: { ...signal.features },
      riskMultiplier,
      reason: signal.reason,
    };
    if (limitPx !== undefined) {
      const bars = Math.max(1, Math.ceil(limitTimeoutMs / baseMs));
      pending = { kind: "limit", signal, qty, intended: marketPx, price: limitPx, expiresIdx: i + bars, context };
      stats.limitEntries!.placed++;
    } else pending = { kind: "entry", signal, qty, intended, context };
  }

  // エグジット後の値動き (方向付き)
  for (let k = 0; k < trades.length; k++) {
    const j = exitIdx[k] + postExitBase;
    if (j < n) {
      const t = trades[k];
      const dir = t.direction === "long" ? 1 : -1;
      t.postExitMovePct = (dir * (candles[j].close - t.exitPrice)) / t.exitPrice;
    }
  }

  const metrics = computeMetrics(trades, curve, initialEquity, { periodMs: sampleMs });
  // 最大ドローダウンはバー単位の評価額で計算する (記録間隔より細かい)
  metrics.maxDrawdown = Math.max(metrics.maxDrawdown, barMaxDd);
  return { trades, equityCurve: curve, metrics, params, baseTimeframe: baseTf, stats };
}
