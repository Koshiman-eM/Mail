import type { AssetClass, Candle, Quote, RegimeFeatures } from "../core/types";
import { adx, atr, ema } from "../indicators/series";
import { percentileRank } from "../indicators/series";
import { spreadBps as calcSpreadBps } from "../indicators/microstructure";

/**
 * レジーム (相場環境) 判定。優先順位:
 *   1. スプレッドが閾値超 → low_liquidity
 *   2. ボラティリティ (ATR/価格) の過去パーセンタイル > highVolPercentile → high_vol
 *   3. ADX > trendAdx → EMA 傾きの符号で trend_up / trend_down
 *   4. それ以外 → range
 */
export interface RegimeOptions {
  /** これを超えるスプレッド (bps) は low_liquidity */
  maxSpreadBps: number;
  atrPeriod: number;
  adxPeriod: number;
  emaPeriod: number;
  /** EMA 傾きを測る本数 */
  slopeBars: number;
  /** ボラティリティのパーセンタイルを測る過去本数 */
  volLookback: number;
  highVolPercentile: number;
  trendAdx: number;
}

export const DEFAULT_REGIME_OPTIONS: RegimeOptions = {
  maxSpreadBps: 30,
  atrPeriod: 14,
  adxPeriod: 14,
  emaPeriod: 20,
  slopeBars: 5,
  volLookback: 100,
  highVolPercentile: 0.9,
  trendAdx: 25,
};

/** 資産クラス別の既定値 (主にスプレッド閾値) */
export function regimeOptionsFor(assetClass: AssetClass, overrides: Partial<RegimeOptions> = {}): RegimeOptions {
  const spread: Record<AssetClass, number> = { crypto: 30, meme: 150, fx: 8, stock: 30 };
  return { ...DEFAULT_REGIME_OPTIONS, maxSpreadBps: spread[assetClass], ...overrides };
}

/** パーセンタイル計算に必要な最小サンプル数 (未満なら 0.5 = 不明) */
const MIN_VOL_SAMPLES = 20;

export function detectRegime(candles: readonly Candle[], quote: Quote | undefined, opts: Partial<RegimeOptions> = {}): RegimeFeatures {
  const o: RegimeOptions = { ...DEFAULT_REGIME_OPTIONS, ...opts };
  const sp = quote ? calcSpreadBps(quote) : NaN;
  const spread = Number.isFinite(sp) ? sp : 0;

  // 必要な分だけ末尾を使う (計算量を抑える)
  const need = Math.max(o.volLookback + o.atrPeriod, 2 * o.adxPeriod + 50, o.emaPeriod * 3 + o.slopeBars);
  const c = candles.length > need ? candles.slice(candles.length - need) : candles;
  const n = c.length;

  let volatility = 0;
  let volPct = 0.5;
  let strength = 0;
  let trend = 0;

  if (n >= o.atrPeriod) {
    const a = atr(c, o.atrPeriod);
    const vol = a.map((v, i) => (c[i].close > 0 ? v / c[i].close : NaN));
    const cur = vol[n - 1];
    if (Number.isFinite(cur)) {
      volatility = cur;
      const hist = vol.slice(Math.max(0, n - o.volLookback), n - 1).filter((v) => Number.isFinite(v));
      if (hist.length >= MIN_VOL_SAMPLES) volPct = percentileRank(hist, cur);
    }
    const ad = adx(c, o.adxPeriod).adx[n - 1];
    if (Number.isFinite(ad)) strength = ad;

    const e = ema(
      c.map((x) => x.close),
      o.emaPeriod,
    );
    const atrNow = a[n - 1];
    const e0 = e[n - 1];
    const e1 = e[n - 1 - o.slopeBars];
    if (Number.isFinite(e0) && Number.isFinite(e1) && atrNow > 0) {
      // 1 本あたりの EMA 変化を ATR で正規化し、tanh で -1〜1 に収める
      const slope = (e0 - e1) / (o.slopeBars * atrNow);
      trend = Math.tanh(2 * slope);
    }
  }

  let label: RegimeFeatures["label"];
  if (spread > o.maxSpreadBps) label = "low_liquidity";
  else if (volPct > o.highVolPercentile) label = "high_vol";
  else if (strength > o.trendAdx && trend !== 0) label = trend > 0 ? "trend_up" : "trend_down";
  else label = "range";

  return {
    label,
    trend,
    trendStrength: strength,
    volatility,
    volatilityPercentile: volPct,
    spreadBps: spread,
  };
}
