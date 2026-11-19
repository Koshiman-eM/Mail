import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Signal, Strategy, StrategyContext } from "../src/core/types";
import {
  createDashboardHandler, dashboardAllowedHosts, isAllowedHost, parseLimit, routeDashboard, startDashboard, type DashboardDeps,
} from "../src/dashboard/server";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const START = Date.UTC(2026, 0, 5);
const MIN = 60_000;

/** 建てて次の足で flat を出すテスト用戦略 */
const flipper: Strategy = {
  id: "flipper", horizon: "scalp", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol"],
  primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: {}, paramBounds: {},
  evaluate(ctx: StrategyContext): Signal | null {
    const base = { strategyId: "flipper", horizon: "scalp" as const, symbol: ctx.market.instrument.symbol, entry: { type: "market" as const }, features: {} };
    if (ctx.position) return { ...base, direction: "flat", confidence: 1, expectedEdgeBps: 0, stopLoss: 0, maxHoldMs: 0, reason: "flat" };
    const px = ctx.market.quote.ask;
    return { ...base, direction: "long", confidence: 0.8, expectedEdgeBps: 200, stopLoss: px * 0.98, maxHoldMs: 10 * MIN, reason: "テスト" };
  },
};

async function deps(): Promise<DashboardDeps> {
  const clock = { t: START, now() { return this.t; } };
  const rt = await buildRuntime(loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory" }), {
    clock, store: new MemoryStore(), intelSources: [], ai: null, seed: 2, syntheticHistoryMs: 86_400_000, strategies: [flipper], rng: mulberry32(1),
  });
  await rt.engine.tick(START);
  await rt.engine.runIntel(START);
  clock.t = START + MIN;
  await rt.engine.tick(clock.t); // flat で決済
  clock.t = START + 2 * MIN;
  await rt.engine.tick(clock.t); // 再エントリー (保有中)
  return {
    status: () => rt.engine.status(),
    store: rt.store,
    learning: rt.learning,
    clock: rt.clock,
    baseCurrency: "JPY",
    toAccount: (c) => rt.fx.toAccount(c),
    quoteCurrencyOf: (s) => rt.hub.instrument(s)?.quoteCurrency,
  };
}

describe("ダッシュボード (listen せずにハンドラーを呼ぶ)", () => {
  it("GET /api/status: モード・評価額・リスク・ポジション・計画とブリーフの要約", async () => {
    const d = await deps();
    const r = await routeDashboard(d, "GET", "/api/status");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.headers["cache-control"]).toBe("no-store");
    const s = JSON.parse(r.body);
    expect(s.mode).toBe("paper");
    expect(s.equity.current).toBeGreaterThan(0);
    expect(s.risk.halted).toBe(false);
    expect(s.positions.map((p: { symbol: string }) => p.symbol).sort()).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(s.plan.symbols.length).toBe(5);
    expect(s.brief.stub).toBe(true);
    expect(Array.isArray(s.equityHistory)).toBe(true);
  });

  it("GET /api/trades: 新しい順のトレードと要因分析・戦略別成績", async () => {
    const d = await deps();
    const r = await routeDashboard(d, "GET", "/api/trades?limit=1");
    const t = JSON.parse(r.body);
    expect(t.baseCurrency).toBe("JPY");
    expect(t.trades).toHaveLength(1);
    const all = JSON.parse((await routeDashboard(d, "GET", "/api/trades")).body);
    expect(all.trades).toHaveLength(2);
    for (const x of all.trades) {
      expect(x.exitReason).toBe("signal");
      expect(x.attribution.causes.length).toBeGreaterThan(0);
      expect(typeof x.attribution.causes[0].label).toBe("string");
      // USDT → JPY は決済時点の合成 USD/JPY の仲値 (engine.exit の監査ログ) で換算
      const exit = d.store.listAudit({ type: "engine.exit" }).find((a) => a.data.tradeId === x.id)!;
      const rate = exit.data.fxRate as number;
      expect(rate).toBeGreaterThan(50);
      expect(x.netPnlAccount).toBeCloseTo(x.netPnl * rate, 6);
      expect(exit.data.netPnlAccount).toBeCloseTo(x.netPnlAccount, 6);
    }
    expect(all.byStrategy[0]).toMatchObject({ strategyId: "flipper", trades: 2 });
    expect(all.exitReasons).toEqual({ signal: 2 });
    expect(all.trades.some((x: { estimated?: boolean }) => x.estimated)).toBe(false);
  });

  it("GET /api/trades: 推定 (建玉・手動の申告で確定) を含むトレードには estimated を付ける", async () => {
    const d = await deps();
    const [t] = d.store.listTrades();
    d.store.saveTrade({ ...t, id: "est-1", exitTs: t.exitTs + 1, estimated: true });
    const all = JSON.parse((await routeDashboard(d, "GET", "/api/trades")).body);
    expect(all.trades.filter((x: { estimated?: boolean }) => x.estimated).map((x: { id: string }) => x.id)).toEqual(["est-1"]);
  });

  it("GET /api/learning: 学習スナップショット", async () => {
    const d = await deps();
    const l = JSON.parse((await routeDashboard(d, "GET", "/api/learning")).body);
    expect(l.arms.length).toBeGreaterThan(0);
    expect(l.causes.trades).toBe(2);
    expect(l.intelInfluence).toHaveProperty("crypto");
    expect(l.causeLabels.slippage).toBe("約定ずれ");
    expect(Array.isArray(l.lessons)).toBe(true);
    expect(Array.isArray(l.adjustments)).toBe(true);
  });

  it("GET /: 単一 HTML (日本語・自動更新・ライト/ダーク・スマホ幅・外部 CDN なし)", async () => {
    const d = await deps();
    const r = await routeDashboard(d, "GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    const html = r.body;
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("評価額の推移");
    expect(html).toContain("損益要因");
    expect(html).toContain("教訓");
    expect(html).toContain("パラメータ調整");
    expect(html).toContain("情報源の信頼度");
    expect(html).toContain("腕の成績");
    expect(html).toContain("setInterval(refresh, 5000)");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<svg");
    // 外部リソースを読み込まない
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']https?:/i);
    expect(html).not.toMatch(/@import|cdn\./i);
  });

  it("読み取り専用: GET/HEAD 以外は 405、未知のパスは 404", async () => {
    const d = await deps();
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await routeDashboard(d, m, "/api/status");
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
    expect((await routeDashboard(d, "GET", "/api/nope")).status).toBe(404);
    expect(parseLimit("abc")).toBe(50);
    expect(parseLimit("100000")).toBe(500);
    expect(parseLimit("0")).toBe(50);
  });

  it("node:http 用ハンドラー (モックの req/res)", async () => {
    const d = await deps();
    const handler = createDashboardHandler(d);
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const res = {
      writeHead: (s: number, h: Record<string, string>) => {
        status = s;
        headers = h;
      },
      end: (b?: string) => {
        body = b ?? "";
      },
    };
    const req = (method: string, url: string, host = "127.0.0.1:8787") => ({ method, url, headers: { host }, socket: { localPort: 8787 } }) as never;
    await handler(req("GET", "/api/status"), res as never);
    expect(status).toBe(200);
    expect(headers["content-type"]).toMatch(/json/);
    expect(JSON.parse(body).mode).toBe("paper");
    await handler(req("HEAD", "/"), res as never);
    expect(body).toBe("");
  });

  it("既定の bind は 127.0.0.1 (ループバック)", async () => {
    const d = await deps();
    const srv = await startDashboard(d, { port: 0 });
    try {
      const addr = srv.server.address();
      expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally {
      await srv.close();
    }
  });
});

/** buildRuntime を使わない最小の deps */
const lightDeps = (status: () => unknown = () => ({ ok: true })): DashboardDeps => ({
  status,
  store: new MemoryStore(),
  learning: { snapshot: () => ({}) } as unknown as DashboardDeps["learning"],
});

/** Host ヘッダーを指定して GET (node:http はループバック内で完結する) */
function getWithHost(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

describe("ダッシュボード: Host 検証 (DNS rebinding 対策) と 500 応答", () => {
  it("許可 Host はループバック名 + ポート。DASHBOARD_HOST が別の値ならその値だけ追加", () => {
    const a = dashboardAllowedHosts(8787);
    expect([...a].sort()).toEqual(["127.0.0.1:8787", "[::1]:8787", "localhost:8787"]);
    expect(dashboardAllowedHosts(8787, "127.0.0.1")).toEqual(a);
    expect(dashboardAllowedHosts(8787, "localhost")).toEqual(a);
    expect(dashboardAllowedHosts(8787, "::1")).toEqual(a);
    const lan = dashboardAllowedHosts(8787, "192.168.1.5");
    expect(lan.has("192.168.1.5:8787")).toBe(true);
    expect(lan.size).toBe(4);
    expect(dashboardAllowedHosts(8787, "fe80::1").has("[fe80::1]:8787")).toBe(true);
    // 既定ポート 80 ではポート省略も許可
    expect(dashboardAllowedHosts(80).has("localhost")).toBe(true);
    expect(dashboardAllowedHosts(8787).has("localhost")).toBe(false);
  });

  it("isAllowedHost: 大文字小文字は無視、欠落・別ポート・別名は不許可", () => {
    const a = dashboardAllowedHosts(8787);
    expect(isAllowedHost("LOCALHOST:8787", a)).toBe(true);
    expect(isAllowedHost(" 127.0.0.1:8787 ", a)).toBe(true);
    expect(isAllowedHost(undefined, a)).toBe(false);
    expect(isAllowedHost("", a)).toBe(false);
    expect(isAllowedHost(["127.0.0.1:8787"], a)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", a)).toBe(false);
    expect(isAllowedHost("attacker.example:8787", a)).toBe(false);
    expect(isAllowedHost("localhost.attacker.example:8787", a)).toBe(false);
  });

  it("ハンドラー: 許可外の Host は 403 (本文は返さない)。localPort が分からなければ拒否", async () => {
    const handler = createDashboardHandler(lightDeps());
    const calls: { status: number; body: string }[] = [];
    const res = { writeHead: (s: number) => calls.push({ status: s, body: "" }), end: (b?: string) => (calls[calls.length - 1].body = b ?? "") };
    const req = (host: string | undefined, socket: { localPort?: number } = { localPort: 8787 }) =>
      ({ method: "GET", url: "/api/status", headers: host === undefined ? {} : { host }, socket }) as never;
    await handler(req("evil.example:8787"), res as never);
    await handler(req(undefined), res as never);
    await handler(req("127.0.0.1:8787", {}), res as never);
    await handler(req("localhost:8787"), res as never);
    expect(calls.map((c) => c.status)).toEqual([403, 403, 403, 200]);
    expect(calls[0].body).not.toContain("ok");
  });

  it("startDashboard: 実ポートで Host を検証する (rebinding された Host は 403)", async () => {
    const srv = await startDashboard(lightDeps(), { port: 0 });
    try {
      const addr = srv.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      expect((await getWithHost(port, "/api/status", `127.0.0.1:${port}`)).status).toBe(200);
      expect((await getWithHost(port, "/api/status", `localhost:${port}`)).status).toBe(200);
      const evil = await getWithHost(port, "/api/status", `attacker.example:${port}`);
      expect(evil.status).toBe(403);
      expect(evil.body).not.toContain("ok");
      expect((await getWithHost(port, "/", "127.0.0.1:1")).status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it("500 応答に内部エラーの本文を出さない", async () => {
    const d = lightDeps(() => {
      throw new Error("db at /home/secret/path.sqlite token=abc");
    });
    const r = await routeDashboard(d, "GET", "/api/status");
    expect(r.status).toBe(500);
    expect(r.body).not.toMatch(/secret|token|sqlite/);
    expect(JSON.parse(r.body).error).toBe("内部エラー");
  });
});
