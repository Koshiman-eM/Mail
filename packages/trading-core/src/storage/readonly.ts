import type { OperationalCutoffs, Store } from "../core/types";

const DELETED = Symbol("deleted");

/**
 * 読み取り系コマンド (report など) 用: DB へ書き込まない Store。
 * - kvSet はメモリ上の上書き (overlay) にだけ書き、以後の kvGet / kvKeys はそれを反映する
 *   (起動時の移行などを DB に書かずに、移行後の状態として読める)。
 * - その他の書き込み (save* / update* / prune* / audit) は捨てる。
 * - 読み取りは元の Store に委ねる。close は元の Store を閉じない (呼び出し側が閉じる)。
 */
export class ReadOnlyOverlayStore implements Store {
  private readonly overlay = new Map<string, unknown>();

  constructor(private readonly base: Store) {}

  saveTrade(): void {}
  updateTrade(): void {}
  listTrades(...a: Parameters<Store["listTrades"]>) {
    return this.base.listTrades(...a);
  }
  saveAttribution(): void {}
  getAttribution(...a: Parameters<Store["getAttribution"]>) {
    return this.base.getAttribution(...a);
  }
  listAttributions(...a: Parameters<Store["listAttributions"]>) {
    return this.base.listAttributions(...a);
  }
  saveIntel(): number {
    return 0;
  }
  listIntel(...a: Parameters<Store["listIntel"]>) {
    return this.base.listIntel(...a);
  }
  getIntel(...a: Parameters<Store["getIntel"]>) {
    return this.base.getIntel(...a);
  }
  saveBrief(): void {}
  latestBrief() {
    return this.base.latestBrief();
  }
  listBriefs(...a: Parameters<NonNullable<Store["listBriefs"]>>) {
    return this.base.listBriefs?.(...a) ?? [];
  }
  savePlan(): void {}
  latestPlan() {
    return this.base.latestPlan();
  }
  saveLesson(): void {}
  listLessons(...a: Parameters<Store["listLessons"]>) {
    return this.base.listLessons(...a);
  }
  saveAdjustment(): void {}
  listAdjustments(...a: Parameters<Store["listAdjustments"]>) {
    return this.base.listAdjustments(...a);
  }
  saveEquity(): void {}
  listEquity(...a: Parameters<Store["listEquity"]>) {
    return this.base.listEquity(...a);
  }
  saveShadowTrade(): void {}
  listShadowTrades(...a: Parameters<Store["listShadowTrades"]>) {
    return this.base.listShadowTrades(...a);
  }
  pruneShadowTrades(): number {
    return 0;
  }
  saveForecastOutcomes(): void {}
  listForecastOutcomes(...a: Parameters<Store["listForecastOutcomes"]>) {
    return this.base.listForecastOutcomes(...a);
  }
  pruneForecastOutcomes(): number {
    return 0;
  }
  pruneOperational(): Record<keyof OperationalCutoffs, number> {
    return { audit: 0, intel: 0, briefs: 0, plans: 0, equity: 0 } as Record<keyof OperationalCutoffs, number>;
  }
  audit(): void {}
  listAudit(...a: Parameters<Store["listAudit"]>) {
    return this.base.listAudit(...a);
  }

  kvGet<T>(key: string): T | undefined {
    if (this.overlay.has(key)) {
      const v = this.overlay.get(key);
      return v === DELETED ? undefined : (structuredClone(v) as T);
    }
    return this.base.kvGet<T>(key);
  }
  kvSet<T>(key: string, value: T): void {
    this.overlay.set(key, value === undefined ? DELETED : structuredClone(value));
  }
  kvKeys(prefix: string): string[] {
    const keys = new Set(this.base.kvKeys(prefix));
    for (const [k, v] of this.overlay) {
      if (!k.startsWith(prefix)) continue;
      if (v === DELETED) keys.delete(k);
      else keys.add(k);
    }
    return [...keys].sort();
  }
  transaction<T>(fn: () => T): T {
    return fn();
  }
  close(): void {
    // 元の Store は呼び出し側が閉じる
  }
}
