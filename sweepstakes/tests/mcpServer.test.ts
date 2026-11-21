// MCP サーバーの結合テスト (127.0.0.1 のランダムポートのみ。実在サイトには一切アクセスしない)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/collectors/http.js";
import type { SweepContext } from "../src/core/service.js";
import { FailureLimiter, tokenEquals, validateServerToken } from "../src/mcp/auth.js";
import { JobManager } from "../src/mcp/jobs.js";
import { memoryProfileStore, validateProfilePatch } from "../src/mcp/profileStore.js";
import { loadMcpEnv, startMcpHttpServer, type RunningMcpServer } from "../src/mcp/server.js";
import { TOOL_NAMES, type ToolDeps } from "../src/mcp/tools.js";
import { addCampaign, makeTestContext, TEST_PROFILE } from "./helpers/context.js";
import { startTestServer, type TestServer } from "./helpers/server.js";

const TOKEN = "t".repeat(16) + "0123456789abcdef0123456789abcdef";
const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "koubo");
const LIST_HTML = readFileSync(join(FIX, "present_all.html"), "utf8");
const DETAIL_HTML = readFileSync(join(FIX, "detail_402340.html"), "utf8");
const NOW = new Date("2026-11-21T10:00:00+09:00");

/** 公募ガイドのモック (robots.txt・一覧・詳細)。それ以外の URL は 404 */
function mockKoubo(requested: string[]): FetchLike {
  return async (url) => {
    requested.push(url);
    const ok = (body: string) => ({ status: 200, ok: true, text: async () => body });
    if (url === "https://koubo.jp/robots.txt") return ok("User-agent: *\nAllow: /\n");
    if (url === "https://koubo.jp/category/present/all") return ok(LIST_HTML);
    if (/^https:\/\/koubo\.jp\/contest\/\d+$/.test(url)) return ok(DETAIL_HTML);
    return { status: 404, ok: false, text: async () => "" };
  };
}

let forms: TestServer;
let mcp: RunningMcpServer;
let ctx: SweepContext;
let deps: ToolDeps;
const profileStore = memoryProfileStore({ ...TEST_PROFILE });
const requested: string[] = [];
/** テストごとに差し替える収集用 fetch */
let currentFetch: FetchLike = mockKoubo(requested);
const clients: Client[] = [];

beforeAll(async () => {
  forms = await startTestServer();
  ctx = makeTestContext({}, { now: () => NOW });
  deps = {
    ctx,
    jobs: new JobManager(),
    profileStore,
    collectFetch: (url, init) => currentFetch(url, init),
  };
  mcp = await startMcpHttpServer({ token: TOKEN, deps, port: 0 });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  // 次のテストに影響しないよう実行中ジョブの完了を待つ
  await deps.jobs.running?.done;
});

afterAll(async () => {
  await mcp.close();
  await forms.close();
  ctx.store.close();
});

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const bearer = () => connect(`${mcp.url}/mcp`, { authorization: `Bearer ${TOKEN}` });

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { structuredContent?: Record<string, any> }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent?: Record<string, any> };
}

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

async function waitJob(client: Client, id: string, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const r = await call(client, "get_job", { id });
    expect(r.isError, textOf(r)).toBeFalsy();
    if (r.structuredContent!.status !== "running") return r;
    if (Date.now() - start > timeoutMs) throw new Error("job timeout");
    await new Promise((res) => setTimeout(res, 50));
  }
}

function rawPost(url: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("起動時の設定", () => {
  it("SWEEP_MCP_TOKEN 未設定・32 文字未満は起動拒否", () => {
    expect(() => loadMcpEnv({})).toThrow(/未設定/);
    expect(() => loadMcpEnv({ SWEEP_MCP_TOKEN: "short" })).toThrow(/32 文字以上/);
    expect(() => validateServerToken("a/".repeat(20))).toThrow(/スラッシュ/);
    expect(loadMcpEnv({ SWEEP_MCP_TOKEN: TOKEN })).toMatchObject({ token: TOKEN, host: "127.0.0.1", port: 8787 });
    expect(loadMcpEnv({ SWEEP_MCP_TOKEN: TOKEN, SWEEP_MCP_HOST: "0.0.0.0", SWEEP_MCP_PORT: "9000" })).toMatchObject({ host: "0.0.0.0", port: 9000 });
  });

  it("tokenEquals は長さが違っても例外にならない", () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(tokenEquals(TOKEN, "x")).toBe(false);
    expect(tokenEquals(TOKEN, null)).toBe(false);
  });
});

describe("HTTP / 認証", () => {
  it("GET /healthz は認証不要で ok のみ", async () => {
    const r = await fetch(`${mcp.url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("認証なし・誤トークン (ヘッダー / パス) は 401", async () => {
    expect((await rawPost(`${mcp.url}/mcp`)).status).toBe(401);
    expect((await rawPost(`${mcp.url}/mcp`, { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await rawPost(`${mcp.url}/mcp/${TOKEN.slice(1)}`)).status).toBe(401);
    expect((await rawPost(`${mcp.url}/mcp/${TOKEN}/extra`)).status).toBe(401);
    await expect(connect(`${mcp.url}/mcp`, { authorization: "Bearer wrong-token" })).rejects.toThrow();
    // 他のテストのためにブロック状態を残さない (成功で失敗回数をリセット)
    expect((await rawPost(`${mcp.url}/mcp`, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("Bearer 方式で接続でき、tools/list に全ツールがある", async () => {
    const client = await bearer();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.enter_campaign!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(byName.run_web_forms!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.list_campaigns!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get_profile!.annotations).toMatchObject({ readOnlyHint: true });
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
  });

  it("URL パス方式 (/mcp/<token>) でも接続できる", async () => {
    const client = await connect(`${mcp.url}/mcp/${TOKEN}`);
    const r = await call(client, "list_campaigns");
    expect(r.isError).toBeFalsy();
  });

  it("認証失敗が続く IP はブロックされ、期間後に解除される", async () => {
    let t = 0;
    const limiter = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 600_000, now: () => t });
    const logs: string[] = [];
    const s = await startMcpHttpServer({ token: TOKEN, deps, port: 0, limiter, log: (m) => logs.push(m) });
    try {
      for (let i = 0; i < 3; i++) expect((await rawPost(`${s.url}/mcp/bad-token-${i}`)).status).toBe(401);
      // ブロック中は正しいトークンでも 429
      const blocked = await rawPost(`${s.url}/mcp`, { authorization: `Bearer ${TOKEN}` });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      t += 600_001;
      expect((await rawPost(`${s.url}/mcp`, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
      // ログにトークンを出さない
      expect(logs.join("\n")).not.toContain(TOKEN);
      expect(logs.join("\n")).not.toContain("bad-token");
      expect(logs.some((l) => l.includes("/mcp/***"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("ウィンドウ外の失敗は数えない", () => {
    let t = 0;
    const l = new FailureLimiter({ maxFailures: 2, windowMs: 1000, blockMs: 5000, now: () => t });
    expect(l.recordFailure("a")).toBe(false);
    t = 2000;
    expect(l.recordFailure("a")).toBe(false);
    expect(l.blockedFor("a")).toBe(0);
    expect(l.recordFailure("a")).toBe(true);
    expect(l.blockedFor("a")).toBeGreaterThan(0);
  });
});

describe("ツールの往復", () => {
  it("list_campaigns: 種別・状態で絞り込み", async () => {
    addCampaign(ctx, { url: "https://example.com/list-a", title: "一覧テストA", kind: "x" });
    const client = await bearer();
    const r = await call(client, "list_campaigns", { kind: "x", status: "active", limit: 10 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("一覧テストA");
    expect(r.structuredContent!.campaigns.every((c: { kind: string }) => c.kind === "x")).toBe(true);
    const bad = await call(client, "list_campaigns", { kind: "fax" });
    expect(bad.isError).toBe(true);
  });

  it("quest_add → quest_update → quest_list", async () => {
    const client = await bearer();
    const r = await call(client, "quest_add", {
      url: "https://app.galxe.com/quest/mcp-test",
      title: "MCPテストクエスト",
      rewardType: "stablecoin",
      rewardAmount: 10,
      rewardCurrency: "JPY",
      winners: 100,
      participants: 1000,
      distribution: "raffle",
      estMinutes: 10,
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain("登録しました");
    const id = r.structuredContent!.campaign.id as number;
    expect(r.structuredContent!.campaign.kind).toBe("crypto_quest");

    const u = await call(client, "quest_update", { id, rewardAmount: 5000, notes: null });
    expect(u.isError, textOf(u)).toBeFalsy();
    expect(u.structuredContent!.metrics.expectedValueJpy).toBe(500); // 5000円 × 100 / 1000

    const bad = await call(client, "quest_update", { id, deadline: "not-a-date" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/deadline/);

    const l = await call(client, "quest_list");
    expect(textOf(l)).toContain("MCPテストクエスト");
  });

  it("get_profile / update_profile (部分更新・形式検証)", async () => {
    const client = await bearer();
    const g = await call(client, "get_profile");
    expect(textOf(g)).toContain("山田");
    expect(g.structuredContent!.profile.email).toBe(TEST_PROFILE.email);

    const u = await call(client, "update_profile", { city: "港区", zip: "105-0011", phone: "03-1234-5678" });
    expect(u.isError, textOf(u)).toBeFalsy();
    expect([...u.structuredContent!.changed].sort()).toEqual(["city", "phone", "zip"]);
    expect(profileStore.data).toMatchObject({ city: "港区", zip: "105-0011", lastName: "山田" });

    for (const [k, v] of [
      ["zip", "12345"],
      ["phone", "1234"],
      ["email", "not-an-email"],
      ["birthday", "1990-02-30"],
      ["birthday", "2999-01-01"],
      ["lastNameKana", "Yamada"],
    ]) {
      const before = { ...profileStore.data };
      const bad = await call(client, "update_profile", { [k!]: v });
      expect(bad.isError, `${k}=${v}`).toBe(true);
      expect(textOf(bad)).toContain(k!);
      expect(profileStore.data).toEqual(before); // 何も書き込まない
    }
    expect((await call(client, "update_profile", {})).isError).toBe(true);
  });

  it("validateProfilePatch: address2 は空にできる", () => {
    expect(validateProfilePatch({ address2: "" })).toEqual([]);
    expect(validateProfilePatch({ city: " " })).toHaveLength(1);
  });

  it("get_todo → mark_done → get_history", async () => {
    const c = addCampaign(ctx, { url: "https://example.com/todo-x", title: "TODOテスト", kind: "x" });
    const client = await bearer();
    expect(textOf(await call(client, "get_todo"))).toContain("TODOテスト");
    const m = await call(client, "mark_done", { id: c.id });
    expect(m.isError, textOf(m)).toBeFalsy();
    const h = await call(client, "get_history", { limit: 5 });
    expect(textOf(h)).toContain("TODOテスト");
    expect((await call(client, "mark_done", { id: 999999 })).isError).toBe(true);
  });
});

describe("ジョブ", () => {
  it("collect_sweepstakes はジョブ ID を即返し、get_job で完了を確認できる (モック fetch)", async () => {
    requested.length = 0;
    currentFetch = mockKoubo(requested);
    const client = await bearer();
    const r = await call(client, "collect_sweepstakes", { source: "koubo", categories: ["all"], maxDetails: 3 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const jobId = r.structuredContent!.jobId as string;
    expect(textOf(r)).toContain(jobId);
    const done = await waitJob(client, jobId);
    expect(done.structuredContent!.status, textOf(done)).toBe("succeeded");
    expect(done.structuredContent!.result.total).toBeGreaterThan(0);
    expect(textOf(done)).toContain("収集完了");
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((u) => u.startsWith("https://koubo.jp/"))).toBe(true); // モックのみ
    const missing = await call(client, "get_job", { id: "no-such-job" });
    expect(missing.isError).toBe(true);
  });

  it("run_web_forms (submit=true) はローカルフォームに送信し、get_job で結果が見える", async () => {
    forms.received.length = 0;
    const c = addCampaign(ctx, { url: `${forms.baseUrl}/forms/basic.html`, title: "MCP一括応募テスト", prizeValueJpy: 9_999_999 });
    const client = await bearer();
    const r = await call(client, "run_web_forms", { submit: true, limit: 1 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const done = await waitJob(client, r.structuredContent!.jobId);
    expect(done.structuredContent!.status, textOf(done)).toBe("succeeded");
    const results = done.structuredContent!.result.results as { campaignId: number; status: string }[];
    expect(results).toEqual([expect.objectContaining({ campaignId: c.id, status: "submitted" })]);
    expect(forms.received).toHaveLength(1);

    // 重複ガードはサービス層で効く (MCP からも迂回できない)
    const again = await call(client, "enter_campaign", { id: c.id, submit: true });
    expect(again.isError, textOf(again)).toBeFalsy();
    expect(again.structuredContent!.status).toBe("skipped");
    expect(forms.received).toHaveLength(1);
  });

  it("enter_campaign は既定で dry-run (送信しない)", async () => {
    forms.received.length = 0;
    const c = addCampaign(ctx, { url: `${forms.baseUrl}/forms/basic.html?dry`, title: "MCP dry-run" });
    const client = await bearer();
    const r = await call(client, "enter_campaign", { id: c.id });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent!.status).toBe("dry_run");
    expect(textOf(r)).toContain("dry-run");
    expect(forms.received).toHaveLength(0);
  });

  it("CAPTCHA のフォームは needs_manual (ガードを経由)", async () => {
    const c = addCampaign(ctx, { url: `${forms.baseUrl}/forms/captcha.html`, title: "MCP CAPTCHA" });
    const client = await bearer();
    const r = await call(client, "enter_campaign", { id: c.id, submit: true });
    expect(r.structuredContent!.status).toBe("needs_manual");
  });

  it("ブラウザ操作・収集は同時に 1 ジョブまで", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = mockKoubo([]);
    currentFetch = async (url, init) => {
      await gate;
      return inner(url, init);
    };
    const client = await bearer();
    const first = await call(client, "collect_sweepstakes", { source: "koubo", categories: ["all"], maxDetails: 1 });
    expect(first.isError).toBeFalsy();

    const second = await call(client, "collect_sweepstakes", { source: "koubo" });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("実行中");
    const run = await call(client, "run_web_forms", {});
    expect(run.isError).toBe(true);
    const c = addCampaign(ctx, { url: `${forms.baseUrl}/forms/basic.html?lock`, title: "ロック中" });
    const ent = await call(client, "enter_campaign", { id: c.id });
    expect(ent.isError).toBe(true);

    const running = await call(client, "get_job", { id: first.structuredContent!.jobId });
    expect(running.structuredContent!.status).toBe("running");
    release();
    const done = await waitJob(client, first.structuredContent!.jobId);
    expect(done.structuredContent!.status).toBe("succeeded");
    // 完了後は次のジョブを開始できる
    const next = await call(client, "run_web_forms", { limit: 1 });
    expect(next.isError, textOf(next)).toBeFalsy();
    await waitJob(client, next.structuredContent!.jobId);
    currentFetch = mockKoubo(requested);
  });

  it("enter_campaign がタイムアウトしたらジョブ ID を返して継続する", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowCtx: SweepContext = {
      ...ctx,
      launchBrowser: async () => {
        await gate;
        throw new Error("テスト用: ブラウザ起動失敗");
      },
    };
    const s = await startMcpHttpServer({ token: TOKEN, deps: { ...deps, ctx: slowCtx, jobs: new JobManager(), enterTimeoutMs: 100 }, port: 0 });
    try {
      const c = addCampaign(ctx, { url: `${forms.baseUrl}/forms/basic.html?slow`, title: "遅い応募" });
      const client = await connect(`${s.url}/mcp`, { authorization: `Bearer ${TOKEN}` });
      const r = await call(client, "enter_campaign", { id: c.id });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain("バックグラウンド");
      const jobId = r.structuredContent!.jobId as string;
      release();
      const done = await waitJob(client, jobId);
      expect(done.structuredContent!.status).toBe("failed");
      expect(textOf(done)).toContain("ブラウザ起動失敗");
    } finally {
      await s.close();
    }
  });
});
