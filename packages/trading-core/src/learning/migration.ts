/**
 * 学習状態を paper / live で分けたときの移行 (起動時に LearningService が呼ぶ)。
 *
 * 旧キー (mode なし) → 新キー (mode 別):
 * - arm:index / arm:<key>              → arm:<mode>:index / arm:<mode>:<key>
 * - params:<strategyId>:<assetClass>   → params:<mode>:<strategyId>:<assetClass>
 * - adjmeta:<id>                       → adjmeta:<mode>:<id>
 * - intelInfluence:<assetClass>        → intelInfluence:<mode>:<assetClass>
 * - intel:sourceReliability            → intel:sourceReliability:<mode>
 * - newsCheck:pending|stats|seen       → newsCheck:<mode>:pending|stats|seen
 * - learning:lastTune|lastReflect|lastPostExitFill → learning:<mode>:...
 *
 * 規則:
 * - paper: 新キーが無ければ旧キーの値をコピーする (新キーがあれば上書きしない)。旧キーは消さない。
 * - live: 旧キーは使わない (腕・信頼度は事前分布、パラメータはコードの既定値から始める)。
 * - 1 回だけ行う: 終わったら kv `migration:learningModeSplit:<mode>` を書き、以後は何もしない。
 * - トランザクション内で行う (途中で落ちても何も書かない)。メモリ実装は巻き戻さないが、
 *   コピーは「新キーが無いときだけ」・フラグは最後に書くので、再実行で続きから正しく終わる。
 * - 旧キーがあったときだけ監査ログ `learning.migrated` を 1 回残す。
 * - 調整履歴 (adjustments 表) の mode 列は SqliteStore のスキーマ移行で追加し、既存行は paper とみなす。
 */
import type { Store, TradingMode } from "../core/types";

const MODES: readonly TradingMode[] = ["paper", "live"];

/** 移行済みフラグの kv キー */
export const learningMigrationFlagKey = (mode: TradingMode) => `migration:learningModeSplit:${mode}`;

/** 学習ループの実行時刻の kv キー (mode 別) */
export const lastTuneKey = (mode: TradingMode) => `learning:${mode}:lastTune`;
export const lastReflectKey = (mode: TradingMode) => `learning:${mode}:lastReflect`;
export const lastPostExitFillKey = (mode: TradingMode) => `learning:${mode}:lastPostExitFill`;

/** 名前空間の後ろに任意の続きがある旧キー (`<ns><rest>` → `<ns><mode>:<rest>`) */
const PREFIX_FAMILIES = ["arm:", "params:", "adjmeta:", "intelInfluence:"] as const;

/** 完全一致の旧キー → 新キー */
const EXACT: Record<string, (mode: TradingMode) => string> = {
  "intel:sourceReliability": (m) => `intel:sourceReliability:${m}`,
  "newsCheck:pending": (m) => `newsCheck:${m}:pending`,
  "newsCheck:stats": (m) => `newsCheck:${m}:stats`,
  "newsCheck:seen": (m) => `newsCheck:${m}:seen`,
  "learning:lastTune": lastTuneKey,
  "learning:lastReflect": lastReflectKey,
  "learning:lastPostExitFill": lastPostExitFillKey,
};

const isModeScoped = (rest: string) => MODES.some((m) => rest.startsWith(`${m}:`));

/** 旧キー → mode 別の新キー。旧キーでなければ undefined */
export function modeScopedLearningKey(legacyKey: string, mode: TradingMode): string | undefined {
  const exact = EXACT[legacyKey];
  if (exact) return exact(mode);
  for (const ns of PREFIX_FAMILIES) {
    if (!legacyKey.startsWith(ns)) continue;
    const rest = legacyKey.slice(ns.length);
    if (rest === "" || isModeScoped(rest)) return undefined;
    return `${ns}${mode}:${rest}`;
  }
  return undefined;
}

/** store にある旧キー (mode なしの学習状態) の一覧 */
export function listLegacyLearningKeys(store: Store): string[] {
  const out: string[] = [];
  for (const ns of PREFIX_FAMILIES) {
    for (const k of store.kvKeys?.(ns) ?? []) if (modeScopedLearningKey(k, "paper") !== undefined) out.push(k);
  }
  for (const k of Object.keys(EXACT)) if (store.kvGet<unknown>(k) !== undefined) out.push(k);
  return out;
}

export interface LearningMigrationResult {
  /** 今回移行を行ったか (移行済みなら false) */
  ran: boolean;
  mode: TradingMode;
  /** 見つかった旧キーの数 */
  legacyKeys: number;
  /** コピーした旧キー (paper のみ) */
  copied: string[];
  /** 新キーが既にあったためコピーしなかった新キー */
  keptExisting: string[];
}

/** 学習状態の mode 分割の移行 (冪等)。詳細はファイル冒頭 */
export function migrateLearningModeSplit(store: Store, mode: TradingMode, now: number = Date.now()): LearningMigrationResult {
  const flag = learningMigrationFlagKey(mode);
  const run = (): LearningMigrationResult => {
    if (store.kvGet<unknown>(flag) !== undefined) return { ran: false, mode, legacyKeys: 0, copied: [], keptExisting: [] };
    const legacy = listLegacyLearningKeys(store);
    const copied: string[] = [];
    const keptExisting: string[] = [];
    if (mode === "paper") {
      for (const k of legacy) {
        const nk = modeScopedLearningKey(k, mode)!;
        if (store.kvGet<unknown>(nk) !== undefined) {
          keptExisting.push(nk);
          continue;
        }
        const v = store.kvGet<unknown>(k);
        if (v === undefined) continue;
        store.kvSet(nk, v);
        copied.push(k);
      }
    }
    if (legacy.length > 0) {
      store.audit({
        ts: now,
        type: "learning.migrated",
        data: {
          migration: "learningModeSplit",
          mode,
          legacyKeys: legacy.length,
          copied: copied.length,
          keptExisting: keptExisting.length,
          note: mode === "paper" ? "旧キーの学習状態を paper 用キーへコピー (旧キーは残す)" : "live は旧キー (paper の学習) を使わず初期状態から始める",
        },
      });
    }
    // フラグは最後に書く (途中で落ちたら次回に続きから)
    store.kvSet(flag, { at: now, legacyKeys: legacy.length, copied: copied.length });
    return { ran: true, mode, legacyKeys: legacy.length, copied, keptExisting };
  };
  return store.transaction ? store.transaction(run) : run();
}
