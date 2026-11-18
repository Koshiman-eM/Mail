import { describe, expect, it } from "vitest";
import { analyzeIntel } from "../src/intel/analyzer";
import { IntelService, RELIABILITY_KV_KEY } from "../src/intel/service";
import type { IntelSource } from "../src/intel/sources/common";
import type { EconEvent, IntelItem, Lesson, MarketBrief, SourceReliability, Store } from "../src/core/types";

const NOW = 1_800_000_000_000;
const item = (id: string, title: string, over: Partial<IntelItem> = {}): IntelItem => ({
  id, source: "rss:a", kind: "news", title, publishedAt: NOW - 60_000, fetchedAt: NOW, assets: ["BTC", "CRYPTO"], ...over,
});

/** 必要最小限のフェイク Store (intel 関連のみ) */
function fakeStore() {
  const intel = new Map<string, IntelItem>();
  const kv = new Map<string, unknown>();
  const briefs: MarketBrief[] = [];
  const lessons: Lesson[] = [];
  const store = {
    saveIntel: (items: IntelItem[]) => {
      let n = 0;
      for (const i of items) if (!intel.has(i.id)) (intel.set(i.id, i), n++);
      return n;
    },
    listIntel: (o?: { since?: number }) => [...intel.values()].filter((i) => !o?.since || i.publishedAt >= o.since),
    getIntel: (ids: string[]) => ids.map((i) => intel.get(i)!).filter(Boolean),
    saveBrief: (b: MarketBrief) => void briefs.push(b),
    latestBrief: () => briefs.at(-1),
    listLessons: () => lessons,
    kvGet: <T,>(k: string) => kv.get(k) as T | undefined,
    kvSet: <T,>(k: string, v: T) => void kv.set(k, v),
  } as unknown as Store;
  return { store, intel, kv, briefs };
}

describe("analyzeIntel (AI 無効)", () => {
  it("キー無しはフォールバック (stub: true) でバイアスを作る", async () => {
    const items = [
      item("1", "Bitcoin surges to record high"),
      item("2", "Bitcoin surges to record high"), // タイトル重複は除去
      item("3", "Exchange hacked, funds drained", { assets: ["ETH", "CRYPTO"] }),
      item("4", "ビットコインが上昇", { publishedAt: NOW - 1000 }),
    ];
    const brief = await analyzeIntel(items, { now: NOW, reliability: {}, lessons: [], events: [] });
    expect(brief.stub).toBe(true);
    expect(brief.biases.BTC.sentiment).toBeGreaterThan(0);
    expect(brief.biases.BTC.sourceIds).toHaveLength(2);
    expect(brief.biases.ETH.sentiment).toBeLessThan(0);
    expect(brief.riskOn).toBeGreaterThanOrEqual(-1);
    expect(brief.riskOn).toBeLessThanOrEqual(1);
    expect(brief.summary).toMatch(/ルールベース/);
  });
  it("ai に空キーを渡してもフォールバック。信頼度 weight が反映される", async () => {
    const items = [item("1", "Bitcoin surges to record high")];
    const mk = (w: number): Record<string, SourceReliability> => ({ "rss:a": { source: "rss:a", n: 9, hits: 5, ewmaScore: 0, weight: w, updatedAt: NOW } });
    const hi = await analyzeIntel(items, { now: NOW, reliability: mk(2), lessons: [], events: [], ai: { apiKey: "", model: "m" } });
    const lo = await analyzeIntel(items, { now: NOW, reliability: mk(0.2), lessons: [], events: [] });
    expect(hi.stub).toBe(true);
    expect(hi.biases.BTC.sentiment).toBeGreaterThan(lo.biases.BTC.sentiment);
  });
  it("ミーム監視候補はラグプル危険の低い DEX 銘柄のみ", async () => {
    const dex = (id: string, sym: string, rug: number): IntelItem => ({
      id, source: "dexscreener", kind: "trending", title: sym, publishedAt: NOW, fetchedAt: NOW, assets: [sym, "MEME"],
      sentiment: 0.3, importance: 0.8 - rug * 0.5, metrics: { rugRisk: rug },
    });
    const brief = await analyzeIntel([dex("d1", "GOOD", 0.1), dex("d2", "RUGGY", 0.9)], { now: NOW, reliability: {}, lessons: [], events: [] });
    expect(brief.watchlist).toEqual(["GOOD"]);
  });
});

describe("IntelService", () => {
  const ok = (id: string, items: IntelItem[], events?: EconEvent[]): IntelSource => ({
    id, fetch: async () => items, ...(events ? { events: () => events } : {}),
  });
  const bad = (id: string): IntelSource => ({ id, fetch: async () => { throw new Error("boom"); } });

  it("一部情報源が失敗しても全体は継続し、保存・ブリーフ生成する", async () => {
    const { store, intel, briefs } = fakeStore();
    const ev: EconEvent[] = [{ ts: NOW + 10 * 60_000, title: "NFP", currency: "USD", impact: "high", source: "calendar:ff" }];
    const svc = new IntelService({
      store,
      sources: [
        ok("s1", [item("1", "Bitcoin rally continues"), item("dup", "Dup")]),
        bad("s2"),
        ok("s3", [item("dup", "Dup"), item("3", "ETF approval boosts ether", { assets: ["ETH", "CRYPTO"] })]),
        ok("cal", [], ev),
      ],
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const brief = await svc.refresh(NOW);
    expect(intel.size).toBe(3);
    expect(briefs).toHaveLength(1);
    expect(svc.latestBrief()).toBe(brief);
    expect(brief.biases.BTC.sentiment).toBeGreaterThan(0);
    expect(brief.biases.USD.blackoutUntil).toBe(ev[0].ts + 15 * 60_000);
    expect(svc.latestEvents()).toEqual(ev);
  });
  it("全情報源が失敗しても例外にならず、蓄積済み項目で再計算。失敗時はイベントを保持", async () => {
    const { store, kv } = fakeStore();
    const events: EconEvent[] = [{ ts: NOW + 3_600_000, title: "CPI", currency: "USD", impact: "high", source: "c" }];
    let fail = false;
    const flaky: IntelSource = {
      id: "flaky",
      fetch: async () => {
        if (fail) throw new Error("down");
        return [item("1", "Bitcoin surges")];
      },
      events: () => events,
    };
    const svc = new IntelService({ store, sources: [flaky], logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await svc.refresh(NOW);
    fail = true;
    const b = await svc.refresh(NOW + 1000);
    expect(b.biases.BTC).toBeDefined();
    expect(svc.latestEvents()).toEqual(events);
    expect(kv.get("intel:events")).toEqual(events);
  });
  it("store の信頼度 KV を分析に反映する", async () => {
    const run = async (w: number) => {
      const { store, kv } = fakeStore();
      kv.set(RELIABILITY_KV_KEY, { "rss:a": { source: "rss:a", n: 1, hits: 1, ewmaScore: 0, weight: w, updatedAt: NOW } });
      const svc = new IntelService({ store, sources: [ok("s", [item("1", "Bitcoin surges to record high")])] });
      return (await svc.refresh(NOW)).biases.BTC.sentiment;
    };
    expect(await run(2)).toBeGreaterThan(await run(0.3));
  });
});
