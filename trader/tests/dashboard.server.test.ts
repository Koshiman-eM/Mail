import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import type { Signal, Strategy, StrategyContext } from "../src/core/types";
import { createDashboardHandler, parseLimit, routeDashboard, startDashboard, type DashboardDeps } from "../src/dashboard/server";
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
    await handler({ method: "GET", url: "/api/status" } as never, res as never);
    expect(status).toBe(200);
    expect(headers["content-type"]).toMatch(/json/);
    expect(JSON.parse(body).mode).toBe("paper");
    await handler({ method: "HEAD", url: "/" } as never, res as never);
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
