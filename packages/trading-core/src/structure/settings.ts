/** 環境変数 (STRUCTURE_*) → 相場構造のラッパーの設定と、戦略の一覧への適用 */
import { DEFAULT_STRUCTURE_STRATEGIES, type CoreEnv } from "../core/config";
import type { Strategy } from "../core/types";
import { strategyIdListWarnings } from "../strategies/retired";
import { DEFAULT_PERFECT_ORDER } from "./types";
import { DEFAULT_STRUCTURE_FILTER_CONFIG, resolveStructureFilterConfig, withStructure, type StructureFilterConfig } from "./wrap";

export type StructureMode = "off" | "filter";

export interface StructureSettings {
  mode: StructureMode;
  /** ラップする戦略 id */
  strategies: readonly string[];
  config: StructureFilterConfig;
}

/**
 * 既定の対象 (トレンド・ブレイク系)。目線の方向に乗ること自体が前提なので、目線と逆向きのシグナルを除くフィルターと噛み合う。
 * - scalp_momentum_burst / scalp_micro: 1m の勢い・ブレイクに乗る
 * - short_ema_trend / short_breakout: EMA の順張り・チャネルのブレイク
 * - mid_trend_follow: 4 時間足の EMA の順張り (廃止前と同じく対象。上位足は 1d。hub に 1d が無ければ 4h から確定分だけ集約する)
 */
export const DEFAULT_STRUCTURE_TARGETS: readonly string[] = DEFAULT_STRUCTURE_STRATEGIES.split(",");

/**
 * 既定で対象外にする戦略と理由。目線と逆向きに入る (または目線と無関係な情報で入る) こと自体が設計なので、
 * 方向フィルターを掛けると戦略の意味がなくなる
 */
export const STRUCTURE_EXCLUDED: Readonly<Record<string, string>> = {
  scalp_obi: "板の偏り (order book imbalance) で数秒〜数分の方向を取る。足の構造とは別の情報で、目線と逆向きの短い動きも取りにいく",
  scalp_vwap_revert: "VWAP からの乖離の逆張り。目線と逆向きに入るのが設計",
  short_rsi_revert: "RSI の行き過ぎの逆張り。目線と逆向きに入るのが設計",
  scalp_rebound: "15m の下降トレンド中の 1m の反発を買う。上位足の目線 (下) と逆向きに入るのが設計",
};

/** STRUCTURE_* (検証済みの CoreEnv) から設定を作る */
export function structureSettingsFromEnv(
  env: Pick<
    CoreEnv,
    | "STRUCTURE_MODE" | "STRUCTURE_STRATEGIES" | "STRUCTURE_PIVOT_N" | "STRUCTURE_BREAK_MODE" | "STRUCTURE_BIAS_METHOD" | "STRUCTURE_REVERSAL_MODE"
    | "STRUCTURE_USE_MTF" | "STRUCTURE_USE_PERFECT_ORDER" | "STRUCTURE_STOP_MODE" | "STRUCTURE_STOP_ATR_BUFFER" | "STRUCTURE_EXIT_ON_REVERSAL"
    | "STRUCTURE_EXIT_ON_WEAKENING" | "STRUCTURE_CHOP_M" | "STRUCTURE_CHOP_R"
  >,
): StructureSettings {
  return {
    mode: env.STRUCTURE_MODE,
    strategies: [...env.STRUCTURE_STRATEGIES],
    config: resolveStructureFilterConfig({
      pivotN: env.STRUCTURE_PIVOT_N,
      breakMode: env.STRUCTURE_BREAK_MODE,
      biasMethod: env.STRUCTURE_BIAS_METHOD,
      reversalMode: env.STRUCTURE_REVERSAL_MODE,
      useMTF: env.STRUCTURE_USE_MTF,
      usePerfectOrder: env.STRUCTURE_USE_PERFECT_ORDER,
      perfectOrder: DEFAULT_PERFECT_ORDER,
      stopMode: env.STRUCTURE_STOP_MODE,
      stopAtrBuffer: env.STRUCTURE_STOP_ATR_BUFFER,
      exitOnReversal: env.STRUCTURE_EXIT_ON_REVERSAL,
      exitOnWeakening: env.STRUCTURE_EXIT_ON_WEAKENING,
      chopM: env.STRUCTURE_CHOP_M,
      chopR: env.STRUCTURE_CHOP_R,
    }),
  };
}

/** 既定の設定 (STRUCTURE_* が未設定のときと同じ) */
export function defaultStructureSettings(mode: StructureMode = "filter"): StructureSettings {
  return { mode, strategies: [...DEFAULT_STRUCTURE_TARGETS], config: { ...DEFAULT_STRUCTURE_FILTER_CONFIG } };
}

/**
 * 戦略の一覧にラッパーを掛ける。mode が off なら入力の一覧をそのまま返す (同じ配列・同じオブジェクト。従来と完全に同じ動き)。
 * 対象 (settings.strategies) に入っていない戦略はそのまま。
 * STRUCTURE_STRATEGIES で明示した戦略は、既定の対象外 (STRUCTURE_EXCLUDED) でもラップする (利用者の指定を優先)
 */
export function applyStructure<T extends readonly Strategy[]>(strategies: T, settings: StructureSettings | undefined): T | Strategy[] {
  if (!settings || settings.mode === "off") return strategies;
  const targets = new Set(settings.strategies);
  if (targets.size === 0) return strategies;
  return strategies.map((s) => (targets.has(s.id) ? withStructure(s, settings.config) : s));
}

/**
 * 設定の警告 (起動時にログへ出す。害はないが意図どおりに効かない組み合わせ)。
 * - STRUCTURE_STRATEGIES に、戦略の一覧 (knownIds) に無い id がある (廃止した戦略・綴り違いなど。その id は何もラップしない)
 * - STRUCTURE_EXIT_ON_WEAKENING=true なのに STRUCTURE_REVERSAL_MODE=purist (weakening は conservative にしか無いので効かない)
 */
export function structureConfigWarnings(settings: StructureSettings, knownIds: readonly string[]): string[] {
  const out: string[] = [];
  if (settings.mode === "off") return out;
  out.push(...strategyIdListWarnings("STRUCTURE_STRATEGIES", settings.strategies, knownIds));
  if (settings.config.exitOnWeakening && settings.config.reversalMode === "purist") {
    out.push("STRUCTURE_EXIT_ON_WEAKENING=true は STRUCTURE_REVERSAL_MODE=conservative のときだけ効きます (purist では何もしません)");
  }
  return out;
}
