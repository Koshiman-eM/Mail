/**
 * ログイン試行のレート制限 (プロセス内メモリ)。
 * 15分間に同一キー (メールアドレス / IP) で 10 回失敗するとロックする。
 * 複数インスタンス構成にする場合は Redis 等に置き換えること。
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const g = globalThis as unknown as { __loginFailures?: Map<string, number[]> };
const failures = (g.__loginFailures ??= new Map());

const recent = (key: string, now: number) => (failures.get(key) ?? []).filter((t: number) => now - t < WINDOW_MS);

export function isLocked(keys: string[], now = Date.now()): boolean {
  return keys.some((k) => recent(k, now).length >= MAX_FAILURES);
}
export function recordFailure(keys: string[], now = Date.now()) {
  for (const k of keys) failures.set(k, [...recent(k, now), now]);
}
export function clearFailures(keys: string[]) {
  for (const k of keys) failures.delete(k);
}
