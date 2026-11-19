import type {
  AuditEvent,
  EquityPoint,
  IntelItem,
  IntelKind,
  Lesson,
  MarketBrief,
  ParamAdjustment,
  Store,
  StrategyPlan,
  TradeAttribution,
  TradeFilter,
  TradeRecord,
  TradingMode,
} from "../core/types";

/**
 * メモリ上の Store 実装 (テスト・バックテスト用)。
 * 並び順・フィルタの規約は SqliteStore と同じ (sqlite.ts 冒頭のコメント参照)。
 * 保存・取得時に JSON で複製し、SQLite と同じ値の意味論 (参照共有なし・undefined 除去) にそろえる。
 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 時刻の昇順 (安定ソートなので同時刻は保存順)。limit 指定時は最新 N 件 */
function latest<T>(items: T[], ts: (x: T) => number, limit?: number): T[] {
  const sorted = [...items].sort((a, b) => ts(a) - ts(b));
  const out = limit !== undefined ? sorted.slice(Math.max(0, sorted.length - Math.max(0, Math.floor(limit)))) : sorted;
  return out.map(clone);
}

export class MemoryStore implements Store {
  private trades = new Map<string, TradeRecord>();
  private attributions = new Map<string, TradeAttribution>();
  private intel = new Map<string, IntelItem>();
  private briefs: MarketBrief[] = [];
  private plans: StrategyPlan[] = [];
  private lessons = new Map<string, Lesson>();
  private adjustments = new Map<string, ParamAdjustment>();
  private equity: EquityPoint[] = [];
  private audits: AuditEvent[] = [];
  private kv = new Map<string, string>();

  saveTrade(t: TradeRecord): void {
    this.trades.set(t.id, clone(t));
  }

  updateTrade(id: string, patch: Partial<TradeRecord>): void {
    const cur = this.trades.get(id);
    if (!cur) return;
    this.trades.set(id, clone({ ...cur, ...patch, id }));
  }

  listTrades(f: TradeFilter = {}): TradeRecord[] {
    const items = [...this.trades.values()].filter(
      (t) =>
        (f.since === undefined || t.exitTs >= f.since) &&
        (f.until === undefined || t.exitTs <= f.until) &&
        (f.strategyId === undefined || t.strategyId === f.strategyId) &&
        (f.symbol === undefined || t.symbol === f.symbol) &&
        (f.assetClass === undefined || t.assetClass === f.assetClass) &&
        (f.mode === undefined || t.mode === f.mode),
    );
    return latest(items, (t) => t.exitTs, f.limit);
  }

  saveAttribution(a: TradeAttribution): void {
    this.attributions.set(a.tradeId, clone(a));
  }

  getAttribution(tradeId: string): TradeAttribution | undefined {
    const a = this.attributions.get(tradeId);
    return a ? clone(a) : undefined;
  }

  listAttributions(since?: number): TradeAttribution[] {
    const items = [...this.attributions.values()].filter((a) => since === undefined || a.createdAt >= since);
    return latest(items, (a) => a.createdAt);
  }

  saveIntel(items: IntelItem[]): number {
    let added = 0;
    for (const it of items) {
      if (this.intel.has(it.id)) continue;
      this.intel.set(it.id, clone(it));
      added++;
    }
    return added;
  }

  listIntel(opts: { since?: number; assets?: string[]; kinds?: IntelKind[]; limit?: number } = {}): IntelItem[] {
    const assets = opts.assets ? new Set(opts.assets) : undefined;
    const kinds = opts.kinds ? new Set<IntelKind>(opts.kinds) : undefined;
    const items = [...this.intel.values()].filter(
      (it) =>
        (opts.since === undefined || it.publishedAt >= opts.since) &&
        (assets === undefined || (it.assets ?? []).some((a) => assets.has(a))) &&
        (kinds === undefined || kinds.has(it.kind)),
    );
    return latest(items, (it) => it.publishedAt, opts.limit);
  }

  getIntel(ids: string[]): IntelItem[] {
    const out: IntelItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const it = this.intel.get(id);
      if (it && !seen.has(id)) {
        out.push(clone(it));
        seen.add(id);
      }
    }
    return out;
  }

  saveBrief(b: MarketBrief): void {
    this.briefs.push(clone(b));
  }

  latestBrief(): MarketBrief | undefined {
    const all = latest(this.briefs, (b) => b.generatedAt, 1);
    return all[0];
  }

  savePlan(p: StrategyPlan): void {
    this.plans.push(clone(p));
  }

  latestPlan(): StrategyPlan | undefined {
    const all = latest(this.plans, (p) => p.generatedAt, 1);
    return all[0];
  }

  saveLesson(l: Lesson): void {
    this.lessons.set(l.id, clone(l));
  }

  listLessons(opts: { status?: Lesson["status"]; scope?: string; limit?: number } = {}): Lesson[] {
    const items = [...this.lessons.values()].filter(
      (l) => (opts.status === undefined || l.status === opts.status) && (opts.scope === undefined || l.scope === opts.scope),
    );
    return latest(items, (l) => l.createdAt, opts.limit);
  }

  saveAdjustment(a: ParamAdjustment): void {
    this.adjustments.set(a.id, clone(a));
  }

  listAdjustments(opts: { strategyId?: string; status?: ParamAdjustment["status"] } = {}): ParamAdjustment[] {
    const items = [...this.adjustments.values()].filter(
      (a) =>
        (opts.strategyId === undefined || a.strategyId === opts.strategyId) &&
        (opts.status === undefined || a.status === opts.status),
    );
    return latest(items, (a) => a.createdAt);
  }

  saveEquity(p: EquityPoint): void {
    this.equity.push({ ts: p.ts, mode: p.mode, equity: p.equity });
  }

  listEquity(opts: { since?: number; mode?: TradingMode } = {}): EquityPoint[] {
    const items = this.equity.filter(
      (p) => (opts.since === undefined || p.ts >= opts.since) && (opts.mode === undefined || p.mode === opts.mode),
    );
    return latest(items, (p) => p.ts);
  }

  audit(e: AuditEvent): void {
    this.audits.push(clone(e));
  }

  listAudit(opts: { since?: number; type?: string; limit?: number } = {}): AuditEvent[] {
    const items = this.audits.filter(
      (e) => (opts.since === undefined || e.ts >= opts.since) && (opts.type === undefined || e.type === opts.type),
    );
    return latest(items, (e) => e.ts, opts.limit);
  }

  kvGet<T>(key: string): T | undefined {
    const v = this.kv.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  kvSet<T>(key: string, value: T): void {
    if (value === undefined) {
      this.kv.delete(key);
      return;
    }
    this.kv.set(key, JSON.stringify(value));
  }

  /** メモリ実装は途中で失敗しても巻き戻さない (そのまま実行する) */
  transaction<T>(fn: () => T): T {
    return fn();
  }

  close(): void {
    // メモリ実装では何もしない
  }
}
