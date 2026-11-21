// node:sqlite による保存層 (ネイティブ依存なし)
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Campaign,
  CampaignInput,
  CampaignKind,
  CampaignStatus,
  Conditions,
  Entry,
  EntryStatus,
} from "./types.js";

/** 重複排除用に URL を正規化する (フラグメント・utm_* ・末尾スラッシュを除去) */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return raw.trim();
  }
}

type Row = Record<string, unknown>;

function rowToCampaign(r: Row): Campaign {
  return {
    id: Number(r.id),
    kind: r.kind as CampaignKind,
    source: String(r.source),
    title: String(r.title),
    url: String(r.url),
    prize: String(r.prize ?? ""),
    prizeValueJpy: r.prize_value_jpy == null ? null : Number(r.prize_value_jpy),
    winners: r.winners == null ? null : Number(r.winners),
    participants: r.participants == null ? null : Number(r.participants),
    deadline: r.deadline == null ? null : String(r.deadline),
    conditions: JSON.parse(String(r.conditions ?? "{}")) as Conditions,
    estMinutes: r.est_minutes == null ? null : Number(r.est_minutes),
    riskFlags: JSON.parse(String(r.risk_flags ?? "[]")) as string[],
    score: Number(r.score ?? 0),
    status: r.status as CampaignStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToEntry(r: Row): Entry {
  return {
    id: Number(r.id),
    campaignId: Number(r.campaign_id),
    status: r.status as EntryStatus,
    reason: String(r.reason ?? ""),
    createdAt: String(r.created_at),
  };
}

export interface UpsertResult {
  campaign: Campaign;
  created: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        prize TEXT NOT NULL DEFAULT '',
        prize_value_jpy INTEGER,
        winners INTEGER,
        participants INTEGER,
        deadline TEXT,
        conditions TEXT NOT NULL DEFAULT '{}',
        est_minutes REAL,
        risk_flags TEXT NOT NULL DEFAULT '[]',
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_campaign ON entries(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
    `);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** URL で重複排除しつつ登録・更新する。既存の status が entered の場合は保持する */
  upsertCampaign(
    input: CampaignInput & { riskFlags: string[]; score: number; status: CampaignStatus },
    now: Date = new Date(),
  ): UpsertResult {
    const url = normalizeUrl(input.url);
    const existing = this.getCampaignByUrl(url);
    const ts = now.toISOString();
    const params = {
      kind: input.kind,
      source: input.source,
      title: input.title,
      url,
      prize: input.prize ?? "",
      prize_value_jpy: input.prizeValueJpy ?? null,
      winners: input.winners ?? null,
      participants: input.participants ?? null,
      deadline: input.deadline ?? null,
      conditions: JSON.stringify(input.conditions ?? {}),
      est_minutes: input.estMinutes ?? null,
      risk_flags: JSON.stringify(input.riskFlags),
      score: input.score,
      status: existing?.status === "entered" ? "entered" : input.status,
      ts,
    };
    if (existing) {
      this.db
        .prepare(
          `UPDATE campaigns SET kind=:kind, source=:source, title=:title, prize=:prize,
             prize_value_jpy=:prize_value_jpy, winners=:winners, participants=:participants,
             deadline=:deadline, conditions=:conditions, est_minutes=:est_minutes,
             risk_flags=:risk_flags, score=:score, status=:status, updated_at=:ts
           WHERE url=:url`,
        )
        .run(params);
      return { campaign: this.getCampaignByUrl(url)!, created: false };
    }
    this.db
      .prepare(
        `INSERT INTO campaigns (kind, source, title, url, prize, prize_value_jpy, winners, participants,
           deadline, conditions, est_minutes, risk_flags, score, status, created_at, updated_at)
         VALUES (:kind, :source, :title, :url, :prize, :prize_value_jpy, :winners, :participants,
           :deadline, :conditions, :est_minutes, :risk_flags, :score, :status, :ts, :ts)`,
      )
      .run(params);
    return { campaign: this.getCampaignByUrl(url)!, created: true };
  }

  getCampaign(id: number): Campaign | undefined {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToCampaign(r) : undefined;
  }

  getCampaignByUrl(url: string): Campaign | undefined {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE url = ?").get(normalizeUrl(url)) as Row | undefined;
    return r ? rowToCampaign(r) : undefined;
  }

  listCampaigns(filter: { kind?: CampaignKind; status?: CampaignStatus } = {}): Campaign[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.kind) {
      where.push("kind = :kind");
      params.kind = filter.kind;
    }
    if (filter.status) {
      where.push("status = :status");
      params.status = filter.status;
    }
    const sql = `SELECT * FROM campaigns ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score DESC, id ASC`;
    return (this.db.prepare(sql).all(params) as Row[]).map(rowToCampaign);
  }

  setCampaignStatus(id: number, status: CampaignStatus, now: Date = new Date()): void {
    this.db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(status, now.toISOString(), id);
  }

  addEntry(campaignId: number, status: EntryStatus, reason: string, now: Date = new Date()): Entry {
    const res = this.db
      .prepare("INSERT INTO entries (campaign_id, status, reason, created_at) VALUES (?, ?, ?, ?)")
      .run(campaignId, status, reason, now.toISOString());
    if (status === "submitted" || status === "done_manual") this.setCampaignStatus(campaignId, "entered", now);
    return this.getEntry(Number(res.lastInsertRowid))!;
  }

  getEntry(id: number): Entry | undefined {
    const r = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToEntry(r) : undefined;
  }

  listEntries(opts: { campaignId?: number; limit?: number } = {}): Entry[] {
    const limit = opts.limit ?? 1000;
    const rows =
      opts.campaignId !== undefined
        ? this.db.prepare("SELECT * FROM entries WHERE campaign_id = ? ORDER BY id DESC LIMIT ?").all(opts.campaignId, limit)
        : this.db.prepare("SELECT * FROM entries ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(rowToEntry);
  }

  /** 指定時刻以降の送信 (submitted) 件数と、最後の送信時刻 */
  submissionStats(since: Date): { count: number; lastSubmittedAt: Date | null } {
    const c = this.db
      .prepare("SELECT COUNT(*) AS n FROM entries WHERE status = 'submitted' AND created_at >= ?")
      .get(since.toISOString()) as Row;
    const l = this.db
      .prepare("SELECT MAX(created_at) AS t FROM entries WHERE status = 'submitted'")
      .get() as Row;
    return { count: Number(c.n), lastSubmittedAt: l.t ? new Date(String(l.t)) : null };
  }
}
