/** エンジン統合: 見送ったシグナルの仮想トレードと、ニュースと値動きの答え合わせ (合成データ + 仮想時計 + MemoryStore、オフライン) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import type { AssetClass, Clock, IntelItem, Signal, Strategy, StrategyContext } from "../src/core/types";
import { buildRuntime, type RuntimeOptions } from "../src/engine/setup";
import { buildReportText } from "../src/cli";
import { shadowOpenKey } from "../src/learning/shadow";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5);

const mkClock = (t = START): Clock & { t: number } => ({ t, now() { return this.t; } });
const testConfig = (env: Record<string, string> = {}) =>
  // 建値ストップ (BREAKEVEN_TRIGGER_R) は無効にして、仮想トレードの決済理由を従来の範囲 (stop / take_profit / time) に固定する
  loadConfig({ NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY", BREAKEVEN_TRIGGER_R: "0", ...env });

/** 常に同じ方向のシグナルを出すテスト用戦略 (保有中は何もしない) */
function fixedStrategy(id: string, o: { classes?: AssetClass[]; direction?: "long" | "short"; confidence?: number; edge?: number; stopPct?: number; holdMs?: number }): Strategy {
  return {
    id,
    horizon: "scalp",
    assetClasses: o.classes ?? ["crypto"],
    regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m",
    timeframes: ["1m", "1h"],
    warmup: 1,
    defaultParams: { stopAtr: 1 },
    paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const dir = o.direction ?? "long";
      const px = dir === "long" ? ctx.market.quote.ask : ctx.market.quote.bid;
      const stopPct = o.stopPct ?? 0.002;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: dir, confidence: o.confidence ?? 0.8,
        expectedEdgeBps: o.edge ?? 200, entry: { type: "market" }, stopLoss: dir === "long" ? px * (1 - stopPct) : px * (1 + stopPct),
        takeProfit: dir === "long" ? px * (1 + 2 * stopPct) : px * (1 - 2 * stopPct),
        maxHoldMs: o.holdMs ?? 10 * MIN, reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

async function runtime(env: Record<string, string> = {}, opts: RuntimeOptions = {}) {
  const clock = (opts.clock as Clock & { t: number }) ?? mkClock();
  const store = opts.store ?? new MemoryStore();
  const rt = await buildRuntime(testConfig(env), {
    clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7), ...opts,
  });
  return { rt, clock: clock as Clock & { t: number }, store: rt.store as MemoryStore };
}

async function run(rt: Awaited<ReturnType<typeof runtime>>["rt"], clock: Clock & { t: number }, from: number, to: number, stepMs = 15_000) {
  let entries = 0;
  for (let now = from; now <= to; now += stepMs) {
    clock.t = now;
    const r = await rt.engine.tick(now);
    entries += r.entries;
  }
  return entries;
}

/** 発注の記録 (時刻・銘柄・戦略・方向・数量) */
const entryLog = (store: MemoryStore) =>
  store.listAudit({ type: "engine.entry" }).map((a) => JSON.stringify([a.ts, a.data.symbol, a.data.strategyId, a.data.direction, a.data.qty]));

describe("見送ったシグナルの仮想トレード (エンジン統合)", () => {
  it("コスト比で見送ったシグナルから作られ、時間切れ等で閉じて腕を重み付きで更新する (実際の取引は 0)", async () => {
    // 従来の時間切れ (time) を確かめるため読みの管理は無効にする (有効時は tests/thesis.shadow.test.ts)
    const { rt, clock, store } = await runtime({ THESIS_EXIT: "false" }, { strategies: [fixedStrategy("cheap", { edge: 0.5 })] });
    await run(rt, clock, START, START + 5 * MIN);
    const open = rt.engine.shadow!.list();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.reason.startsWith("risk: 期待値幅") && o.strategyId === "cheap")).toBe(true);
    // 同じ (銘柄, 戦略, 方向) は 1 件まで
    expect(new Set(open.map((o) => `${o.symbol}|${o.direction}`)).size).toBe(open.length);
    expect(store.kvGet<unknown[]>(shadowOpenKey("paper"))).toHaveLength(open.length);

    await run(rt, clock, START + 5 * MIN + 15_000, START + 40 * MIN);
    const closed = store.listShadowTrades();
    expect(closed.length).toBeGreaterThan(0);
    for (const t of closed) {
      expect(["stop", "take_profit", "time"]).toContain(t.exitReason);
      expect(t.netR).toBeLessThan(t.grossR); // コストと約定ずれを差し引く
      expect(t.mode).toBe("paper");
    }
    expect(store.listTrades()).toHaveLength(0);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    const arms = rt.learning.allocator.snapshot();
    expect(arms.reduce((s, a) => s + a.n, 0)).toBe(0);
    expect(arms.reduce((s, a) => s + a.shadowN, 0)).toBe(closed.length);
    // 見送りの集計は従来どおり (skip_summary)
    await rt.engine.stop();
    const reasons = store.listAudit({ type: "engine.skip_summary" }).flatMap((a) => Object.keys((a.data as { reasons: object }).reasons));
    expect(reasons.some((k) => k.startsWith("risk: 期待値幅"))).toBe(true);
  }, 60_000);

  it("lower_score・direction 以外の上限 (最大保有数) でも作られる。発注したシグナルは対象外", async () => {
    const { rt, clock } = await runtime({ MAX_OPEN_POSITIONS: "1" }, {
      strategies: [fixedStrategy("best", { confidence: 0.9 }), fixedStrategy("second", { confidence: 0.5 })],
    });
    await run(rt, clock, START, START + 3 * MIN);
    const open = rt.engine.shadow!.list();
    const reasons = new Set(open.map((o) => o.reason));
    expect(reasons.has("lower_score")).toBe(true);
    expect([...reasons].some((r) => r.startsWith("risk: 最大保有数"))).toBe(true);
    // 発注した (建玉になった) シグナルの銘柄・戦略は仮想トレードにしない
    const held = rt.engine.positions.list();
    expect(held.length).toBe(1);
    expect(open.some((o) => o.symbol === held[0].symbol && o.strategyId === held[0].strategyId && o.entryTs === held[0].entryTs)).toBe(false);
  }, 60_000);

  it("実際の発注に影響しない (仮想トレードの有無で発注の記録が同じ)", async () => {
    const strategies = () => [fixedStrategy("best", { confidence: 0.9, holdMs: 60 * MIN }), fixedStrategy("second", { confidence: 0.5, holdMs: 60 * MIN })];
    const a = await runtime({ MAX_OPEN_POSITIONS: "1" }, { strategies: strategies() });
    const b = await runtime({ MAX_OPEN_POSITIONS: "1" }, { strategies: strategies(), engine: { shadow: { enabled: false } } });
    const ea = await run(a.rt, a.clock, START, START + 30 * MIN);
    const eb = await run(b.rt, b.clock, START, START + 30 * MIN);
    expect(a.rt.engine.shadow!.stats().created).toBeGreaterThan(0);
    expect(b.rt.engine.shadow).toBeUndefined();
    expect(ea).toBe(eb);
    expect(entryLog(a.store)).toEqual(entryLog(b.store));
    expect(ea).toBeGreaterThan(0);
  }, 60_000);

  it("仮想トレードの処理で例外が出ても tick は止まらず、発注も変わらない", async () => {
    const strategies = () => [fixedStrategy("best", { confidence: 0.9 }), fixedStrategy("second", { confidence: 0.5 })];
    const a = await runtime({ MAX_OPEN_POSITIONS: "1" }, { strategies: strategies() });
    const b = await runtime({ MAX_OPEN_POSITIONS: "1" }, { strategies: strategies(), engine: { shadow: { enabled: false } } });
    const sh = a.rt.engine.shadow!;
    let calls = 0;
    sh.record = () => { calls++; throw new Error("record boom"); };
    sh.update = () => { throw new Error("update boom"); };
    sh.flush = () => { throw new Error("flush boom"); };
    Object.defineProperty(sh, "size", { get: () => 1 });
    a.rt.learning.news.evaluate = () => { throw new Error("news boom"); };
    const ea = await run(a.rt, a.clock, START, START + 20 * MIN);
    const eb = await run(b.rt, b.clock, START, START + 20 * MIN);
    expect(calls).toBeGreaterThan(0);
    expect(ea).toBe(eb);
    expect(entryLog(a.store)).toEqual(entryLog(b.store));
    expect(a.store.listEquity().length).toBe(b.store.listEquity().length);
  }, 60_000);

  it("再起動後も続く (未決済を kv から復元し、決済まで判定する)", async () => {
    const store = new MemoryStore();
    const s1 = await runtime({}, { store, strategies: [fixedStrategy("cheap", { edge: 0.5, holdMs: 20 * MIN })] });
    await run(s1.rt, s1.clock, START, START + 3 * MIN);
    const before = s1.rt.engine.shadow!.list();
    expect(before.length).toBeGreaterThan(0);
    await s1.rt.engine.stop();

    // 同じ store で作り直す (戦略は何も出さない)
    const clock = mkClock(START + 3 * MIN + 15_000);
    const s2 = await runtime({}, { store, clock, strategies: [{ ...fixedStrategy("cheap", {}), evaluate: () => null }] });
    expect(s2.rt.engine.shadow!.list().map((o) => o.id).sort()).toEqual(before.map((o) => o.id).sort());
    await run(s2.rt, clock, clock.t, START + 30 * MIN);
    expect(s2.rt.engine.shadow!.size).toBe(0);
    const ids = new Set(store.listShadowTrades().map((t) => t.id));
    for (const o of before) expect(ids.has(o.id)).toBe(true);
  }, 60_000);

  it("新規停止中 (キルスイッチ) も戦略を評価し、シグナルは halted の仮想トレードとして記録する", async () => {
    const { rt, clock, store } = await runtime({}, { strategies: [fixedStrategy("a", {})] });
    rt.risk.trip("テスト停止", START);
    await run(rt, clock, START, START + 3 * MIN);
    expect(store.listAudit({ type: "engine.entry" })).toHaveLength(0);
    const open = rt.engine.shadow!.list();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.reason === "halted")).toBe(true);
  }, 60_000);

  it("監視をやめた銘柄の仮想トレードは捨てる", async () => {
    const { rt, clock } = await runtime({}, { strategies: [fixedStrategy("cheap", { edge: 0.5, holdMs: 60 * MIN })] });
    await run(rt, clock, START, START + 2 * MIN);
    const sym = rt.engine.shadow!.list()[0].symbol;
    (rt.hub as unknown as { symbols: Map<string, unknown> }).symbols.delete(sym);
    await run(rt, clock, START + 2 * MIN + 15_000, START + 3 * MIN);
    expect(rt.engine.shadow!.list().some((o) => o.symbol === sym)).toBe(false);
    expect(rt.engine.shadow!.stats().unwatched).toBeGreaterThan(0);
  }, 60_000);

  it("report と /api/learning 用の snapshot に集計が出る", async () => {
    const { rt, clock, store } = await runtime({}, { strategies: [fixedStrategy("cheap", { edge: 0.5 })] });
    await run(rt, clock, START, START + 30 * MIN);
    const snap = rt.learning.snapshot({ now: clock.t });
    expect(snap.shadow.closed).toBeGreaterThan(0);
    expect(snap.shadow.byReason[0].key).toMatch(/^risk: 期待値幅/);
    expect(snap.shadow.byStrategy[0]).toMatchObject({ key: "cheap" });
    expect(snap.arms.some((a) => a.shadowN > 0)).toBe(true);
    const text = buildReportText(testConfig(), store, clock.t);
    expect(text).toContain("■ 見送ったシグナルの答え合わせ (仮想トレード)");
    expect(text).toContain("見送り理由");
    expect(text).toContain("平均純R");
    expect(text).toContain("■ ニュースと値動きの答え合わせ");
    expect(text).toMatch(/腕\s+件数\s+仮想/);
  }, 60_000);
});

describe("ニュースと値動きの答え合わせ (エンジン統合)", () => {
  it("情報ループで取り込み、15 分・1 時間・4 時間後に判定する (同じ id は 1 回だけ)", async () => {
    let n = 0;
    const source = {
      id: "test-news",
      async fetch(now: number): Promise<IntelItem[]> {
        n++;
        return [
          { id: "btc-1", source: "rss:test", kind: "news", title: "Bitcoin surges", publishedAt: now - MIN, fetchedAt: now, assets: ["BTC"], sentiment: 0.6 },
          { id: "old-1", source: "rss:test", kind: "news", title: "old", publishedAt: now - 3 * HOUR, fetchedAt: now, assets: ["BTC"], sentiment: 0.6 },
          { id: "weak-1", source: "rss:test", kind: "news", title: "meh", publishedAt: now - MIN, fetchedAt: now, assets: ["ETH"], sentiment: 0.05 },
        ];
      },
    };
    const { rt, clock } = await runtime({}, { intelSources: [source], strategies: [fixedStrategy("noop", { classes: ["meme"] })] });
    await rt.engine.tick(START);
    await rt.engine.runIntel(START);
    expect(rt.learning.news.listPending().map((p) => `${p.itemId}:${p.symbol}`)).toEqual(["btc-1:BTC/USDT"]);
    expect(rt.learning.news.listPending()[0].atrPctPerMin).toBeGreaterThan(0);
    expect(rt.learning.news.listPending()[0].costPct).toBeGreaterThan(0);
    await run(rt, clock, START + MIN, START + 4 * HOUR + 2 * MIN, 60_000);
    await rt.engine.runIntel(clock.t); // 同じ id は再登録しない
    expect(n).toBe(2);
    expect(rt.learning.news.listPending().map((p) => p.itemId)).not.toContain("btc-1");
    const s = rt.learning.news.summary();
    const src = s.sources.find((x) => x.source === "rss:test")!;
    expect(src.n + src.noise + src.expired).toBe(3);
    expect(src.expired).toBe(0); // 1m 足の履歴で判定時刻の価格が取れる
    expect(s.recorded).toBe(1);
    const rel = rt.learning.sourceReliability()["rss:test"];
    if (src.n > 0) expect(rel).toMatchObject({ n: 0, newsN: src.n, newsHits: src.hits });
  }, 60_000);
});
