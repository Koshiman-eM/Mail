/**
 * 廃止した戦略 (long_momentum・meme_momentum)。
 * mid_trend_follow は 2026-11 に同じ id のまま戻した (src/strategies/mid.ts。登録している戦略なのでここには載せない)。
 *
 * 戦略そのもの (評価のコード) は削除した。ここに残すのは、DB に残っているもの (学習データ・仮想トレード・
 * 再起動前に建てた建玉) と古い .env を壊さずに扱うための最小限の情報だけ。
 * - 保有中の建玉: 損切り・利確・トレーリング・読みの管理は戦略なしで続く。転換で決済は持ち主の戦略の主時間足が要るので、
 *   ここの primaryTimeframe を使う (src/engine/engine.ts)。持ち主の戦略の決済シグナルだけは出なくなる。
 * - 学習データ (腕・仮想トレード・パラメータ調整など) は消さない・書き換えない。
 * - 環境変数 (OBSERVE_ONLY_STRATEGIES / STRUCTURE_STRATEGIES / REVERSAL_EXIT_STRATEGIES) に書かれていても起動を止めず、警告する。
 * このモジュールは他の戦略・設定を import しない (structure/settings・engine/reversalExit から循環なしで使うため)
 */
import type { Horizon, Timeframe } from "../core/types";

export interface RetiredStrategyInfo {
  primaryTimeframe: Timeframe;
  horizon: Horizon;
}

export const RETIRED_STRATEGIES: Readonly<Record<string, RetiredStrategyInfo>> = {
  long_momentum: { primaryTimeframe: "1d", horizon: "long" },
  meme_momentum: { primaryTimeframe: "1m", horizon: "scalp" },
};

function isRetiredStrategy(id: string): boolean {
  return Object.hasOwn(RETIRED_STRATEGIES, id);
}

/**
 * 戦略 id の一覧を指定する環境変数の警告 (起動時にログへ出す)。廃止した id と、未登録の id (綴り違いなど) を分けて知らせる。
 * どちらも起動は止めない。retiredNote は廃止した id の扱い (例: 無視されます)
 */
export function strategyIdListWarnings(
  envName: string, ids: readonly string[], knownIds: readonly string[], retiredNote = "無視されます",
): string[] {
  const known = new Set(knownIds);
  const retired = ids.filter((id) => !known.has(id) && isRetiredStrategy(id));
  const unknown = ids.filter((id) => !known.has(id) && !isRetiredStrategy(id));
  const out: string[] = [];
  if (retired.length > 0) out.push(`${envName} に廃止した戦略 id があります (${retiredNote}): ${retired.join(", ")}`);
  if (unknown.length > 0) out.push(`${envName} に未登録の戦略 id があります (無視されます): ${unknown.join(", ")}`);
  return out;
}
