import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import type { IntelItem, Signal, Strategy, StrategyContext } from "../src/core/types";
import {
  createDashboardHandler, dashboardAllowedHosts, isAllowedHost, parseLimit, routeDashboard, startDashboard, type DashboardDeps,
} from "../src/dashboard/server";
import { briefHeadlines } from "../src/engine/engine";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import type { LearningService } from "../src/learning/service";
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

/** テスト用の情報 (合成データ) */
const intel = (i: number, over: Partial<IntelItem> = {}): IntelItem => ({
  id: `n${i}`, source: "rss:test", kind: "news", title: `Bitcoin rally extends ${i}`, publishedAt: START - (i + 1) * 60_000, fetchedAt: START, assets: ["BTC"], ...over,
});

async function deps(items: IntelItem[] = []): Promise<DashboardDeps> {
  const clock = { t: START, now() { return this.t; } };
  const store = new MemoryStore();
  if (items.length) store.saveIntel(items);
  const rt = await buildRuntime(loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory" }), {
    clock, store, intelSources: [], ai: null, seed: 2, syntheticHistoryMs: 86_400_000, strategies: [flipper], rng: mulberry32(1),
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
    chartTimeframes: () => rt.hub.timeframes(),
    candles: (s, tf, n) => ((rt.hub.timeframes() as string[]).includes(tf) ? rt.hub.chartCandles(s, tf as never, n) : undefined),
  };
}

describe("ダッシュボード (listen せずにハンドラーを呼ぶ)", () => {
  it("GET /api/events: ライブ用の記録は許可した種類・項目だけを新しい順に返し、文字列は伏せ字にする", async () => {
    const store = new MemoryStore();
    store.audit({ ts: 1000, type: "engine.entry", data: { symbol: "BTC/JPY", strategyId: "scalp_obi", price: 100, secretThing: "x", clientId: "c1" } });
    store.audit({ ts: 2000, type: "engine.order_error", data: { symbol: "BTC/JPY", reason: "HTTP 400 https://api.example.com/v1?apikey=abcdef123456 signature=deadbeef" } });
    store.audit({ ts: 3000, type: "market", data: { foo: 1 } });
    const d = { status: () => ({}), store, learning: { snapshot: () => ({}) } } as unknown as DashboardDeps;
    const r = JSON.parse((await routeDashboard(d, "GET", "/api/events?limit=10")).body);
    expect(r.events.map((e: { type: string }) => e.type)).toEqual(["engine.order_error", "engine.entry"]);
    expect(r.events[1].data).toEqual({ symbol: "BTC/JPY", strategyId: "scalp_obi", price: 100 });
    expect(r.events[0].kind).toBe("order");
    expect(r.events[0].data.reason).not.toMatch(/abcdef123456|deadbeef/);
    const later = JSON.parse((await routeDashboard(d, "GET", "/api/events?since=1000")).body);
    expect(later.events.map((e: { ts: number }) => e.ts)).toEqual([2000]);
  });

  it("GET /api/candles: 監視銘柄のローソク足を時間足ごとに返し、監視外の銘柄・時間足は 404", async () => {
    const d = await deps();
    const r = await routeDashboard(d, "GET", "/api/candles?symbol=" + encodeURIComponent("BTC/USDT") + "&tf=1m&limit=30");
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.timeframes).toContain("1m");
    expect(body.candles.length).toBeGreaterThan(0);
    expect(body.candles.length).toBeLessThanOrEqual(30);
    const c = body.candles.at(-1);
    expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    expect(body.candles.every((x: { ts: number }, i: number, a: { ts: number }[]) => i === 0 || a[i - 1].ts < x.ts)).toBe(true);
    // 既定の時間足は最も短いもの
    const def = JSON.parse((await routeDashboard(d, "GET", "/api/candles?symbol=" + encodeURIComponent("BTC/USDT"))).body);
    expect(def.tf).toBe(body.timeframes[0]);
    expect((await routeDashboard(d, "GET", "/api/candles?symbol=NOPE&tf=1m")).status).toBe(404);
    expect((await routeDashboard(d, "GET", "/api/candles?symbol=" + encodeURIComponent("BTC/USDT") + "&tf=3w")).status).toBe(404);
  });

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
    expect(s.brief.itemCount).toBe(0);
    expect(s.brief.items).toEqual([]);
    expect(Array.isArray(s.equityHistory)).toBe(true);
    // 監視銘柄の現在値 (気配の仲値)
    for (const w of s.watched) expect(w.lastPrice).toBeGreaterThan(0);
  });

  it("GET /api/status: ブリーフに直近の情報の件数・強気弱気の内訳・見出し (最大 30 件・伏せ字・100 文字まで)", async () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) => intel(i)),
      intel(100, { title: "Leaked url https://api.example.com/v1?apikey=abcdef1234567890 crash", publishedAt: START - 1000, sentiment: -0.6 }),
      intel(101, { title: "x".repeat(300), publishedAt: START - 2000 }),
      intel(102, { kind: "metric", source: "fng:test", title: "Fear & Greed 70", publishedAt: START - 3000 }),
      intel(103, { title: "old news", publishedAt: START - 30 * 3_600_000 }), // 集計期間 (24 時間) の外
    ];
    const d = await deps(items);
    const s = JSON.parse((await routeDashboard(d, "GET", "/api/status")).body);
    expect(s.brief.itemCount).toBe(43);
    expect(s.brief.itemTone.bull + s.brief.itemTone.bear + s.brief.itemTone.neutral).toBe(43);
    expect(s.brief.itemTone.bear).toBeGreaterThanOrEqual(1);
    expect(s.brief.items).toHaveLength(30);
    // 新しい順
    expect(s.brief.items[0].title).toMatch(/^Leaked url/);
    expect(s.brief.items[0].title).not.toContain("abcdef1234567890");
    expect(s.brief.items[0].sentiment).toBe(-0.6);
    expect(s.brief.items[1].title.length).toBeLessThanOrEqual(100);
    expect(s.brief.items[1].title.endsWith("…")).toBe(true);
    // 指標は本文の感情を持たない
    expect(s.brief.items[2]).toEqual({ title: "Fear & Greed 70", source: "fng:test" });
    expect(s.brief.items.some((x: { title: string }) => x.title === "old news")).toBe(false);
  });

  it("briefHeadlines: 件数・内訳・見出しの切り詰め (純粋関数)", () => {
    const h = briefHeadlines([intel(1, { sentiment: 0.5 }), intel(2, { sentiment: -0.5 }), intel(3, { sentiment: 0 }), intel(4, { title: "🚀".repeat(150), sentiment: 0.2 })], { limit: 2, maxLen: 10 });
    expect(h.itemCount).toBe(4);
    expect(h.itemTone).toEqual({ bull: 2, bear: 1, neutral: 1 });
    expect(h.items.map((x) => x.sentiment)).toEqual([0.5, -0.5]);
    const long = briefHeadlines([intel(4, { title: "🚀".repeat(150) })], { maxLen: 10 }).items[0].title;
    expect(Array.from(long)).toHaveLength(10);
    expect(long.endsWith("…")).toBe(true);
    expect(briefHeadlines([]).items).toEqual([]);
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
    // 見送ったシグナルの答え合わせ・ニュースと値動きの答え合わせ・腕の仮想件数
    expect(l.shadow).toMatchObject({ closed: expect.any(Number), open: expect.any(Number), byReason: expect.any(Array), byStrategy: expect.any(Array) });
    expect(l.shadow.counters).toHaveProperty("created");
    expect(l.news).toMatchObject({ pending: 0, horizons: ["15m", "1h", "4h"], sources: [], byHorizon: expect.any(Array) });
    expect(l.arms[0]).toHaveProperty("shadowN");
  });

  it("GET /api/learning: 仮想トレードとニュース判定の集計を返す", async () => {
    const d = await deps();
    const svc = d.learning as LearningService;
    const base = { mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", horizon: "scalp", regime: "range", direction: "long", confidence: 0.5,
      expectedEdgeBps: 10, entryTs: START, entryPrice: 100.1, entryMid: 100, entrySpread: 0.2, stopLoss: 98, maxHoldMs: 600_000, takerFeeRate: 0.001,
      slippageBps: 2, exitTs: START + MIN, exitPrice: 104, exitReason: "take_profit", grossR: 2, costR: 0.2, mfeR: 2, maeR: 0 } as const;
    svc.onShadowClosed({ ...base, id: "s1", strategyId: "a", reason: "direction_bias", netR: 1.8 });
    svc.onShadowClosed({ ...base, id: "s2", strategyId: "a", reason: "direction_bias", netR: -1.2, exitReason: "stop" });
    svc.news.ingest([{ id: "n1", source: "rss:x", kind: "news", title: "t", publishedAt: START, fetchedAt: START, assets: ["BTC"], sentiment: 0.5 }],
      [{ instrument: { symbol: "BTC/USDT", baseCurrency: "BTC" }, mid: 100, costPct: 0.001 }], START);
    svc.news.evaluate(START + 15 * MIN, { isWatched: () => true, midNow: () => 101 });
    const l = JSON.parse((await routeDashboard(d, "GET", "/api/learning")).body);
    expect(l.shadow.byReason[0]).toMatchObject({ key: "direction_bias", n: 2, wins: 1 });
    expect(l.shadow.byStrategy[0]).toMatchObject({ key: "a", n: 2 });
    expect(l.news.sources[0]).toMatchObject({ source: "rss:x", n: 1, hits: 1 });
    expect(l.news.byHorizon[0]).toMatchObject({ horizon: "15m", n: 1, hits: 1 });
    expect(l.sources["rss:x"]).toMatchObject({ newsN: 1, newsHits: 1 });
  });

  it("GET /: 単一 HTML (日本語・自動更新・暗いテーマ・スマホ幅・外部 CDN なし)", async () => {
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
    // 学習タブ: 見送ったシグナルの答え合わせ・ニュースと値動きの答え合わせ (表はパネル内でスクロール)
    expect(html).toContain("SHADOW · SKIPPED SIGNALS");
    expect(html).toContain("見送ったシグナルの答え合わせ");
    expect(html).toContain("NEWS · PRICE CHECK");
    expect(html).toContain("ニュースと値動きの答え合わせ");
    expect(html).toMatch(/BY REASON[\s\S]*'<div class="scroll">'/);
    expect(html).toContain("仮想平均R");
    expect(html).toContain("setInterval(refresh, 5000)");
    expect(html).toContain('name="color-scheme" content="dark"');
    // ボードタブ (コックピット風の一覧)
    expect(html).toContain("TRADER <i>//</i> AUTO");
    for (const s of ["SIGNAL STACK", "ENGINE LOG", "STRATEGY × REGIME", "ALLOCATION", "THIS RUN", "RISK BUDGET", "TRADES · BY STRATEGY"]) expect(html).toContain(s);
    expect(html).toContain('data-tab="board"');
    expect(html).toContain('<canvas id="cloud"');
    // 負荷への配慮: 隠れているとき・別タブでは止める / 動きを控える設定 / 解像度は 2 倍まで
    expect(html).toContain("document.hidden");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain("Math.min(2, window.devicePixelRatio || 1)");
    // 文字列は esc() を通す (innerHTML へ生の API 値を入れない)
    expect(html).toContain("function esc(s)");
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
