/**
 * 建玉の持ち越し手数料 (GMOコインのレバレッジ取引の「レバレッジ手数料」)。
 *
 * - 対象: instrument.meta.holdingFeeDaily (日率) がある銘柄。買い・売りどちらの建玉にもかかる。
 * - 金額: 建玉代金 × 日率 × 日本時間 6:00 をまたいで保有した回数 (要確認: GMO の計上タイミングと料率 0.04%/日)。
 * - PaperBroker (src/execution/paper.ts) と仮想トレード (src/learning/shadow.ts) が同じ計算を使う。
 */
import type { Instrument } from "./types";

const DAY_MS = 86_400_000;
/** 締めの時刻 (日本時間 6:00 = UTC 21:00) */
export const HOLDING_CUTOFF_UTC_MS = 21 * 3_600_000;

/** (from, to] の間に日本時間 6:00 をまたいだ回数 (ちょうど 6:00 に建てた分は数えず、ちょうど 6:00 まで持てば数える) */
export function jstCutoffCrossings(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return 0;
  return Math.floor((to - HOLDING_CUTOFF_UTC_MS) / DAY_MS) - Math.floor((from - HOLDING_CUTOFF_UTC_MS) / DAY_MS);
}

/** 銘柄の持ち越し手数料の日率 (meta.holdingFeeDaily。無い・不正なら undefined) */
export function holdingFeeDailyOf(inst: Pick<Instrument, "meta"> | undefined): number | undefined {
  const r = inst?.meta?.holdingFeeDaily;
  return typeof r === "number" && Number.isFinite(r) && r >= 0 ? r : undefined;
}
