import type { Candle } from "../core/types";
import type { Pivot, PivotLabel } from "./types";

/** 左右の本数を 1 以上の整数にそろえる */
export const normalizePivotN = (n: number): number => Math.max(1, Math.round(Number.isFinite(n) ? n : 6));

/**
 * スイングハイ・スイングローの検出 (確定ラグあり)。
 * - SH: 足 i の高値が、左 N 本のどの高値よりも高く (>)、右 N 本のどの高値以上 (>=) でもある。
 *   同値が並ぶ頂 (ティック刻みのデータ) は、窓内で最も早い足だけがピボットになる (決定的。1 つの頂に 1 つ)
 * - SL: 安値で同様 (左は <、右は <=)
 * - 足 i のピボットが判定できるのは足 i+N が確定した時点 → confirmedAt = i + N
 * - 同じ足が SH と SL の両方になることがある (包み足)。その場合は SH → SL の順に並べる
 * - label は 1 つ前の同じ種類のピボットとの比較 (HH/LH/EH、HL/LL/EL)。前のピボットは必ず先に確定しているので先読みにならない
 *
 * 配列の末尾 N 本はまだ判定できないので含めない (入力を k までに切っても、確定済みの結果は変わらない)。
 */
export function detectPivots(candles: readonly Candle[], N = 6): Pivot[] {
  const n = normalizePivotN(N);
  const out: Pivot[] = [];
  let prevSH: Pivot | undefined;
  let prevSL: Pivot | undefined;
  for (let i = n; i + n < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = Number.isFinite(h);
    let isLow = Number.isFinite(l);
    for (let j = i - n; j <= i + n && (isHigh || isLow); j++) {
      if (j === i) continue;
      const left = j < i;
      if (isHigh && !(left ? h > candles[j].high : h >= candles[j].high)) isHigh = false;
      if (isLow && !(left ? l < candles[j].low : l <= candles[j].low)) isLow = false;
    }
    if (isHigh) {
      const p: Pivot = { idx: i, ts: candles[i].ts, price: h, type: "SH", confirmedAt: i + n };
      if (prevSH) p.label = labelOf(h, prevSH.price, "HH", "LH", "EH");
      out.push(p);
      prevSH = p;
    }
    if (isLow) {
      const p: Pivot = { idx: i, ts: candles[i].ts, price: l, type: "SL", confirmedAt: i + n };
      if (prevSL) p.label = labelOf(l, prevSL.price, "HL", "LL", "EL");
      out.push(p);
      prevSL = p;
    }
  }
  return out;
}

const labelOf = (x: number, prev: number, higher: PivotLabel, lower: PivotLabel, equal: PivotLabel): PivotLabel =>
  x > prev ? higher : x < prev ? lower : equal;

/** ピボットのうち、足 k の時点で確定しているもの (confirmedAt <= k) */
export function confirmedPivots(pivots: readonly Pivot[], k: number): Pivot[] {
  return pivots.filter((p) => p.confirmedAt <= k);
}
