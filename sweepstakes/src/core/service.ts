// コア機能の公開 API。CLI や将来の MCP サーバーはこの関数群を呼ぶだけにする。
import { chromium, type Browser } from "playwright";
import type { Collector } from "./collector.js";
import { loadConfig, type Config } from "./config.js";
import { Store } from "./db.js";
import { attemptEntry, type AttemptResult, type FilledField } from "./formFiller.js";
import { duplicateGuard, rateLimitGuard, startOfLocalDay } from "./guards.js";
import { loadProfile } from "./profile.js";
import { evaluateCampaign, isExpired } from "./score.js";
import { buildTodoList, type TodoItem } from "./todo.js";
import type { Campaign, CampaignKind, Entry, EntryStatus, Profile } from "./types.js";

export interface SweepContext {
  store: Store;
  config: Config;
  /** プロフィール (遅延読み込み可) */
  profile: () => Profile;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  launchBrowser: () => Promise<Browser>;
  /** 指定時はこのホスト以外への通信を遮断 (テスト用) */
  allowedHosts?: string[];
  log: (msg: string) => void;
}

export function createContext(overrides: Partial<SweepContext> & { config?: Config } = {}): SweepContext {
  const config = overrides.config ?? loadConfig();
  let cached: Profile | undefined;
  return {
    store: overrides.store ?? new Store(config.dbPath),
    config,
    profile: overrides.profile ?? (() => (cached ??= loadProfile(config.profilePath))),
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: overrides.random ?? Math.random,
    launchBrowser:
      overrides.launchBrowser ??
      (() => chromium.launch({ headless: config.headless, ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}) })),
    allowedHosts: overrides.allowedHosts,
    log: overrides.log ?? (() => undefined),
  };
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

export interface CollectSummary {
  total: number;
  added: number;
  updated: number;
  excluded: number;
  expired: number;
  errors: string[];
}

export async function collect(ctx: SweepContext, collectors: Collector[]): Promise<CollectSummary> {
  const sum: CollectSummary = { total: 0, added: 0, updated: 0, excluded: 0, expired: 0, errors: [] };
  const now = ctx.now();
  for (const col of collectors) {
    let items;
    try {
      items = await col.fetch();
    } catch (e) {
      sum.errors.push(`${col.name}: ${(e as Error).message}`);
      continue;
    }
    for (const item of items) {
      const ev = evaluateCampaign(item, now);
      const { created } = ctx.store.upsertCampaign(ev, now);
      sum.total++;
      if (created) sum.added++;
      else sum.updated++;
      if (ev.status === "excluded") sum.excluded++;
      if (ev.status === "expired") sum.expired++;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// list / todo / mark / history
// ---------------------------------------------------------------------------

export function listCampaigns(ctx: SweepContext, opts: { kind?: CampaignKind } = {}): Campaign[] {
  return ctx.store.listCampaigns(opts);
}

export function todo(ctx: SweepContext): TodoItem[] {
  return buildTodoList(ctx.store.listCampaigns(), ctx.store.listEntries({ limit: 100_000 }), ctx.now());
}

/** 手動タスクを完了として記録する */
export function mark(ctx: SweepContext, campaignId: number, note = "手動で完了"): Entry {
  const c = ctx.store.getCampaign(campaignId);
  if (!c) throw new Error(`キャンペーン #${campaignId} が見つかりません`);
  return ctx.store.addEntry(campaignId, "done_manual", note, ctx.now());
}

export interface HistoryItem extends Entry {
  title: string;
  url: string;
  kind: CampaignKind | "?";
}

export function history(ctx: SweepContext, opts: { limit?: number } = {}): HistoryItem[] {
  return ctx.store.listEntries({ limit: opts.limit ?? 50 }).map((e) => {
    const c = ctx.store.getCampaign(e.campaignId);
    return { ...e, title: c?.title ?? "(削除済み)", url: c?.url ?? "", kind: c?.kind ?? "?" };
  });
}

// ---------------------------------------------------------------------------
// enter / run
// ---------------------------------------------------------------------------

export type EnterStatus = EntryStatus | "dry_run" | "deferred";

export interface EnterResult {
  campaignId: number;
  title: string;
  status: EnterStatus;
  reason: string;
  /** DB に記録したか (dry-run や重複・上限による見送りは記録しない) */
  recorded: boolean;
  filled: FilledField[];
  screenshotPath?: string;
}

export interface EnterOptions {
  submit?: boolean;
  /** run から呼ぶ場合に共有するブラウザ */
  browser?: Browser;
}

export async function enter(ctx: SweepContext, campaignId: number, opts: EnterOptions = {}): Promise<EnterResult> {
  const submit = opts.submit === true;
  const c = ctx.store.getCampaign(campaignId);
  if (!c) throw new Error(`キャンペーン #${campaignId} が見つかりません`);
  const base = { campaignId, title: c.title, filled: [] as FilledField[] };
  const now = ctx.now();
  const result = (status: EnterStatus, reason: string, extra: Partial<EnterResult> = {}): EnterResult => {
    let recorded = false;
    if (submit && status !== "dry_run" && status !== "deferred") {
      ctx.store.addEntry(campaignId, status, reason, ctx.now());
      recorded = true;
    }
    return { ...base, status, reason, recorded, ...extra };
  };

  if (c.kind !== "web_form") {
    return { ...base, status: "skipped", reason: `${c.kind} は自動応募の対象外です (todo で手順を確認し、完了後に mark してください)`, recorded: false };
  }
  // 重複応募
  const dup = duplicateGuard(ctx.store.listEntries({ campaignId }));
  if (!dup.ok) return { ...base, status: "skipped", reason: dup.reason!, recorded: false };
  // 締切・除外
  if (isExpired(c.deadline, now)) return { ...base, status: "skipped", reason: "締切を過ぎています", recorded: false };
  if (c.status === "excluded") return { ...base, status: "skipped", reason: `除外対象です (${c.riskFlags.join(", ")})`, recorded: false };

  // レート制限 (実送信時のみ)
  if (submit) {
    const stats = ctx.store.submissionStats(startOfLocalDay(now));
    const rl = rateLimitGuard({
      now,
      submittedToday: stats.count,
      lastSubmittedAt: stats.lastSubmittedAt,
      dailyLimit: ctx.config.dailyLimit,
      minIntervalSec: ctx.config.minIntervalSec,
      maxIntervalSec: ctx.config.maxIntervalSec,
      random: ctx.random,
    });
    if (!rl.allowed) return { ...base, status: "deferred", reason: rl.reason!, recorded: false };
    if (rl.waitMs > 0) {
      ctx.log(`送信間隔を空けるため ${Math.ceil(rl.waitMs / 1000)} 秒待機します...`);
      await ctx.sleep(rl.waitMs);
    }
  }

  const browser = opts.browser ?? (await ctx.launchBrowser());
  let r: AttemptResult;
  try {
    const stamp = ctx.now().toISOString().replace(/[:.]/g, "-");
    r = await attemptEntry(browser, c.url, ctx.profile(), {
      submit,
      screenshotDir: ctx.config.screenshotDir,
      screenshotName: `${c.id}-${stamp}`,
      timeoutMs: ctx.config.navigationTimeoutMs,
      allowedHosts: ctx.allowedHosts,
      extraTermsText: c.conditions.terms,
    });
  } finally {
    if (!opts.browser) await browser.close();
  }
  return result(r.outcome, r.reason, { filled: r.filled, screenshotPath: r.screenshotPath });
}

/** 応募可能な web_form を一括処理する。日次上限に達したら停止 */
export async function runAll(ctx: SweepContext, opts: { submit?: boolean } = {}): Promise<EnterResult[]> {
  const now = ctx.now();
  const candidates = ctx.store
    .listCampaigns({ kind: "web_form", status: "active" })
    .filter((c) => !isExpired(c.deadline, now))
    // 何らかの記録 (送信済み・要手動・規約で見送り・失敗) があるものは一括実行の対象外。個別に enter で再試行する
    .filter((c) => ctx.store.listEntries({ campaignId: c.id, limit: 1 }).length === 0);
  const results: EnterResult[] = [];
  if (!candidates.length) return results;
  const browser = await ctx.launchBrowser();
  try {
    for (const c of candidates) {
      ctx.log(`#${c.id} ${c.title} を処理中...`);
      const r = await enter(ctx, c.id, { submit: opts.submit, browser });
      results.push(r);
      if (r.status === "deferred") break;
    }
  } finally {
    await browser.close();
  }
  return results;
}
