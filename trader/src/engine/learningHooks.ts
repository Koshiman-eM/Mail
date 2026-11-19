/** 学習サービスへ渡すフック (パラメータ検証・任意時刻の価格) */
import { evaluateParams } from "../backtest/evaluate";
import { TIMEFRAME_MS, type AssetClass, type Candle, type Clock, type Instrument, type Params, type Strategy, type Timeframe } from "../core/types";
import type { PriceAt } from "../learning/journal";
import type { ParamValidator } from "../learning/tuner";
import type { MarketHub } from "../market/hub";

type HubLike = Pick<MarketHub, "watched" | "getView">;

export interface ValidationData {
  instrument: Instrument;
  candles: Candle[];
  baseTimeframe: Timeframe;
  /** 主時間足換算の本数 */
  primaryBars: number;
}

/** 検証に必要な最低本数 (主時間足換算) = warmup + この値 */
export const VALIDATION_EXTRA_BARS = 50;

/**
 * 検証用データの選択。資産クラスが一致する監視銘柄のうち、
 * 1m 足または主時間足 (戦略の全時間足を作れるもの) の履歴が最も長いものを使う。
 * データ不足・板が必須の戦略は undefined。
 */
export function pickValidationData(strategy: Strategy, assetClass: AssetClass, hub: HubLike, now: number): ValidationData | undefined {
  if (strategy.requiresBook) return undefined;
  const primaryMs = TIMEFRAME_MS[strategy.primaryTimeframe];
  const needTfs = [...new Set<Timeframe>([...strategy.timeframes, strategy.primaryTimeframe])];
  const bases = [...new Set<Timeframe>(["1m", strategy.primaryTimeframe])].filter((b) =>
    needTfs.every((tf) => TIMEFRAME_MS[tf] >= TIMEFRAME_MS[b] && TIMEFRAME_MS[tf] % TIMEFRAME_MS[b] === 0),
  );
  let best: ValidationData | undefined;
  for (const inst of hub.watched()) {
    if (inst.assetClass !== assetClass) continue;
    const view = hub.getView(inst.symbol, now);
    if (!view) continue;
    for (const tf of bases) {
      const c = view.candles[tf];
      if (!c || c.length === 0) continue;
      const primaryBars = (c.length * TIMEFRAME_MS[tf]) / primaryMs;
      if (!best || primaryBars > best.primaryBars) best = { instrument: inst, candles: c, baseTimeframe: tf, primaryBars };
    }
  }
  if (!best || best.primaryBars < strategy.warmup + VALIDATION_EXTRA_BARS) return undefined;
  return best;
}

export interface ValidatorOptions {
  hub: HubLike;
  strategies: readonly Strategy[];
  clock: Clock;
  /** 実運用と同じ見送り条件 (期待値幅 / コスト) で比較する */
  minEdgeToCostRatio?: number;
  riskPerTrade?: number;
  maxPositionPct?: number;
}

/**
 * パラメータ候補の検証: hub に溜まった基準足 (または主時間足) の履歴で evaluateParams を実行する。
 * データが足りない、または板が必須の戦略は undefined (調整は proposed のまま適用されない)。
 */
export function createParamValidator(o: ValidatorOptions): ParamValidator {
  return async (strategyId: string, assetClass: AssetClass, params: Params) => {
    const s = o.strategies.find((x) => x.id === strategyId);
    if (!s) return undefined;
    const data = pickValidationData(s, assetClass, o.hub, o.clock.now());
    if (!data) return undefined;
    const r = evaluateParams(s, params, data.instrument, data.candles, {
      baseTimeframe: data.baseTimeframe,
      ...(o.minEdgeToCostRatio !== undefined ? { minEdgeToCostRatio: o.minEdgeToCostRatio } : {}),
      ...(o.riskPerTrade !== undefined ? { riskPerTrade: o.riskPerTrade } : {}),
      ...(o.maxPositionPct !== undefined ? { maxPositionPct: o.maxPositionPct } : {}),
    });
    return { score: r.score, trades: r.metrics.trades };
  };
}

/**
 * 任意時刻の価格: hub の 1m 確定足のうち ts を含む足の終値。
 * 履歴の範囲外 (古すぎる・まだ確定していない) なら undefined (学習側が次回再試行する)。
 */
export function createPriceAt(hub: HubLike, clock: Clock): PriceAt {
  return (symbol, ts) => priceFromCandles(hub.getView(symbol, clock.now())?.candles["1m"], ts);
}

/** 1m 確定足 (昇順) のうち ts を含む足の終値。範囲外なら undefined */
export function priceFromCandles(c: readonly Candle[] | undefined, ts: number): number | undefined {
  if (!c || c.length === 0) return undefined;
  const ms = TIMEFRAME_MS["1m"];
  if (ts < c[0].ts || ts >= c[c.length - 1].ts + ms) return undefined;
  // ts 以下で最後の足 (二分探索)
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid].ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  const px = c[lo].close;
  return px > 0 ? px : undefined;
}
