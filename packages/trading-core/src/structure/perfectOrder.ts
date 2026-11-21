import { ema, sma } from "../indicators/series";
import type { Bias, PerfectOrderOptions } from "./types";

/**
 * パーフェクトオーダー (3 本の移動平均の並び)。各足の判定を返す。
 * 短期 > 中期 > 長期 なら up、短期 < 中期 < 長期 なら down、それ以外 (計算できない足を含む) は none。
 * SMA も EMA も各足の値はその足までの終値だけで決まる (先読みしない)
 */
export function perfectOrderSeries(closes: readonly number[], o: PerfectOrderOptions): Bias[] {
  const f = o.type === "ema" ? ema : sma;
  const [s, m, l] = o.periods.map((p) => f(closes, p));
  return closes.map((_, i) => {
    const a = s[i];
    const b = m[i];
    const c = l[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return "none";
    if (a > b && b > c) return "up";
    if (a < b && b < c) return "down";
    return "none";
  });
}
