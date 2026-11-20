import type { AssetClass, Horizon, Strategy } from "../core/types";
import { scalpMomentumBurst, scalpObi, scalpVwapRevert } from "./scalp";
import { scalpMicro } from "./scalpMicro";
import { scalpRebound } from "./scalpRebound";
import { pullback15m, pullback5m, scalpPullback } from "./scalpPullback";
import { shortBreakout, shortEmaTrend, shortRsiRevert } from "./short";
import { midTrendFollow } from "./mid";
import { longMomentum } from "./long";
import { memeMomentum } from "./meme";
import { applyStructure, type StructureSettings } from "../structure/settings";

/** 全戦略 (登録順 = スキャルピング → 短期 → 中期 → 長期 → ミーム) */
export const ALL_STRATEGIES: readonly Strategy[] = [
  scalpObi,
  scalpVwapRevert,
  scalpMomentumBurst,
  scalpMicro,
  scalpRebound,
  scalpPullback,
  shortEmaTrend,
  shortRsiRevert,
  shortBreakout,
  pullback5m,
  pullback15m,
  midTrendFollow,
  longMomentum,
  memeMomentum,
];

/**
 * 運用・バックテスト・パラメータ検証で使う戦略の一覧。相場構造のフィルター (STRUCTURE_MODE=filter) なら対象の戦略をラップする。
 * settings が無い・mode が off なら ALL_STRATEGIES そのもの (従来と同じ)
 */
export function configuredStrategies(settings?: StructureSettings): readonly Strategy[] {
  return applyStructure(ALL_STRATEGIES, settings);
}

const BY_ID = new Map(ALL_STRATEGIES.map((s) => [s.id, s]));

/** ID から戦略を取得 (未登録なら undefined) */
export function getStrategy(id: string): Strategy | undefined {
  return BY_ID.get(id);
}

/** 資産クラス (と時間軸) に対応する戦略 */
export function strategiesFor(assetClass: AssetClass, horizon?: Horizon): Strategy[] {
  return ALL_STRATEGIES.filter((s) => s.assetClasses.includes(assetClass) && (horizon === undefined || s.horizon === horizon));
}

/** 既定パラメータに上書きを合成し、paramBounds の範囲へクランプする */
export function resolveParams(strategy: Strategy, overrides: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...strategy.defaultParams };
  for (const [k, v] of Object.entries(overrides)) {
    if (!Number.isFinite(v)) continue;
    const b = strategy.paramBounds[k];
    out[k] = b ? Math.min(b[1], Math.max(b[0], v)) : v;
  }
  return out;
}
