import { request } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISK } from "../src/appConfig";
import type { TradingMode } from "../src/core/types";
import {
  createDashboardHandler, createRateLimiter, dashboardAllowedHosts, routeDashboard, startDashboard, type DashboardDeps, type DashboardRequestContext,
} from "../src/dashboard/server";
import { DASHBOARD_HTML } from "../src/dashboard/page";
import { RISK_LIMITS_AUDIT, RISK_RAISE_CONFIRM, riskLimitsKey } from "../src/risk/settings";
import { MemoryStore } from "../src/storage/memory";

const CSRF = "ab".repeat(32);
const WRITE_TOKEN = "w-token-0123456789abcdef";

function mkDeps(mode: TradingMode = "paper", status: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  let changes = 0;
  const deps: DashboardDeps = {
    status: () => ({ mode, equity: { current: 9_000 }, risk: { peakEquity: 10_000, dayStartEquity: 9_100, ...status } }),
    store,
    learning: { snapshot: () => ({}) } as unknown as DashboardDeps["learning"],
    clock: { now: () => 1_700_000_000_000 },
    riskSettings: { mode, envLimits: DEFAULT_RISK, onChange: () => void changes++ },
  };
  return { deps, store, changes: () => changes };
}

const ctx = (o: Partial<DashboardRequestContext> & { headers?: Record<string, string> } = {}): DashboardRequestContext => ({
  csrfToken: CSRF,
  allowedHosts: dashboardAllowedHosts(8787),
  loopback: true,
  rateLimiter: createRateLimiter({ limit: 1000 }),
  ...o,
  headers: { host: "127.0.0.1:8787", "content-type": "application/json", "x-csrf-token": CSRF, origin: "http://127.0.0.1:8787", ...(o.headers ?? {}) },
});

const post = (deps: DashboardDeps, body: unknown, c: DashboardRequestContext = ctx()) =>
  routeDashboard(deps, "POST", "/api/risk-settings", { ...c, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("GET /api/risk-settings", () => {
  it("実効値・.env の値・上書き値・プリセット・範囲・現在の DD/日次損益・書き込み可否を返す (秘密情報は返さない)", async () => {
    const { deps } = mkDeps();
    const r = await routeDashboard(deps, "GET", "/api/risk-settings", ctx({ loopback: false, writeToken: WRITE_TOKEN }));
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body);
    expect(j.mode).toBe("paper");
    expect(j.effective.riskPerTrade).toBe(0.005);
    expect(j.env.maxOpenPositions).toBe(8);
    expect(j.override).toBeNull();
    expect(j.presets.map((p: { id: string }) => p.id)).toEqual(["conservative", "standard", "aggressive"]);
    expect(j.fields.find((f: { key: string }) => f.key === "maxDrawdown")).toMatchObject({ kind: "ratio", max: 0.5, env: "MAX_DRAWDOWN" });
    expect(j.fields.find((f: { key: string }) => f.key === "maxOrdersPerMinute")).toMatchObject({ lowerOnly: true, inPreset: false });
    expect(j.current.drawdownPct).toBeCloseTo(0.1, 10);
    expect(j.current.dailyLossPct).toBeCloseTo(100 / 9_100, 10);
    expect(j.write).toMatchObject({ allowed: false, needsToken: true });
    expect(j.confirmPhrase).toBe(RISK_RAISE_CONFIRM);
    expect(r.body).not.toContain(WRITE_TOKEN);
    expect(r.body).not.toContain(CSRF);
  });

  it("riskSettings が無いエンジンでは 404", async () => {
    const { deps } = mkDeps();
    delete deps.riskSettings;
    expect((await routeDashboard(deps, "GET", "/api/risk-settings")).status).toBe(404);
    expect((await post(deps, { action: "reset" })).status).toBe(404);
  });
});

describe("POST /api/risk-settings: 防御", () => {
  it("CSRF トークン無し・不一致は 403、ページには CSRF トークンを埋め込む", async () => {
    const { deps, store } = mkDeps();
    const body = { action: "set", values: { riskPerTrade: 0.004 } };
    const noTok = ctx();
    delete noTok.headers["x-csrf-token"];
    expect((await post(deps, body, noTok)).status).toBe(403);
    expect((await post(deps, body, ctx({ headers: { "x-csrf-token": "cd".repeat(32) } }))).status).toBe(403);
    expect((await post(deps, body, ctx({ headers: { "x-csrf-token": CSRF + "00" } }))).status).toBe(403);
    // ctx が無い (テスト用の直接呼び出し) と書き込めない
    expect((await routeDashboard(deps, "POST", "/api/risk-settings")).status).toBe(403);
    expect(store.kvGet(riskLimitsKey("paper"))).toBeUndefined();
    const page = await routeDashboard(deps, "GET", "/", ctx());
    expect(page.body).toContain(`<meta name="csrf-token" content="${CSRF}">`);
    expect(DASHBOARD_HTML).toContain("__CSRF_TOKEN__");
    expect((await routeDashboard(deps, "GET", "/")).body).toContain('<meta name="csrf-token" content="">');
  });

  it("Origin が Host と違う・許可外・null は 403。Origin が無ければ通す", async () => {
    const { deps } = mkDeps();
    const body = { action: "set", values: { riskPerTrade: 0.004 } };
    for (const origin of ["http://attacker.example:8787", "http://localhost:9999", "null", "file://x"]) {
      expect((await post(deps, body, ctx({ headers: { origin } }))).status).toBe(403);
    }
    const noOrigin = ctx();
    delete noOrigin.headers.origin;
    expect((await post(deps, body, noOrigin)).status).toBe(200);
  });

  it("Content-Type が application/json 以外は 415、JSON でなければ 400", async () => {
    const { deps } = mkDeps();
    expect((await post(deps, { action: "reset" }, ctx({ headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await post(deps, { action: "reset" }, ctx({ headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(415);
    expect((await post(deps, { action: "reset" }, ctx({ headers: { "content-type": "application/json; charset=utf-8" } }))).status).toBe(200);
    expect((await post(deps, "{not json", ctx())).status).toBe(400);
  });

  it("ループバック以外: トークン未設定 (または短い) なら 403、Bearer 不一致も 403、一致すれば書き込める", async () => {
    const { deps, store } = mkDeps();
    const body = { action: "set", values: { riskPerTrade: 0.004 } };
    const lan = { loopback: false, allowedHosts: dashboardAllowedHosts(8787, "192.168.1.5") };
    const h = { host: "192.168.1.5:8787", origin: "http://192.168.1.5:8787" };
    const r1 = await post(deps, body, ctx({ ...lan, headers: h }));
    expect(r1.status).toBe(403);
    expect(JSON.parse(r1.body).error).toMatch(/DASHBOARD_WRITE_TOKEN/);
    expect((await post(deps, body, ctx({ ...lan, writeToken: "short", headers: { ...h, authorization: "Bearer short" } }))).status).toBe(403);
    expect((await post(deps, body, ctx({ ...lan, writeToken: WRITE_TOKEN, headers: h }))).status).toBe(403);
    expect((await post(deps, body, ctx({ ...lan, writeToken: WRITE_TOKEN, headers: { ...h, authorization: "Bearer wrong-token-0123456789" } }))).status).toBe(403);
    expect(store.kvGet(riskLimitsKey("paper"))).toBeUndefined();
    const ok = await post(deps, body, ctx({ ...lan, writeToken: WRITE_TOKEN, headers: { ...h, authorization: `Bearer ${WRITE_TOKEN}` } }));
    expect(ok.status).toBe(200);
    expect(store.kvGet(riskLimitsKey("paper"))).toMatchObject({ values: { riskPerTrade: 0.004 } });
  });

  it("レート制限 (1 分 10 回) を超えると 429", async () => {
    const { deps } = mkDeps();
    let t = 0;
    const c = ctx({ rateLimiter: createRateLimiter({ now: () => t }) });
    const st: number[] = [];
    for (let i = 0; i < 11; i++) st.push((await post(deps, { action: "reset" }, c)).status);
    expect(st.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(st[10]).toBe(429);
    t += 60_000;
    expect((await post(deps, { action: "reset" }, c)).status).toBe(200);
  });

  it("他のパスへの POST・PUT などは 405", async () => {
    const { deps } = mkDeps();
    expect((await routeDashboard(deps, "POST", "/api/status", ctx())).status).toBe(405);
    const put = await routeDashboard(deps, "PUT", "/api/risk-settings", ctx());
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("GET, HEAD, POST");
  });
});

describe("POST /api/risk-settings: 検証と反映", () => {
  it("範囲外は 400 (項目ごとのエラー)", async () => {
    const { deps } = mkDeps();
    const r = await post(deps, { action: "set", values: { riskPerTrade: 0.5, maxOpenPositions: 1.5 } });
    expect(r.status).toBe(400);
    const j = JSON.parse(r.body);
    expect(Object.keys(j.fieldErrors).sort()).toEqual(["maxOpenPositions", "riskPerTrade"]);
  });

  it("live: 上げる変更は 409 (確認語を求める)、確認語付きで成功。下げる変更は即時。監査ログと即時反映のフック", async () => {
    const { deps, store, changes } = mkDeps("live");
    const r = await post(deps, { action: "set", values: { riskPerTrade: 0.01 } });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({ needs: ["raise"], confirmPhrase: RISK_RAISE_CONFIRM, raisedKeys: ["riskPerTrade"] });
    expect(changes()).toBe(0);
    const ok = await post(deps, { action: "set", values: { riskPerTrade: 0.01 }, confirm: RISK_RAISE_CONFIRM });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ changed: true, raised: true, settings: { effective: { riskPerTrade: 0.01 }, sources: { riskPerTrade: "dashboard" } } });
    expect(changes()).toBe(1);
    const down = await post(deps, { action: "set", values: { riskPerTrade: 0.002 } });
    expect(down.status).toBe(200);
    expect(JSON.parse(down.body)).toMatchObject({ raised: false });
    const audits = store.listAudit({}).filter((e) => e.type === RISK_LIMITS_AUDIT);
    expect(audits.map((a) => a.data.raised)).toEqual([true, false]);
    expect(audits[0].data).toMatchObject({ mode: "live", source: "dashboard", before: { riskPerTrade: 0.005 }, after: { riskPerTrade: 0.01 } });
    // ライブのログにも出る
    const ev = JSON.parse((await routeDashboard(deps, "GET", "/api/events")).body).events;
    expect(ev.some((e: { type: string }) => e.type === RISK_LIMITS_AUDIT)).toBe(true);
  });

  it("DD 警告: 最大 DD を現在の DD (10%) 以下にすると paper でも 409、acknowledgeDrawdown で保存", async () => {
    const { deps } = mkDeps("paper");
    const r = await post(deps, { action: "set", values: { maxDrawdown: 0.1 } });
    expect(r.status).toBe(409);
    const j = JSON.parse(r.body);
    expect(j.needs).toEqual(["drawdown"]);
    expect(j.drawdownPct).toBeCloseTo(0.1, 10);
    expect(j.error).toMatch(/キルスイッチ/);
    const ok = await post(deps, { action: "set", values: { maxDrawdown: 0.1 }, acknowledgeDrawdown: true });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).warnings.join("")).toMatch(/キルスイッチ/);
  });

  it(".env の値に戻す: 上書きを削除", async () => {
    const { deps, store } = mkDeps("paper");
    await post(deps, { action: "set", values: { maxOpenPositions: 4 } });
    expect(store.kvGet(riskLimitsKey("paper"))).toBeDefined();
    const r = await post(deps, { action: "reset" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).settings).toMatchObject({ override: null, effective: { maxOpenPositions: 8 } });
    expect(store.kvGet(riskLimitsKey("paper"))).toBeUndefined();
  });
});

/** 生の HTTP 要求 (ループバック内で完結) */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("startDashboard: 実際の HTTP", () => {
  it("ページの CSRF トークンで書き込める。本文 8KB 超は 413", async () => {
    const { deps, store } = mkDeps("paper");
    const srv = await startDashboard(deps, { port: 0 });
    try {
      const addr = srv.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const host = `127.0.0.1:${port}`;
      const page = await raw(port, "GET", "/", { host });
      const tok = /<meta name="csrf-token" content="([0-9a-f]+)">/.exec(page.body)?.[1];
      expect(tok).toMatch(/^[0-9a-f]{64}$/);
      const h = { host, origin: `http://${host}`, "content-type": "application/json", "x-csrf-token": tok! };
      const ok = await raw(port, "POST", "/api/risk-settings", h, JSON.stringify({ action: "set", values: { maxOpenPositions: 5 } }));
      expect(ok.status).toBe(200);
      expect(store.kvGet(riskLimitsKey("paper"))).toMatchObject({ values: { maxOpenPositions: 5 } });
      const big = await raw(port, "POST", "/api/risk-settings", h, JSON.stringify({ action: "reset", confirm: "x".repeat(9000) }));
      expect(big.status).toBe(413);
      expect((await raw(port, "POST", "/api/risk-settings", { ...h, host: `attacker.example:${port}` }, "{}")).status).toBe(403);
      const g = JSON.parse((await raw(port, "GET", "/api/risk-settings", { host })).body);
      expect(g.write).toMatchObject({ allowed: true });
      expect(g.override.values).toEqual({ maxOpenPositions: 5 });
    } finally {
      await srv.close();
    }
  });

  it("ハンドラー: ループバック以外を bind したらトークン無しの書き込みは 403 (モックの req)", async () => {
    const { deps } = mkDeps("paper");
    const allowed = dashboardAllowedHosts(8787, "192.168.1.5");
    const handler = createDashboardHandler(deps, { allowedHosts: allowed, bindHost: "192.168.1.5", csrfToken: CSRF });
    let status = 0;
    const res = { writeHead: (s: number) => void (status = s), end: () => undefined };
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ action: "reset" }))]), {
      method: "POST", url: "/api/risk-settings", socket: { localPort: 8787 },
      headers: { host: "192.168.1.5:8787", "content-type": "application/json", "x-csrf-token": CSRF },
    });
    await handler(req as never, res as never);
    expect(status).toBe(403);
  });
});

describe("画面 (page.ts)", () => {
  it("リスクタブがあり、スクリプトが構文として正しい", () => {
    expect(DASHBOARD_HTML).toContain('data-tab="risk"');
    expect(DASHBOARD_HTML).toContain('data-pane="risk"');
    expect(DASHBOARD_HTML).toContain("X-CSRF-Token");
    expect(DASHBOARD_HTML).toContain(".env の値に戻す");
    const script = /<script>([\s\S]*)<\/script>/.exec(DASHBOARD_HTML)![1];
    expect(() => new Function(script)).not.toThrow();
  });
});
