import type { Candle } from "../core/types";

/**
 * 時系列指標 (純粋関数)。
 * - 配列版は入力と同じ長さを返し、ウォームアップ部 (値が定まらない区間) は NaN。
 * - `*Last` 系は末尾値だけを計算する簡易版 (戦略・バックテストの高速化用)。
 * - 標準偏差は母標準偏差 (n で割る)。
 */

const nanArray = (n: number): number[] => new Array<number>(n).fill(NaN);
const toPeriod = (p: number): number => Math.max(1, Math.round(p));

/** 末尾値 (空なら NaN) */
export function last(series: readonly number[]): number {
  return series.length > 0 ? series[series.length - 1] : NaN;
}

export const closesOf = (candles: readonly Candle[]): number[] => candles.map((c) => c.close);
export const volumesOf = (candles: readonly Candle[]): number[] => candles.map((c) => c.volume);

// ───────────────────────── 移動平均 ─────────────────────────

/** 単純移動平均 */
export function sma(values: readonly number[], period: number): number[] {
  const p = toPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  let sum = 0;
  let bad = 0; // 窓内の NaN 数
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v;
    else bad++;
    if (i >= p) {
      const old = values[i - p];
      if (Number.isFinite(old)) sum -= old;
      else bad--;
    }
    if (i >= p - 1 && bad === 0) out[i] = sum / p;
  }
  return out;
}

export function smaLast(values: readonly number[], period: number): number {
  const p = toPeriod(period);
  const n = values.length;
  if (n < p) return NaN;
  let sum = 0;
  for (let i = n - p; i < n; i++) sum += values[i];
  return sum / p;
}

/**
 * 指数移動平均。先頭の NaN を飛ばし、最初の period 本の SMA を初期値にする。
 * 途中の NaN は直前の値を据え置く (出力は NaN)。
 */
export function ema(values: readonly number[], period: number): number[] {
  const p = toPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  let start = 0;
  while (start < n && !Number.isFinite(values[start])) start++;
  if (n - start < p) return out;
  let sum = 0;
  for (let i = start; i < start + p; i++) sum += values[i];
  let e = sum / p;
  out[start + p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = start + p; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    e = v * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function emaLast(values: readonly number[], period: number): number {
  return last(ema(values, period));
}

// ───────────────────────── オシレーター ─────────────────────────

/** RSI (Wilder の平滑化)。最初の値は index = period */
export function rsi(values: readonly number[], period = 14): number[] {
  const p = toPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  if (n <= p) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / p;
  let al = loss / p;
  const calc = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[p] = calc();
  for (let i = p + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = calc();
  }
  return out;
}

export function rsiLast(values: readonly number[], period = 14): number {
  return last(rsi(values, period));
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  hist: number[];
}

/** MACD。シグナル線は MACD 線の有効区間に対する EMA */
export function macd(values: readonly number[], fast = 12, slow = 26, signal = 9): MacdResult {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => ef[i] - es[i]);
  const sig = ema(line, signal);
  const hist = line.map((m, i) => m - sig[i]);
  return { macd: line, signal: sig, hist };
}

// ───────────────────────── ボラティリティ・レンジ ─────────────────────────

/** True Range。先頭は high - low */
export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** ATR (Wilder)。最初の値は index = period - 1 (TR の単純平均)、以降は Wilder 平滑化 */
export function atr(candles: readonly Candle[], period = 14): number[] {
  const p = toPeriod(period);
  const n = candles.length;
  const out = nanArray(n);
  if (n < p) return out;
  const tr = trueRange(candles);
  let a = 0;
  for (let i = 0; i < p; i++) a += tr[i];
  a /= p;
  out[p - 1] = a;
  for (let i = p; i < n; i++) {
    a = (a * (p - 1) + tr[i]) / p;
    out[i] = a;
  }
  return out;
}

export function atrLast(candles: readonly Candle[], period = 14): number {
  return last(atr(candles, period));
}

export interface AdxResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

/**
 * ADX / +DI / -DI (Wilder)。
 * +DI/-DI は index = period から、ADX は index = 2*period - 1 から有効。
 */
export function adx(candles: readonly Candle[], period = 14): AdxResult {
  const p = toPeriod(period);
  const n = candles.length;
  const adxOut = nanArray(n);
  const pdi = nanArray(n);
  const mdi = nanArray(n);
  if (n <= p) return { adx: adxOut, plusDI: pdi, minusDI: mdi };
  const tr = trueRange(candles);
  const pdm = new Array<number>(n).fill(0);
  const mdm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }
  let sTr = 0;
  let sP = 0;
  let sM = 0;
  for (let i = 1; i <= p; i++) {
    sTr += tr[i];
    sP += pdm[i];
    sM += mdm[i];
  }
  const dx = nanArray(n);
  for (let i = p; i < n; i++) {
    if (i > p) {
      sTr = sTr - sTr / p + tr[i];
      sP = sP - sP / p + pdm[i];
      sM = sM - sM / p + mdm[i];
    }
    const plus = sTr > 0 ? (100 * sP) / sTr : 0;
    const minus = sTr > 0 ? (100 * sM) / sTr : 0;
    pdi[i] = plus;
    mdi[i] = minus;
    dx[i] = plus + minus > 0 ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0;
  }
  const first = 2 * p - 1;
  if (n > first) {
    let a = 0;
    for (let i = p; i <= first; i++) a += dx[i];
    a /= p;
    adxOut[first] = a;
    for (let i = first + 1; i < n; i++) {
      a = (a * (p - 1) + dx[i]) / p;
      adxOut[i] = a;
    }
  }
  return { adx: adxOut, plusDI: pdi, minusDI: mdi };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
  /** (upper - lower) / middle */
  bandwidth: number[];
  /** (x - lower) / (upper - lower) */
  percentB: number[];
}

/** ボリンジャーバンド (母標準偏差) */
export function bollinger(values: readonly number[], period = 20, mult = 2): BollingerResult {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = mid.map((m, i) => m + mult * sd[i]);
  const lower = mid.map((m, i) => m - mult * sd[i]);
  const bandwidth = mid.map((m, i) => (m !== 0 ? (upper[i] - lower[i]) / m : NaN));
  const percentB = values.map((v, i) => {
    const w = upper[i] - lower[i];
    return w > 0 ? (v - lower[i]) / w : Number.isFinite(w) ? 0.5 : NaN;
  });
  return { middle: mid, upper, lower, bandwidth, percentB };
}

export interface DonchianResult {
  upper: number[];
  lower: number[];
  middle: number[];
}

/**
 * ドンチャンチャネル (現在足を含む直近 period 本の最高値・最安値)。
 * ブレイク判定は「1 本前のチャネル」と現在足の終値を比べること。
 */
export function donchian(candles: readonly Candle[], period = 20): DonchianResult {
  const p = toPeriod(period);
  const n = candles.length;
  const upper = nanArray(n);
  const lower = nanArray(n);
  const middle = nanArray(n);
  for (let i = p - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
    middle[i] = (hi + lo) / 2;
  }
  return { upper, lower, middle };
}

// ───────────────────────── VWAP ─────────────────────────

const typical = (c: Candle) => (c.high + c.low + c.close) / 3;

/** 末尾 period 本の VWAP (典型価格 × 出来高)。出来高 0 の窓は典型価格の単純平均 */
export function vwapLast(candles: readonly Candle[], period = 20): number {
  const p = toPeriod(period);
  const n = candles.length;
  if (n < p) return NaN;
  let pv = 0;
  let v = 0;
  let tp = 0;
  for (let i = n - p; i < n; i++) {
    const t = typical(candles[i]);
    pv += t * candles[i].volume;
    v += candles[i].volume;
    tp += t;
  }
  return v > 1e-12 ? pv / v : tp / p;
}

// ───────────────────────── 統計 ─────────────────────────

function windowStats(values: readonly number[], end: number, p: number): { mean: number; sd: number } {
  let sum = 0;
  for (let j = end - p + 1; j <= end; j++) sum += values[j];
  const mean = sum / p;
  let ss = 0;
  for (let j = end - p + 1; j <= end; j++) {
    const d = values[j] - mean;
    ss += d * d;
  }
  return { mean, sd: Math.sqrt(ss / p) };
}

/** ローリング母標準偏差 (2 パス計算で桁落ちを避ける) */
export function stdev(values: readonly number[], period = 20): number[] {
  const p = toPeriod(period);
  const n = values.length;
  const out = nanArray(n);
  for (let i = p - 1; i < n; i++) out[i] = windowStats(values, i, p).sd;
  return out;
}

export function stdevLast(values: readonly number[], period = 20): number {
  const p = toPeriod(period);
  return values.length >= p ? windowStats(values, values.length - 1, p).sd : NaN;
}

/**
 * x の過去分布 (sample) 内でのパーセンタイル順位 0〜1。
 * (x より小さい数 + 等しい数×0.5) / 件数。sample が空なら NaN。
 */
export function percentileRank(sample: readonly number[], x: number): number {
  let less = 0;
  let equal = 0;
  let cnt = 0;
  for (const v of sample) {
    if (!Number.isFinite(v)) continue;
    cnt++;
    if (v < x) less++;
    else if (v === x) equal++;
  }
  return cnt > 0 ? (less + 0.5 * equal) / cnt : NaN;
}

/** 平均 (空なら NaN) */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** 標本標準偏差 (n-1)。2 件未満なら 0 */
export function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (values.length - 1));
}
