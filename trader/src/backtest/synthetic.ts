import type { Candle, Instrument, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";

/**
 * シード付き乱数による合成ローソク足 (テスト・デモ用)。
 * 幾何ブラウン運動 (GBM) にレジーム切替 (上昇/下降トレンド・レンジ・高ボラ) を加える。
 * 同じシードなら常に同じ結果。
 */

export type SyntheticRegime = "trend_up" | "trend_down" | "range" | "high_vol";

export interface SyntheticSegment {
  regime: SyntheticRegime;
  bars: number;
}

export interface SyntheticOptions {
  seed?: number;
  /** 本数 (segments 指定時は segments の合計が優先) */
  bars?: number;
  timeframe?: Timeframe;
  /** 開始時刻 (既定 2024-01-01T00:00Z, 月曜) */
  startTs?: number;
  startPrice?: number;
  /** 1 本あたりの対数リターン標準偏差 (既定 0.0008。1 分足で日次 約 3%、年率 約 60% の暗号資産相当) */
  vol?: number;
  /** トレンド時の 1 本あたりドリフト (既定 vol × 0.03。トレンドが 1 日続いても日次ボラ程度に収める) */
  trendDrift?: number;
  /** レンジ時のアンカーへの引き戻し強さ (1 本あたり, 既定 0.08) */
  rangeReversion?: number;
  /** 高ボラ時のボラ倍率 (既定 2) */
  highVolMult?: number;
  /** レジーム列を明示する。省略時はランダムに切り替える */
  segments?: SyntheticSegment[];
  /** ランダム切替時の平均区間長 (既定 200) */
  meanSegmentBars?: number;
  /** 平均出来高 (既定 1000) */
  baseVolume?: number;
  /** 1 本を何ステップで生成するか (高値・安値の形成用, 既定 6) */
  subSteps?: number;
}

export interface SyntheticResult {
  candles: Candle[];
  /** 各足のレジーム */
  regimes: SyntheticRegime[];
}

export interface Rng {
  /** [0, 1) の一様乱数 */
  next(): number;
  /** 標準正規乱数 */
  normal(): number;
}

/** mulberry32 + Box-Muller */
export function createRng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const normal = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { next, normal };
}

const REGIME_WEIGHTS: [SyntheticRegime, number][] = [
  ["range", 0.4],
  ["trend_up", 0.2],
  ["trend_down", 0.2],
  ["high_vol", 0.2],
];

function pickRegime(rng: Rng): SyntheticRegime {
  let u = rng.next();
  for (const [r, w] of REGIME_WEIGHTS) {
    if (u < w) return r;
    u -= w;
  }
  return "range";
}

export function generateSynthetic(opts: SyntheticOptions = {}): SyntheticResult {
  const rng = createRng(opts.seed ?? 1);
  const tfMs = TIMEFRAME_MS[opts.timeframe ?? "1m"];
  const startTs = opts.startTs ?? Date.UTC(2024, 0, 1);
  const vol = opts.vol ?? 0.0008;
  const trendDrift = opts.trendDrift ?? vol * 0.03;
  const kappa = opts.rangeReversion ?? 0.08;
  const highVolMult = opts.highVolMult ?? 2;
  const baseVolume = opts.baseVolume ?? 1000;
  const sub = Math.max(1, Math.round(opts.subSteps ?? 6));

  // レジーム列
  const regimes: SyntheticRegime[] = [];
  if (opts.segments && opts.segments.length > 0) {
    for (const s of opts.segments) for (let i = 0; i < s.bars; i++) regimes.push(s.regime);
  } else {
    const bars = opts.bars ?? 1000;
    const meanLen = Math.max(1, opts.meanSegmentBars ?? 200);
    while (regimes.length < bars) {
      const r = pickRegime(rng);
      const len = Math.max(1, Math.round(meanLen * (0.5 + rng.next())));
      for (let i = 0; i < len && regimes.length < bars; i++) regimes.push(r);
    }
  }

  const candles: Candle[] = [];
  let price = opts.startPrice ?? 100;
  let anchor = price;
  for (let i = 0; i < regimes.length; i++) {
    const regime = regimes[i];
    if (i === 0 || regimes[i - 1] !== regime) anchor = price;
    const sigma = vol * (regime === "high_vol" ? highVolMult : 1);
    const drift = regime === "trend_up" ? trendDrift : regime === "trend_down" ? -trendDrift : 0;
    const open = price;
    let high = open;
    let low = open;
    for (let k = 0; k < sub; k++) {
      const pull = regime === "range" ? (kappa * Math.log(anchor / price)) / sub : 0;
      const r = drift / sub + pull - (0.5 * sigma * sigma) / sub + (sigma / Math.sqrt(sub)) * rng.normal();
      price = price * Math.exp(r);
      if (price > high) high = price;
      if (price < low) low = price;
    }
    const close = price;
    const move = Math.abs(Math.log(close / open)) / sigma;
    const regimeMult = regime === "high_vol" ? 2 : regime === "range" ? 1 : 1.3;
    const volume = baseVolume * regimeMult * Math.exp(0.3 * rng.normal()) * (1 + 0.5 * move);
    candles.push({ ts: startTs + i * tfMs, open, high, low, close, volume });
  }
  return { candles, regimes };
}

export function generateCandles(opts: SyntheticOptions = {}): Candle[] {
  return generateSynthetic(opts).candles;
}

/** テスト・デモ用の銘柄 */
export function syntheticInstrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    symbol: "SYN/USDT",
    venue: "paper",
    assetClass: "crypto",
    baseCurrency: "SYN",
    quoteCurrency: "USDT",
    tickSize: 0.0001,
    lotSize: 0.0001,
    minQty: 0.0001,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    allowShort: true,
    ...overrides,
  };
}
