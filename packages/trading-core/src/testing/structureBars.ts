/** 相場構造のテスト用: 手作りの足の列 (合成データ) */
import type { Candle, Timeframe } from "../core/types";
import { TIMEFRAME_MS } from "../core/types";

export const T0 = Date.UTC(2026, 0, 5);

/** 価格の列 → 足 (始値・高値・安値・終値がすべて同じ「線」の足。ピボットは価格の列の極値になる) */
export function lineBars(prices: readonly number[], tf: Timeframe = "15m", start = T0): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  return prices.map((p, i) => ({ ts: start + i * ms, open: p, high: p, low: p, close: p, volume: 1 }));
}

/** 折れ線 (1 本あたり 1 ずつ動く) の価格の列。path(100, 110, 104) → 100, 101, ..., 110, 109, ..., 104 */
export function path(...points: number[]): number[] {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const step = b > a ? 1 : -1;
    for (let x = a + step; step > 0 ? x <= b : x >= b; x += step) out.push(x);
  }
  return out;
}

/** 添字 (価格の列で最初に x になった位置) */
export const indexOfPrice = (prices: readonly number[], x: number, from = 0): number => prices.indexOf(x, from);
