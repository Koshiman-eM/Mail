import type { AssetClass, Strategy } from "../core/types";
import { scalpMomentumBurst, scalpObi, scalpVwapRevert } from "./scalp";
import { scalpMicro } from "./scalpMicro";
import { scalpRebound } from "./scalpRebound";
import { pullback15m, pullback5m, scalpPullback } from "./scalpPullback";
import { shortBreakout, shortEmaTrend, shortRsiRevert } from "./short";
import { applyStructure, type StructureSettings } from "../structure/settings";

/**
 * 全戦略 (登録順 = スキャルピング → 短期)。廃止した戦略 (中期・長期・ミーム) は src/strategies/retired.ts
 * (保有中の建玉・学習データ・古い .env の互換のための情報だけ)
 */
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
];

/**
 * 運用・バックテスト・パラメータ検証で使う戦略の一覧。相場構造のフィルター (STRUCTURE_MODE=filter) なら対象の戦略をラップする。
 * settings が無い・mode が off なら ALL_STRATEGIES そのもの (従来と同じ)
 */
export function configuredStrategies(settings?: StructureSettings, base: readonly Strategy[] = ALL_STRATEGIES): readonly Strategy[] {
  return applyStructure(base, settings);
}

/**
 * 戦略の資産クラスを置き換えた写し (id・パラメータ・判定は同じ。腕のキー <戦略>|<レジーム>|<資産クラス> はクラスで分かれる)。
 * アプリが登録戦略を自分の資産クラスで使うとき (FX の short_ema_trend など) に、構造フィルターを掛ける前の一覧で使う。
 * 新しく使う戦略は観測専用 (OBSERVE_ONLY_STRATEGIES) から始めること
 */
export function withAssetClasses(s: Strategy, classes: readonly AssetClass[]): Strategy {
  if (classes.length === 0) throw new Error(`${s.id}: 資産クラスを 1 つ以上指定してください`);
  return Object.assign(Object.create(Object.getPrototypeOf(s) as object) as Strategy, s, { assetClasses: [...classes] });
}

/** id の一覧から戦略を選ぶ (未登録の id は例外)。classes を渡すとその資産クラスにする */
export function selectStrategies(ids: readonly string[], classes?: readonly AssetClass[]): Strategy[] {
  return ids.map((id) => {
    const s = getStrategy(id);
    if (!s) throw new Error(`未知の戦略: ${id}`);
    return classes ? withAssetClasses(s, classes) : s;
  });
}

const BY_ID = new Map(ALL_STRATEGIES.map((s) => [s.id, s]));

/** ID から戦略を取得 (未登録なら undefined) */
export function getStrategy(id: string): Strategy | undefined {
  return BY_ID.get(id);
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
