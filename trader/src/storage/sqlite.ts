import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
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
 * node:sqlite (DatabaseSync) による Store 実装。
 *
 * 並び順の規約 (MemoryStore と共通):
 * - list 系はすべて時刻の昇順 (同時刻は保存順)。limit 指定時は「最新 N 件」を昇順で返す。
 *   - trades: exitTs / attributions: createdAt / intel: publishedAt / lessons・adjustments: createdAt
 *   - equity・audit: ts
 * - TradeFilter の since/until は exitTs (決済時刻) に対して適用 (両端含む)。
 * - getIntel は引数 ids の順。
 * - 同じ id の save は上書き (upsert)。saveIntel のみ既存 id を無視し、新規件数を返す。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  entryTs INTEGER NOT NULL,
  exitTs INTEGER NOT NULL,
  strategyId TEXT NOT NULL,
  symbol TEXT NOT NULL,
  assetClass TEXT NOT NULL,
  mode TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_exit ON trades(exitTs);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategyId, exitTs);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, exitTs);
CREATE INDEX IF NOT EXISTS idx_trades_class ON trades(assetClass, exitTs);
CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode, exitTs);

CREATE TABLE IF NOT EXISTS attributions (
  tradeId TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_created ON attributions(createdAt);

CREATE TABLE IF NOT EXISTS intel (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  publishedAt INTEGER NOT NULL,
  fetchedAt INTEGER NOT NULL,
  assets TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intel_published ON intel(publishedAt);
CREATE INDEX IF NOT EXISTS idx_intel_source ON intel(source, publishedAt);
CREATE INDEX IF NOT EXISTS idx_intel_kind ON intel(kind, publishedAt);

CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generatedAt INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_briefs_gen ON briefs(generatedAt);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generatedAt INTEGER NOT NULL,
  validUntil INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_gen ON plans(generatedAt);

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope, status, createdAt);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status, createdAt);

CREATE TABLE IF NOT EXISTS adjustments (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  strategyId TEXT NOT NULL,
  assetClass TEXT NOT NULL,
  param TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adj_strategy ON adjustments(strategyId, createdAt);
CREATE INDEX IF NOT EXISTS idx_adj_status ON adjustments(status, createdAt);

CREATE TABLE IF NOT EXISTS equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  equity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_mode ON equity(mode, ts);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit(type, ts);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
`;

type Row = Record<string, unknown>;

const parse = <T>(row: Row | undefined, col = "data"): T | undefined =>
  row === undefined ? undefined : (JSON.parse(String(row[col])) as T);

/** WHERE 句の組み立て */
class Where {
  readonly parts: string[] = [];
  readonly params: SQLInputValue[] = [];
  add(sql: string, ...params: SQLInputValue[]) {
    this.parts.push(sql);
    this.params.push(...params);
    return this;
  }
  toString() {
    return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : "";
  }
}

export class SqliteStore implements Store {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private closed = false;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:" && !path.startsWith("file:")) {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** トランザクション (入れ子はそのまま外側に参加) */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 最新 N 件を昇順で返す共通クエリ */
  private listLatest<T>(table: string, tsCol: string, where: Where, limit: number | undefined, dataCol = "data"): T[] {
    const w = where.toString();
    const sql =
      limit !== undefined
        ? `SELECT ${dataCol} AS d FROM (SELECT rowid AS r, ${tsCol} AS t, ${dataCol} FROM ${table} ${w} ORDER BY ${tsCol} DESC, rowid DESC LIMIT ?) ORDER BY t ASC, r ASC`
        : `SELECT ${dataCol} AS d FROM ${table} ${w} ORDER BY ${tsCol} ASC, rowid ASC`;
    const params = limit !== undefined ? [...where.params, Math.max(0, Math.floor(limit))] : where.params;
    return (this.stmt(sql).all(...params) as Row[]).map((r) => JSON.parse(String(r.d)) as T);
  }

  // ───────── trades ─────────

  saveTrade(t: TradeRecord): void {
    this.stmt(
      `INSERT INTO trades (id, entryTs, exitTs, strategyId, symbol, assetClass, mode, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET entryTs = excluded.entryTs, exitTs = excluded.exitTs,
         strategyId = excluded.strategyId, symbol = excluded.symbol, assetClass = excluded.assetClass,
         mode = excluded.mode, data = excluded.data`,
    ).run(t.id, t.entryTs, t.exitTs, t.strategyId, t.symbol, t.assetClass, t.mode, JSON.stringify(t));
  }

  updateTrade(id: string, patch: Partial<TradeRecord>): void {
    this.tx(() => {
      const cur = parse<TradeRecord>(this.stmt("SELECT data FROM trades WHERE id = ?").get(id) as Row | undefined);
      if (!cur) return;
      this.saveTrade({ ...cur, ...patch, id: cur.id });
    });
  }

  listTrades(f: TradeFilter = {}): TradeRecord[] {
    const w = new Where();
    if (f.since !== undefined) w.add("exitTs >= ?", f.since);
    if (f.until !== undefined) w.add("exitTs <= ?", f.until);
    if (f.strategyId !== undefined) w.add("strategyId = ?", f.strategyId);
    if (f.symbol !== undefined) w.add("symbol = ?", f.symbol);
    if (f.assetClass !== undefined) w.add("assetClass = ?", f.assetClass);
    if (f.mode !== undefined) w.add("mode = ?", f.mode);
    return this.listLatest<TradeRecord>("trades", "exitTs", w, f.limit);
  }

  // ───────── attributions ─────────

  saveAttribution(a: TradeAttribution): void {
    this.stmt(
      `INSERT INTO attributions (tradeId, createdAt, data) VALUES (?, ?, ?)
       ON CONFLICT(tradeId) DO UPDATE SET createdAt = excluded.createdAt, data = excluded.data`,
    ).run(a.tradeId, a.createdAt, JSON.stringify(a));
  }

  getAttribution(tradeId: string): TradeAttribution | undefined {
    return parse<TradeAttribution>(this.stmt("SELECT data FROM attributions WHERE tradeId = ?").get(tradeId) as Row | undefined);
  }

  listAttributions(since?: number): TradeAttribution[] {
    const w = new Where();
    if (since !== undefined) w.add("createdAt >= ?", since);
    return this.listLatest<TradeAttribution>("attributions", "createdAt", w, undefined);
  }

  // ───────── intel ─────────

  saveIntel(items: IntelItem[]): number {
    if (items.length === 0) return 0;
    const ins = this.stmt(
      `INSERT OR IGNORE INTO intel (id, source, kind, publishedAt, fetchedAt, assets, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.tx(() => {
      let added = 0;
      for (const it of items) {
        const r = ins.run(it.id, it.source, it.kind, it.publishedAt, it.fetchedAt, JSON.stringify(it.assets ?? []), JSON.stringify(it));
        added += Number(r.changes);
      }
      return added;
    });
  }

  listIntel(opts: { since?: number; assets?: string[]; kinds?: IntelKind[]; limit?: number } = {}): IntelItem[] {
    const w = new Where();
    if (opts.since !== undefined) w.add("publishedAt >= ?", opts.since);
    if (opts.assets !== undefined) {
      // assets (JSON 配列) のいずれかが指定集合に含まれる
      w.add(
        "EXISTS (SELECT 1 FROM json_each(intel.assets) a WHERE a.value IN (SELECT value FROM json_each(?)))",
        JSON.stringify(opts.assets),
      );
    }
    if (opts.kinds !== undefined) w.add("kind IN (SELECT value FROM json_each(?))", JSON.stringify(opts.kinds));
    return this.listLatest<IntelItem>("intel", "publishedAt", w, opts.limit);
  }

  getIntel(ids: string[]): IntelItem[] {
    if (ids.length === 0) return [];
    const rows = this.stmt("SELECT id, data FROM intel WHERE id IN (SELECT value FROM json_each(?))").all(
      JSON.stringify(ids),
    ) as Row[];
    const byId = new Map(rows.map((r) => [String(r.id), JSON.parse(String(r.data)) as IntelItem]));
    const out: IntelItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const it = byId.get(id);
      if (it && !seen.has(id)) {
        out.push(it);
        seen.add(id);
      }
    }
    return out;
  }

  // ───────── brief / plan ─────────

  saveBrief(b: MarketBrief): void {
    this.stmt("INSERT INTO briefs (generatedAt, data) VALUES (?, ?)").run(b.generatedAt, JSON.stringify(b));
  }

  latestBrief(): MarketBrief | undefined {
    return parse<MarketBrief>(
      this.stmt("SELECT data FROM briefs ORDER BY generatedAt DESC, id DESC LIMIT 1").get() as Row | undefined,
    );
  }

  savePlan(p: StrategyPlan): void {
    this.stmt("INSERT INTO plans (generatedAt, validUntil, data) VALUES (?, ?, ?)").run(
      p.generatedAt,
      p.validUntil,
      JSON.stringify(p),
    );
  }

  latestPlan(): StrategyPlan | undefined {
    return parse<StrategyPlan>(
      this.stmt("SELECT data FROM plans ORDER BY generatedAt DESC, id DESC LIMIT 1").get() as Row | undefined,
    );
  }

  // ───────── lessons ─────────

  saveLesson(l: Lesson): void {
    this.stmt(
      `INSERT INTO lessons (id, createdAt, scope, status, origin, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET createdAt = excluded.createdAt, scope = excluded.scope,
         status = excluded.status, origin = excluded.origin, data = excluded.data`,
    ).run(l.id, l.createdAt, l.scope, l.status, l.origin, JSON.stringify(l));
  }

  listLessons(opts: { status?: Lesson["status"]; scope?: string; limit?: number } = {}): Lesson[] {
    const w = new Where();
    if (opts.status !== undefined) w.add("status = ?", opts.status);
    if (opts.scope !== undefined) w.add("scope = ?", opts.scope);
    return this.listLatest<Lesson>("lessons", "createdAt", w, opts.limit);
  }

  // ───────── adjustments ─────────

  saveAdjustment(a: ParamAdjustment): void {
    this.stmt(
      `INSERT INTO adjustments (id, createdAt, strategyId, assetClass, param, status, data) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET createdAt = excluded.createdAt, strategyId = excluded.strategyId,
         assetClass = excluded.assetClass, param = excluded.param, status = excluded.status, data = excluded.data`,
    ).run(a.id, a.createdAt, a.strategyId, a.assetClass, a.param, a.status, JSON.stringify(a));
  }

  listAdjustments(opts: { strategyId?: string; status?: ParamAdjustment["status"] } = {}): ParamAdjustment[] {
    const w = new Where();
    if (opts.strategyId !== undefined) w.add("strategyId = ?", opts.strategyId);
    if (opts.status !== undefined) w.add("status = ?", opts.status);
    return this.listLatest<ParamAdjustment>("adjustments", "createdAt", w, undefined);
  }

  // ───────── equity ─────────

  saveEquity(p: EquityPoint): void {
    this.stmt("INSERT INTO equity (ts, mode, equity) VALUES (?, ?, ?)").run(p.ts, p.mode, p.equity);
  }

  listEquity(opts: { since?: number; mode?: TradingMode } = {}): EquityPoint[] {
    const w = new Where();
    if (opts.since !== undefined) w.add("ts >= ?", opts.since);
    if (opts.mode !== undefined) w.add("mode = ?", opts.mode);
    const rows = this.stmt(`SELECT ts, mode, equity FROM equity ${w} ORDER BY ts ASC, id ASC`).all(...w.params) as Row[];
    return rows.map((r) => ({ ts: Number(r.ts), mode: String(r.mode) as TradingMode, equity: Number(r.equity) }));
  }

  // ───────── audit ─────────

  audit(e: AuditEvent): void {
    this.stmt("INSERT INTO audit (ts, type, data) VALUES (?, ?, ?)").run(e.ts, e.type, JSON.stringify(e));
  }

  listAudit(opts: { since?: number; type?: string; limit?: number } = {}): AuditEvent[] {
    const w = new Where();
    if (opts.since !== undefined) w.add("ts >= ?", opts.since);
    if (opts.type !== undefined) w.add("type = ?", opts.type);
    return this.listLatest<AuditEvent>("audit", "ts", w, opts.limit);
  }

  // ───────── kv ─────────

  kvGet<T>(key: string): T | undefined {
    return parse<T>(this.stmt("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined, "value");
  }

  kvSet<T>(key: string, value: T): void {
    if (value === undefined) {
      this.stmt("DELETE FROM kv WHERE key = ?").run(key);
      return;
    }
    this.stmt(
      `INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    ).run(key, JSON.stringify(value), Date.now());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }
}
