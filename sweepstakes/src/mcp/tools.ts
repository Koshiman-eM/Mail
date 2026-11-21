// MCP ツール定義 (src/core/service.ts の関数の薄いラッパー)
// ガード (CAPTCHA・規約禁止・重複・日次上限・送信間隔・要確認URL・詐欺除外) はすべてサービス層にあり、
// ここからは enter / runAll / collectFromSources などの公開関数だけを呼ぶ。迂回経路は作らない。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FetchLike } from "../collectors/http.js";
import { KOUBO_PRESENT_SUBCATEGORIES } from "../collectors/koubo.js";
import { PROFILE_KEYS } from "../core/profile.js";
import { QuestInputError } from "../core/quest.js";
import { FLAG_LABELS } from "../core/score.js";
import {
  addQuest,
  collectFromSources,
  COLLECTOR_SOURCES,
  enter,
  history,
  listCampaigns,
  listQuests,
  mark,
  runAll,
  todo,
  updateQuest,
  type CollectSummary,
  type EnterResult,
  type QuestResult,
  type SweepContext,
} from "../core/service.js";
import { kindLabel } from "../core/todo.js";
import { CAMPAIGN_KINDS, QUEST_DISTRIBUTIONS, QUEST_REWARD_TYPES, type Campaign, type CampaignKind, type CampaignStatus } from "../core/types.js";
import { formatQuestMetrics } from "../questCli.js";
import { JobBusyError, type Job, type JobManager } from "./jobs.js";
import { ProfileValidationError, updateProfile, type ProfilePatch, type ProfileStore } from "./profileStore.js";

export interface ToolDeps {
  ctx: SweepContext;
  jobs: JobManager;
  profileStore: ProfileStore;
  /** 収集に使う fetch (テスト用の差し替え。未指定なら実 fetch) */
  collectFetch?: FetchLike;
  /** enter_campaign を同期で待つ上限 (ms)。超えたらジョブ ID を返す */
  enterTimeoutMs?: number;
}

/** ジョブの結果 (get_job で表示する) */
interface JobOutput {
  text: string;
  data: Record<string, unknown>;
}

export const STATUS_LABEL: Record<string, string> = {
  submitted: "送信済み",
  needs_manual: "要手動",
  failed: "失敗",
  skipped: "見送り",
  done_manual: "手動完了",
  dry_run: "dry-run (未送信)",
  deferred: "保留 (上限・間隔)",
  active: "対象",
  excluded: "除外",
  expired: "締切切れ",
  entered: "応募済み",
};

const CAMPAIGN_STATUSES = ["active", "excluded", "expired", "entered"] as const satisfies readonly CampaignStatus[];
const KOUBO_CATEGORIES = ["all", ...KOUBO_PRESENT_SUBCATEGORIES] as [string, ...string[]];

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** 想定内のエラー (入力不正・見つからない・ジョブ実行中) を日本語のツールエラーにする */
async function guarded(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof JobBusyError) return fail(e.message);
    if (e instanceof ProfileValidationError || e instanceof QuestInputError) return fail(e.message);
    return fail(`エラー: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const flagText = (flags: string[]) => flags.map((f) => FLAG_LABELS[f] ?? f).join(" / ");

function campaignSummary(c: Campaign) {
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    title: c.title,
    url: c.url,
    prize: c.prize,
    score: Math.round(c.score * 100) / 100,
    deadline: c.deadline ?? null,
    riskFlags: c.riskFlags,
  };
}

function campaignLine(c: Campaign): string {
  const lines = [
    `#${c.id} [${kindLabel(c.kind)} / ${STATUS_LABEL[c.status] ?? c.status}] ${c.title}`,
    `   締切 ${c.deadline?.slice(0, 10) ?? "なし"} / スコア ${c.score.toFixed(2)}${c.prize ? ` / 賞品: ${c.prize}` : ""}`,
    `   ${c.url}`,
  ];
  if (c.riskFlags.length) lines.push(`   [注意] ${flagText(c.riskFlags)}`);
  return lines.join("\n");
}

function enterText(r: EnterResult): string {
  const lines = [`#${r.campaignId} ${r.title}`, `  結果: ${STATUS_LABEL[r.status] ?? r.status}${r.recorded ? " (履歴に記録)" : ""}`, `  理由: ${r.reason}`];
  if (r.filled.length) lines.push("  入力した欄:", ...r.filled.map((f) => `    - ${f.label} [${f.key}] = ${f.value}`));
  if (r.screenshotPath) lines.push(`  スクリーンショット (サーバー上): ${r.screenshotPath}`);
  return lines.join("\n");
}

function enterData(r: EnterResult): Record<string, unknown> {
  return { ...r, filled: r.filled.map((f) => ({ ...f })) };
}

function runSummaryText(results: EnterResult[], submit: boolean): string {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const head = submit ? "Webフォーム一括応募 (送信あり)" : "Webフォーム一括応募 (dry-run: 送信なし)";
  if (!results.length) return `${head}: 処理対象の Webフォーム懸賞はありません`;
  return [
    `${head}: 合計 ${results.length} 件 — 送信 ${count("submitted")} / dry-run ${count("dry_run")} / 要手動 ${count("needs_manual")} / 見送り ${count("skipped")} / 失敗 ${count("failed")} / 上限保留 ${count("deferred")}`,
    "",
    ...results.map(enterText),
  ].join("\n");
}

function collectText(s: CollectSummary): string {
  const lines = [`収集完了: ${s.total} 件 (新規 ${s.added} / 更新 ${s.updated} / 除外 ${s.excluded} / 締切切れ ${s.expired})`];
  for (const e of s.errors) lines.push(`  エラー: ${e}`);
  return lines.join("\n");
}

function questText(r: QuestResult, verb: string): string {
  const c = r.campaign;
  const lines = [
    `#${c.id} を${verb}しました: ${c.title}`,
    `  ${c.url}`,
    `  状態: ${STATUS_LABEL[c.status] ?? c.status} / 報酬: ${c.prize}`,
    `  ${formatQuestMetrics(r.metrics)}`,
  ];
  if (r.excludedReason) lines.push(`  [除外理由] ${r.excludedReason}`);
  else if (c.riskFlags.length) lines.push(`  [注意] ${flagText(c.riskFlags)}`);
  for (const d of r.scamDetails) lines.push(`    - ${d}`);
  for (const w of r.warnings) lines.push(`  [警告] ${w}`);
  if (c.status === "active") lines.push("  ウォレット署名・SNS 操作は自動化しません。get_todo の手順に従って手動で行い、完了したら mark_done してください");
  return lines.join("\n");
}

function questData(r: QuestResult): Record<string, unknown> {
  return {
    campaign: campaignSummary(r.campaign),
    created: r.created,
    metrics: r.metrics,
    warnings: r.warnings,
    reasons: r.reasons,
    scamDetails: r.scamDetails,
    excludedReason: r.excludedReason ?? null,
  };
}

function jobView(job: Job, logTail = 30) {
  const out = job.result as JobOutput | null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log.slice(-logTail),
    result: out?.data ?? null,
    error: job.error,
  };
}

const JOB_STATUS_LABEL: Record<string, string> = { running: "実行中", succeeded: "完了", failed: "失敗" };

function jobText(job: Job, logTail = 30): string {
  const lines = [`ジョブ ${job.id} (${job.kind}): ${JOB_STATUS_LABEL[job.status] ?? job.status}`, `  開始 ${job.startedAt}${job.finishedAt ? ` / 終了 ${job.finishedAt}` : ""}`];
  if (job.status === "running") {
    lines.push("  まだ実行中です。しばらくしてから get_job で再確認してください (送信間隔の待機で数分〜数十分かかることがあります)");
  }
  if (job.error) lines.push(`  エラー: ${job.error}`);
  const out = job.result as JobOutput | null;
  if (out) lines.push("", out.text);
  const tail = job.log.slice(-logTail);
  if (tail.length) lines.push("", `進捗ログ (直近 ${tail.length} 行):`, ...tail.map((l) => `  ${l}`));
  return lines.join("\n");
}

function jobStartedText(job: Job, what: string): string {
  return `${what}をジョブとして開始しました。\nジョブ ID: ${job.id}\n完了まで数分〜数十分かかることがあります。get_job (id: "${job.id}") で進捗と結果を確認してください。`;
}

/** ジョブ用に ctx.log を差し替えたコンテキスト */
function jobCtx(ctx: SweepContext, log: (m: string) => void): SweepContext {
  return {
    ...ctx,
    log: (m) => {
      log(m);
      ctx.log(m);
    },
  };
}

const id = z.number().int().positive().describe("キャンペーン ID (list_campaigns / get_todo / quest_list に表示される #番号)");
const nnum = () => z.number().finite().nonnegative();
const nint = () => z.number().int().nonnegative();

const questFields = {
  title: z.string().max(300).optional().describe("タイトル (fetch=true のとき未指定ならページから補完)"),
  rewardType: z.enum(QUEST_REWARD_TYPES as [string, ...string[]]).optional().describe("報酬の種類 (既定 other)"),
  distribution: z.enum(QUEST_DISTRIBUTIONS as [string, ...string[]]).optional().describe("raffle=抽選 / fcfs=先着 / all=全員 / leaderboard=順位制 (既定 raffle)"),
  requiresOnchainTx: z.boolean().optional().describe("オンチェーン操作 (トランザクション) が必要か"),
};
const questNullableFields = {
  rewardAmount: nnum().nullable().optional().describe("報酬額"),
  rewardCurrency: z.string().max(15).nullable().optional().describe("USD / USDT / USDC / JPY / トークン記号"),
  rewardValueJpy: nnum().nullable().optional().describe("円換算額を直接指定 (換算より優先)"),
  winners: nint().nullable().optional().describe("当選数 / 先着枠"),
  participants: nint().nullable().optional().describe("参加者数"),
  estMinutes: nnum().nullable().optional().describe("所要時間 (分)"),
  deadline: z.string().max(40).nullable().optional().describe("締切 (YYYY-MM-DD または ISO 8601)"),
  gasCostJpy: nnum().nullable().optional().describe("ガス代の見込み (円)"),
  notes: z.string().max(2000).nullable().optional().describe("メモ"),
};

const profileShape = Object.fromEntries(
  PROFILE_KEYS.map((k) => [k, z.string().max(200).optional()]),
) as Record<(typeof PROFILE_KEYS)[number], z.ZodOptional<z.ZodString>>;

function dropUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { ctx, jobs, profileStore } = deps;
  const enterTimeoutMs = deps.enterTimeoutMs ?? 120_000;

  // -------------------------------------------------------------------------
  // 収集・一覧
  // -------------------------------------------------------------------------
  server.registerTool(
    "collect_sweepstakes",
    {
      title: "懸賞を収集",
      description:
        "懸賞情報サイトから懸賞を収集して採点・保存するジョブを開始し、ジョブ ID を即座に返します。robots.txt を守り数秒間隔で取得するため数分〜数十分かかります。結果は get_job で確認してください。収集・応募のジョブは同時に 1 つまでです。",
      inputSchema: {
        source: z.enum(COLLECTOR_SOURCES).describe("収集元 (koubo = 公募ガイド)"),
        categories: z.array(z.enum(KOUBO_CATEGORIES)).min(1).optional().describe(`koubo のカテゴリ: all, ${KOUBO_PRESENT_SUBCATEGORIES.join(", ")} (既定: all → 全サブカテゴリ)`),
        maxDetails: z.number().int().min(0).max(1000).optional().describe("詳細ページ取得の上限件数"),
      },
      annotations: { title: "懸賞を収集", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ source, categories, maxDetails }) =>
      guarded(() => {
        const listPaths = categories?.map((c) => `/category/present/${c}`);
        const job = jobs.start<JobOutput>("collect", async (log) => {
          const s = await collectFromSources(jobCtx(ctx, log), [source], { listPaths, maxDetails, fetch: deps.collectFetch });
          return { text: collectText(s), data: { ...s } };
        });
        return ok(jobStartedText(job, "収集"), { jobId: job.id, status: job.status });
      }),
  );

  server.registerTool(
    "list_campaigns",
    {
      title: "キャンペーン一覧",
      description: "保存済みの懸賞キャンペーンをスコアの高い順に一覧表示します。",
      inputSchema: {
        kind: z.enum(CAMPAIGN_KINDS as [CampaignKind, ...CampaignKind[]]).optional().describe("種別 (web_form / x / instagram / crypto_quest)"),
        status: z.enum(CAMPAIGN_STATUSES).optional().describe("状態 (active=対象 / excluded=除外 / expired=締切切れ / entered=応募済み)"),
        limit: z.number().int().min(1).max(500).optional().describe("最大件数 (既定 50)"),
      },
      annotations: { title: "キャンペーン一覧", readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, status, limit }) =>
      guarded(() => {
        const all = listCampaigns(ctx, { kind, status });
        const items = all.slice(0, limit ?? 50);
        const text = items.length
          ? [`キャンペーン ${all.length} 件中 ${items.length} 件 (スコア順)`, "", ...items.map(campaignLine)].join("\n")
          : "該当するキャンペーンはありません";
        return ok(text, { total: all.length, campaigns: items.map(campaignSummary) });
      }),
  );

  // -------------------------------------------------------------------------
  // 応募
  // -------------------------------------------------------------------------
  server.registerTool(
    "enter_campaign",
    {
      title: "Webフォームに応募",
      description:
        "指定した Webフォーム懸賞にプロフィールを自動入力します。submit=false (既定) は送信直前で止めてスクリーンショットを保存する dry-run です。submit=true は実際に送信するので、利用者が明示的に送信を指示した場合だけ使ってください。CAPTCHA・規約で自動応募禁止・重複・日次上限・送信間隔・応募先未確認・詐欺除外のガードで見送られることがあります。送信間隔の待機などで 120 秒を超えた場合はジョブ ID を返すので get_job で確認してください。",
      inputSchema: {
        id,
        submit: z.boolean().default(false).describe("true で実際に送信 (既定 false = dry-run)"),
      },
      annotations: { title: "Webフォームに応募", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id: campaignId, submit }) =>
      guarded(async () => {
        if (!ctx.store.getCampaign(campaignId)) return fail(`キャンペーン #${campaignId} が見つかりません`);
        const job = jobs.start<JobOutput>("enter", async (log) => {
          const r = await enter(jobCtx(ctx, log), campaignId, { submit });
          return { text: (submit ? "" : "[dry-run] 送信はしていません\n") + enterText(r), data: enterData(r) };
        });
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          job.done.then(() => false),
          new Promise<boolean>((r) => (timer = setTimeout(() => r(true), enterTimeoutMs))),
        ]);
        clearTimeout(timer);
        if (timedOut) {
          return ok(
            `${enterTimeoutMs / 1000} 秒以内に終わらなかったため、処理はバックグラウンドで継続しています。\nジョブ ID: ${job.id}\nget_job で結果を確認してください (二重送信を避けるため、完了前に同じ応募を再実行しないでください)。`,
            { jobId: job.id, status: job.status },
          );
        }
        if (job.status === "failed") return fail(`応募処理に失敗しました: ${job.error}`);
        const out = job.result!;
        return ok(out.text, { jobId: job.id, ...out.data });
      }),
  );

  server.registerTool(
    "run_web_forms",
    {
      title: "Webフォーム一括応募",
      description:
        "応募可能な Webフォーム懸賞 (未処理・締切前・応募先確認済み) をスコア順に一括処理するジョブを開始し、ジョブ ID を即座に返します。submit=false (既定) は dry-run。submit=true は実際に送信するので、利用者が明示的に指示した場合だけ使ってください。送信間隔の待機で数分〜数十分かかり、日次上限に達すると停止します。結果は get_job で確認してください。",
      inputSchema: {
        submit: z.boolean().default(false).describe("true で実際に送信 (既定 false = dry-run)"),
        limit: z.number().int().min(1).max(200).optional().describe("処理する最大件数 (スコア上位から)"),
      },
      annotations: { title: "Webフォーム一括応募", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ submit, limit }) =>
      guarded(() => {
        const job = jobs.start<JobOutput>("run_web_forms", async (log) => {
          const results = await runAll(jobCtx(ctx, log), { submit, limit });
          return { text: runSummaryText(results, submit), data: { submit, results: results.map(enterData) } };
        });
        return ok(jobStartedText(job, submit ? "Webフォーム一括応募 (送信あり)" : "Webフォーム一括応募 (dry-run)"), { jobId: job.id, status: job.status });
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "ジョブの進捗・結果",
      description: "collect_sweepstakes / run_web_forms / enter_campaign で開始したジョブの進捗ログと結果を返します。id を省略すると最近のジョブ一覧を返します。",
      inputSchema: {
        id: z.string().max(100).optional().describe("ジョブ ID"),
      },
      annotations: { title: "ジョブの進捗・結果", readOnlyHint: true, openWorldHint: false },
    },
    async ({ id: jobId }) =>
      guarded(() => {
        if (!jobId) {
          const list = jobs.list().slice(0, 20);
          if (!list.length) return ok("ジョブはまだありません", { jobs: [] });
          const text = list.map((j) => `${j.id} ${j.kind}: ${JOB_STATUS_LABEL[j.status] ?? j.status} (開始 ${j.startedAt})`).join("\n");
          return ok(text, { jobs: list.map((j) => ({ id: j.id, kind: j.kind, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt })) });
        }
        const job = jobs.get(jobId);
        if (!job) return fail(`ジョブ ${jobId} が見つかりません (サーバー再起動で消えたか、古いため破棄された可能性があります。get_history で応募履歴を確認してください)`);
        return ok(jobText(job), jobView(job));
      }),
  );

  // -------------------------------------------------------------------------
  // 手動タスク・履歴
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_todo",
    {
      title: "今日やること",
      description: "X / Instagram / 仮想通貨クエストなど手動で行う懸賞の「今日やること」を締切が近い順に返します。フォロー・RT・いいね・ウォレット署名などは自動化しないので、利用者が手順に従って手動で行い、終わったら mark_done で記録します。",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("最大件数 (既定 30)"),
      },
      annotations: { title: "今日やること", readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guarded(() => {
        const all = todo(ctx);
        const items = all.slice(0, limit ?? 30);
        if (!items.length) return ok("今日やることはありません", { total: 0, items: [] });
        const text = [
          `今日やること ${all.length} 件 (締切が近い順 → スコア順)`,
          "",
          ...items.map((t, i) => {
            const c = t.campaign;
            const left = t.hoursLeft === null ? "締切なし" : t.hoursLeft < 24 ? `残り ${t.hoursLeft} 時間` : `残り ${Math.floor(t.hoursLeft / 24)} 日`;
            const lines = [`${i + 1}. [#${c.id}] ${kindLabel(c.kind)}: ${c.title} (${left} / スコア ${c.score.toFixed(2)})`, `   ${c.url}`];
            if (c.prize) lines.push(`   賞品: ${c.prize}`);
            if (t.questMetrics) lines.push(`   ${formatQuestMetrics(t.questMetrics)}`);
            t.steps.forEach((s, j) => lines.push(`   ${j + 1}) ${s}`));
            if (t.warnings.length) lines.push(`   [注意] ${t.warnings.join(" / ")}`);
            return lines.join("\n");
          }),
        ].join("\n");
        return ok(text, {
          total: all.length,
          items: items.map((t) => ({ campaign: campaignSummary(t.campaign), hoursLeft: t.hoursLeft, steps: t.steps, warnings: t.warnings, questMetrics: t.questMetrics ?? null })),
        });
      }),
  );

  server.registerTool(
    "mark_done",
    {
      title: "手動タスクを完了にする",
      description: "利用者が手動で応募を済ませたキャンペーンを完了 (手動完了) として履歴に記録します。",
      inputSchema: {
        id,
        note: z.string().max(500).optional().describe("メモ (既定: 手動で完了)"),
      },
      annotations: { title: "手動タスクを完了にする", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id: campaignId, note }) =>
      guarded(() => {
        const e = mark(ctx, campaignId, note ?? "手動で完了");
        const c = ctx.store.getCampaign(campaignId)!;
        return ok(`#${campaignId} ${c.title} を手動完了として記録しました (${e.createdAt})`, { entry: { ...e } });
      }),
  );

  server.registerTool(
    "get_history",
    {
      title: "応募履歴",
      description: "応募・見送り・手動完了などの履歴を新しい順に返します。",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("最大件数 (既定 50)"),
      },
      annotations: { title: "応募履歴", readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guarded(() => {
        const items = history(ctx, { limit: limit ?? 50 });
        if (!items.length) return ok("履歴はありません", { items: [] });
        const text = items.map((h) => `${h.createdAt} ${STATUS_LABEL[h.status] ?? h.status} #${h.campaignId} ${h.title}${h.reason ? `\n    ${h.reason}` : ""}`).join("\n");
        return ok(text, { items: items.map((h) => ({ ...h })) });
      }),
  );

  // -------------------------------------------------------------------------
  // 仮想通貨クエスト (手動登録)
  // -------------------------------------------------------------------------
  server.registerTool(
    "quest_add",
    {
      title: "仮想通貨クエストを登録",
      description:
        "仮想通貨クエスト (Galxe / Zealy など) を手動登録し、詐欺チェックと期待値・時給の採点を行います。同じ URL は上書き更新。fetch=true のときだけ URL を 1 回取得してタイトル補完・本文の詐欺チェックをします。ウォレット署名・トランザクション・SNS 操作は自動化しません。",
      inputSchema: {
        url: z.string().max(2000).describe("クエストの URL (http/https)"),
        ...questFields,
        ...questNullableFields,
        fetch: z.boolean().default(false).describe("true で URL を 1 回取得してタイトル補完・詐欺チェック"),
      },
      annotations: { title: "仮想通貨クエストを登録", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ fetch, ...input }) =>
      guarded(async () => {
        const r = await addQuest(ctx, dropUndefined(input) as Parameters<typeof addQuest>[1], { fetch });
        return ok(questText(r, r.created ? "登録" : "更新"), questData(r));
      }),
  );

  server.registerTool(
    "quest_update",
    {
      title: "仮想通貨クエストを更新",
      description: "登録済みの仮想通貨クエストを部分更新して再採点します。指定しない項目は変更なし、null を指定すると値を消します。URL は変更できません。",
      inputSchema: { id, ...questFields, ...questNullableFields },
      annotations: { title: "仮想通貨クエストを更新", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id: questId, ...patch }) =>
      guarded(() => {
        const p = dropUndefined(patch);
        if (!Object.keys(p).length) return fail("変更する項目を 1 つ以上指定してください");
        const r = updateQuest(ctx, questId, p as Parameters<typeof updateQuest>[2]);
        return ok(questText(r, "更新"), questData(r));
      }),
  );

  server.registerTool(
    "quest_list",
    {
      title: "仮想通貨クエスト一覧",
      description: "登録済みの仮想通貨クエストを、対象のものから時給の高い順 (価値不明は末尾) に返します。",
      inputSchema: {},
      annotations: { title: "仮想通貨クエスト一覧", readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(() => {
        const items = listQuests(ctx);
        if (!items.length) return ok("仮想通貨クエストはありません", { items: [] });
        const text = items
          .map(({ campaign: c, metrics }) => {
            const lines = [
              `#${c.id} [${STATUS_LABEL[c.status] ?? c.status}] ${c.title} (締切 ${c.deadline?.slice(0, 10) ?? "なし"})`,
              `    ${formatQuestMetrics(metrics)} / スコア ${c.score.toFixed(2)}`,
            ];
            if (c.riskFlags.length) lines.push(`    [${c.status === "excluded" ? "除外理由" : "注意"}] ${flagText(c.riskFlags)}`);
            lines.push(`    ${c.url}`);
            return lines.join("\n");
          })
          .join("\n");
        return ok(text, { items: items.map(({ campaign, metrics }) => ({ campaign: campaignSummary(campaign), metrics })) });
      }),
  );

  // -------------------------------------------------------------------------
  // プロフィール
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_profile",
    {
      title: "プロフィールを表示",
      description: "応募フォームの自動入力に使うプロフィール (氏名・住所・電話・メール・生年月日など個人情報) を返します。",
      inputSchema: {},
      annotations: { title: "プロフィールを表示", readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guarded(() => {
        const p = profileStore.read();
        if (!p) return ok("プロフィールはまだ作成されていません。update_profile で登録してください", { exists: false, profile: null });
        const rec = p as Record<string, unknown>;
        const text = ["プロフィール:", ...PROFILE_KEYS.map((k) => `  ${k}: ${typeof rec[k] === "string" && rec[k] ? rec[k] : "(未設定)"}`)].join("\n");
        return ok(text, { exists: true, profile: Object.fromEntries(PROFILE_KEYS.map((k) => [k, typeof rec[k] === "string" ? rec[k] : ""])) });
      }),
  );

  server.registerTool(
    "update_profile",
    {
      title: "プロフィールを更新",
      description:
        "プロフィールを部分更新します (指定した項目だけ上書き)。郵便番号 (7 桁)・電話番号 (0 始まり 10〜11 桁)・メール・生年月日 (YYYY-MM-DD)・性別 (male/female/other)・フリガナ (カタカナ) の形式を検証し、不正なら何も書き込みません。address2 (建物名) は空文字で消せます。",
      inputSchema: profileShape,
      annotations: { title: "プロフィールを更新", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(() => {
        const patch = dropUndefined({ ...args }) as ProfilePatch;
        const r = updateProfile(profileStore, patch, ctx.now());
        const lines = [r.changed.length ? `プロフィールを更新しました (変更: ${r.changed.join(", ")})` : "プロフィールを保存しました (値の変更はありません)"];
        if (r.missing.length) lines.push(`[注意] まだ不足している項目があります (応募前に設定してください):`, ...r.missing.map((m) => `  - ${m}`));
        return ok(lines.join("\n"), { changed: r.changed, missing: r.missing, profile: { ...r.profile } });
      }),
  );
}

export const TOOL_NAMES = [
  "collect_sweepstakes",
  "list_campaigns",
  "enter_campaign",
  "run_web_forms",
  "get_job",
  "get_todo",
  "mark_done",
  "get_history",
  "quest_add",
  "quest_update",
  "quest_list",
  "get_profile",
  "update_profile",
] as const;
