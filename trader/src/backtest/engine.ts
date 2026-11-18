import type {
  AssetClass,
  Candle,
  EntryContext,
  EquityPoint,
  ExitReason,
  IntelBias,
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
import { D, Decimal, floorToStep } from "../core/decimal";
import { DEFAULT_RISK } from "../core/config";
import { resample } from "../indicators/resample";
import { detectRegime, regimeOptionsFor } from "../regime/detect";
import { computeMetrics } from "./metrics";
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
 * 制約: 1 戦略 1 ポジション (ピラミッディング・ドテンなし)。指値エントリーも成行として扱う。
 */

/** 資産クラス別の既定スプレッド (bps, 全幅) とスリッページ (bps, 片道) */
const DEFAULT_COSTS: Record<AssetClass, { spreadBps: number; slippageBps: number }> = {
  crypto: { spreadBps: 2, slippageBps: 1 },
  meme: { spreadBps: 60, slippageBps: 20 },
  fx: { spreadBps: 1, slippageBps: 0.5 },
  stock: { spreadBps: 2, slippageBps: 1 },
};

export function defaultCosts(assetClass: AssetClass): { spreadBps: number; slippageBps: number } {
  return { ...DEFAULT_COSTS[assetClass] };
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
}

type Pending =
  | { kind: "entry"; signal: Signal; qty: Decimal; intended: number; context: EntryContext }
  | { kind: "exit"; intended: number };

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

  const costs = defaultCosts(instrument.assetClass);
  const spreadBps = opts.spreadBps ?? costs.spreadBps;
  const slippageBps = opts.slippageBps ?? costs.slippageBps;
  const hs = spreadBps / 2 / 1e4;
  const slip = slippageBps / 1e4;
  const feeRate = D(instrument.takerFeeRate);
  const cs = instrument.contractSize ?? 1;
  const csD = D(cs);
  const riskPerTrade = opts.riskPerTrade ?? DEFAULT_RISK.riskPerTrade;
  const riskMultiplier = opts.riskMultiplier ?? 1;
  const maxPositionPct = opts.maxPositionPct ?? DEFAULT_RISK.maxPositionPct;
  const sizer = opts.sizer ?? riskBasedSizer;
  const costBps = 2 * instrument.takerFeeRate * 1e4 + spreadBps + 2 * slippageBps;
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
  for (const tf of tfs) {
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

  const currentStop = (p: OpenPos): { stop: number; reason: ExitReason } => {
    if (p.trailPct !== undefined && p.trailPct > 0) {
      const trail = p.dir === 1 ? p.highWater * (1 - p.trailPct) : p.lowWater * (1 + p.trailPct);
      if (p.dir === 1 ? trail > p.initialStop : trail < p.initialStop) return { stop: trail, reason: "trailing" };
    }
    return { stop: p.initialStop, reason: "stop" };
  };

  const closePosition = (i: number, px: number, ts: number, reason: ExitReason, intended: number) => {
    const p = pos!;
    const exitFee = D(px).mul(p.qty).mul(csD).mul(feeRate);
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
      exitReason: reason,
      entryContext: p.context,
    });
    exitIdx.push(i);
    pos = null;
  };

  /** 成行約定価格 (買いは +、売りは -) */
  const marketFill = (mid: number, buy: boolean) => mid * (buy ? 1 + hs + slip : 1 - hs - slip);

  const checkStops = (i: number, bar: Candle) => {
    const p = pos!;
    const { stop, reason } = currentStop(p);
    const tp = p.takeProfit;
    const end = bar.ts + baseMs;
    if (p.dir === 1) {
      if (bar.open <= stop) return closePosition(i, marketFill(bar.open, false), bar.ts, reason, stop);
      if (tp !== undefined && bar.open * (1 - hs) >= tp) return closePosition(i, bar.open * (1 - hs), bar.ts, "take_profit", tp);
      if (bar.low <= stop) return closePosition(i, marketFill(stop, false), end, reason, stop);
      if (tp !== undefined && bar.high * (1 - hs) >= tp) return closePosition(i, tp, end, "take_profit", tp);
    } else {
      if (bar.open >= stop) return closePosition(i, marketFill(bar.open, true), bar.ts, reason, stop);
      if (tp !== undefined && bar.open * (1 + hs) <= tp) return closePosition(i, bar.open * (1 + hs), bar.ts, "take_profit", tp);
      if (bar.high >= stop) return closePosition(i, marketFill(stop, true), end, reason, stop);
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
        closePosition(i, marketFill(bar.open, pos.dir === -1), bar.ts, "signal", pd.intended);
        stats.signalExits++;
      } else if (pd.kind === "entry" && !pos) {
        const dir: 1 | -1 = pd.signal.direction === "long" ? 1 : -1;
        const px = marketFill(bar.open, dir === 1);
        const entryFee = D(px).mul(pd.qty).mul(csD).mul(feeRate);
        cash = cash.minus(entryFee);
        pos = {
          dir,
          qty: pd.qty,
          qtyNum: pd.qty.toNumber(),
          entryIdx: i,
          entryTs: bar.ts,
          entryPrice: px,
          intendedEntryPrice: pd.intended,
          entryFee,
          initialStop: pd.signal.stopLoss,
          takeProfit: pd.signal.takeProfit,
          trailPct: pd.signal.trailingStopPct,
          maxHoldMs: pd.signal.maxHoldMs,
          highWater: bar.open,
          lowWater: bar.open,
          maxHigh: -Infinity,
          minLow: Infinity,
          context: pd.context,
        };
        stats.entries++;
      }
    }

    // 2. 時間切れ (エントリーしたバーより後の始値で判定)
    if (pos && i > pos.entryIdx && pos.maxHoldMs > 0 && bar.ts - pos.entryTs >= pos.maxHoldMs) {
      const p: OpenPos = pos;
      const { stop, reason } = currentStop(p);
      const gapped = p.dir === 1 ? bar.open <= stop : bar.open >= stop;
      closePosition(i, marketFill(bar.open, p.dir === -1), bar.ts, gapped ? reason : "time", gapped ? stop : bar.open);
    }

    // 3. 損切り・利確 (バー内)
    if (pos) checkStops(i, bar);

    // 4. 保有中の極値を更新 (次バーのトレーリング・MFE/MAE 用)
    if (pos) {
      const p: OpenPos = pos;
      p.highWater = Math.max(p.highWater, bar.high);
      p.lowWater = Math.min(p.lowWater, bar.low);
      p.maxHigh = Math.max(p.maxHigh, bar.high);
      p.minLow = Math.min(p.minLow, bar.low);
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
    for (const tf of tfs) {
      const s = series[tf];
      const ms = TIMEFRAME_MS[tf];
      let v = visible[tf];
      while (v < s.length && s[v].ts + ms <= now) v++;
      if (tf === primary && v > visible[tf]) primaryClosed = true;
      visible[tf] = v;
    }
    if (!trading || i >= n - 1) continue;
    if (!primaryClosed && !opts.evaluateEveryBar) continue;
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
    if (!signal) continue;

    if (pos) {
      const p: OpenPos = pos;
      const opposite = (signal.direction === "long" && p.dir === -1) || (signal.direction === "short" && p.dir === 1);
      if (signal.direction === "flat" || opposite) pending = { kind: "exit", intended: bar.close };
      continue;
    }
    if (signal.direction === "flat") continue;
    stats.entrySignals++;
    if (signal.direction === "short" && !instrument.allowShort) {
      skip("short");
      continue;
    }
    if (minEdgeRatio > 0 && signal.expectedEdgeBps < minEdgeRatio * costBps) {
      skip("edge");
      continue;
    }
    const intended =
      signal.entry.type === "limit" && signal.entry.price ? signal.entry.price : signal.direction === "long" ? quote.ask : quote.bid;
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
    pending = { kind: "entry", signal, qty, intended, context };
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
