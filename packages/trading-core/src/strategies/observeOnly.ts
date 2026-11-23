/**
 * 観測専用 (OBSERVE_ONLY_STRATEGIES) の指定の解釈。
 *
 * 各要素は次のどちらか:
 * - `<戦略 id>`: その戦略のすべての資産クラスを観測専用にする (従来どおり)
 * - `<戦略 id>:<資産クラス>`: その資産クラスの銘柄だけを観測専用にする (例 `short_ema_trend:meme`)
 * 資産クラスが語彙に無い・アプリで有効でない要素は警告して無視する (起動は止めない)。
 * 戦略 id の検証 (廃止・未登録) は strategyIdListWarnings に任せる (どちらも集合の判定なので、残っていても何も起きない)
 */
import { enabledAssetClasses, isAssetClass } from "../core/assetClasses";
import { strategyIdListWarnings } from "./retired";

export interface ObserveOnlyRules {
  /** すべての資産クラスで観測専用の戦略 id */
  readonly all: ReadonlySet<string>;
  /** 資産クラスごとに観測専用の戦略 id (`<id>:<class>`) */
  readonly byClass: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ParsedEntry {
  raw: string;
  id: string;
  /** 指定なし = すべての資産クラス */
  assetClass?: string;
}

function splitEntry(raw: string): ParsedEntry {
  const i = raw.indexOf(":");
  if (i < 0) return { raw, id: raw.trim() };
  return { raw, id: raw.slice(0, i).trim(), assetClass: raw.slice(i + 1).trim().toLowerCase() };
}

/** 資産クラスの指定が使えるか (語彙にあり、アプリで有効) */
function validClass(c: string, enabled: readonly string[]): boolean {
  return isAssetClass(c) && enabled.includes(c);
}

/** 指定を解釈する。資産クラスが不正な要素・id が空の要素は無視する (警告は observeOnlyWarnings) */
export function parseObserveOnly(entries: readonly string[] | undefined, enabled: readonly string[] = enabledAssetClasses()): ObserveOnlyRules {
  const all = new Set<string>();
  const byClass = new Map<string, Set<string>>();
  for (const e of (entries ?? []).map(splitEntry)) {
    if (e.id === "") continue;
    if (e.assetClass === undefined) {
      all.add(e.id);
      continue;
    }
    if (!validClass(e.assetClass, enabled)) continue;
    let s = byClass.get(e.assetClass);
    if (!s) byClass.set(e.assetClass, (s = new Set()));
    s.add(e.id);
  }
  return { all, byClass };
}

/** その戦略のその資産クラスの銘柄の新規エントリーが観測専用か */
export function isObserveOnly(rules: ObserveOnlyRules, strategyId: string, assetClass: string): boolean {
  return rules.all.has(strategyId) || (rules.byClass.get(assetClass)?.has(strategyId) ?? false);
}

/**
 * 起動時・status の警告。戦略 id (廃止・未登録) は strategyIdListWarnings と同じ文言、
 * 資産クラスの指定が不正 (語彙に無い・有効でない・空) な要素は別の警告にする
 */
export function observeOnlyWarnings(
  envName: string, entries: readonly string[] | undefined, knownIds: readonly string[], enabled: readonly string[] = enabledAssetClasses(),
): string[] {
  const parsed = (entries ?? []).map(splitEntry);
  const badClass = parsed.filter((e) => e.assetClass !== undefined && !validClass(e.assetClass, enabled)).map((e) => e.raw);
  const emptyId = parsed.filter((e) => e.id === "").map((e) => e.raw);
  const ids = [...new Set(parsed.filter((e) => e.id !== "").map((e) => e.id))];
  const out = strategyIdListWarnings(envName, ids, knownIds);
  if (badClass.length > 0) {
    out.push(`${envName} に使えない資産クラスの指定があります (無視されます。使えるのは ${enabled.join(" / ")}): ${badClass.join(", ")}`);
  }
  if (emptyId.length > 0) out.push(`${envName} に戦略 id の無い指定があります (無視されます): ${emptyId.join(", ")}`);
  return out;
}

/** status 用の表示 (例 `scalp_rebound (全クラス)`, `short_ema_trend (meme のみ)`)。戦略 id ごとの観測専用の範囲 */
export function observeOnlyScope(rules: ObserveOnlyRules, strategyId: string): string | undefined {
  if (rules.all.has(strategyId)) return "全クラス";
  const classes = [...rules.byClass.entries()].filter(([, ids]) => ids.has(strategyId)).map(([c]) => c);
  return classes.length > 0 ? `${classes.join("・")} のみ` : undefined;
}

/** status 用の 1 行 (解釈した設定) */
export function formatObserveOnly(rules: ObserveOnlyRules): string {
  const parts = [...rules.all].map((id) => `${id} (全クラス)`);
  for (const [c, ids] of rules.byClass) for (const id of ids) if (!rules.all.has(id)) parts.push(`${id} (${c} のみ)`);
  return `観測専用 (OBSERVE_ONLY_STRATEGIES): ${parts.length > 0 ? parts.join(", ") : "なし"}`;
}
