import { describe, expect, it } from "vitest";
import type { IntelItem } from "../src/core/types";
import { newsPendingKey, newsStatsKey, NewsOutcomeTracker, horizonLabel, noiseThreshold, type NewsMarketInfo } from "../src/learning/newsCheck";
import { SourceReliabilityTracker, sourceReliabilityKey } from "../src/learning/reliability";
import { LearningService } from "../src/learning/service";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5, 12);
const MIN = 60_000;
const HOUR = 3_600_000;

const item = (id: string, over: Partial<IntelItem> = {}): IntelItem => ({
  id, source: "rss:test", kind: "news", title: `t ${id}`, publishedAt: T0 - 10 * MIN, fetchedAt: T0, assets: ["BTC"], sentiment: 0.5, ...over,
});

/** BTC/USDT (仲値 100)。ATR 比 0.0005/分、往復コスト 0.1% */
const markets: NewsMarketInfo[] = [
  { instrument: { symbol: "BTC/USDT", baseCurrency: "BTC" }, mid: 100, atrPctPerMin: 0.0005, costPct: 0.001 },
  { instrument: { symbol: "ETH/USDT", baseCurrency: "ETH" }, mid: 50, atrPctPerMin: 0.0005, costPct: 0.001 },
  { instrument: { symbol: "AAPL", baseCurrency: "AAPL" } }, // 価格なし
];

function setup(opts: ConstructorParameters<typeof NewsOutcomeTracker>[2] = {}) {
  const store = new MemoryStore();
  const rel = new SourceReliabilityTracker(store);
  const news = new NewsOutcomeTracker(store, rel, opts);
  return { store, rel, news };
}

/** priceAt: 判定時刻ごとの価格 (未指定は undefined) */
const deps = (prices: Record<string, (ts: number) => number | undefined>, watched = ["BTC/USDT", "ETH/USDT"]) => ({
  isWatched: (s: string) => watched.includes(s),
  midNow: () => undefined,
  priceAt: (s: string, ts: number) => prices[s]?.(ts),
});

describe("ニュースと値動きの答え合わせ (NewsOutcomeTracker)", () => {
  it("対象の絞り込み: sentiment あり・|sentiment| ≥ 0.15・監視銘柄のベース通貨・価格あり・2 時間以内", () => {
    const { news } = setup();
    const added = news.ingest(
      [
        item("ok"),
        item("lower", { assets: ["btc"], sentiment: -0.3 }),
        item("weak", { sentiment: 0.1 }),
        item("none", { sentiment: undefined }),
        item("unwatched", { assets: ["DOGE"] }),
        item("noprice", { assets: ["AAPL"] }),
        item("old", { publishedAt: T0 - 2 * HOUR - 1 }),
        item("multi", { assets: ["BTC", "ETH", "DOGE"] }),
      ],
      markets,
      T0,
    );
    expect(added).toBe(4); // ok, lower, multi×2
    const p = news.listPending();
    expect(p.map((x) => `${x.itemId}:${x.symbol}`)).toEqual(["ok:BTC/USDT", "lower:BTC/USDT", "multi:BTC/USDT", "multi:ETH/USDT"]);
    expect(p[0]).toMatchObject({ source: "rss:test", asset: "BTC", direction: 1, strength: 0.5, ingestedAt: T0, mid0: 100, done: [] });
    expect(p[1].direction).toBe(-1);
  });

  it("同じ id は 1 回だけ", () => {
    const { news } = setup();
    expect(news.ingest([item("a")], markets, T0)).toBe(1);
    expect(news.ingest([item("a"), item("a")], markets, T0 + MIN)).toBe(0);
    expect(news.listPending()).toHaveLength(1);
  });

  it("15 分・1 時間・4 時間で判定し、当たり・外れを 1 記事あたり合計 0.3 (1 判定 0.3 ÷ 3) で情報源の信頼度へ反映する", () => {
    const { news, rel, store } = setup();
    news.ingest([item("a")], markets, T0);
    // 15 分後 +1% (当たり)、1 時間後 −1% (外れ)、4 時間後 +2% (当たり)
    const px = (ts: number) => (ts === T0 + 15 * MIN ? 101 : ts === T0 + HOUR ? 99 : ts === T0 + 4 * HOUR ? 102 : undefined);
    expect(news.evaluate(T0 + 10 * MIN, deps({ "BTC/USDT": px }))).toBe(0); // まだ
    expect(news.evaluate(T0 + 15 * MIN, deps({ "BTC/USDT": px }))).toBe(1);
    let r = rel.get("rss:test")!;
    expect(r).toMatchObject({ n: 0, hits: 0, newsN: 1, newsHits: 1 });
    expect(r.effN).toBeCloseTo(0.1, 10);
    expect(news.evaluate(T0 + HOUR, deps({ "BTC/USDT": px }))).toBe(1);
    expect(news.evaluate(T0 + 4 * HOUR, deps({ "BTC/USDT": px }))).toBe(1);
    r = rel.get("rss:test")!;
    expect(r).toMatchObject({ n: 0, hits: 0, newsN: 3, newsHits: 2 });
    expect(r.effN).toBeCloseTo(0.3, 10);
    expect(news.listPending()).toEqual([]); // 3 つとも判定済み
    expect(store.kvGet(sourceReliabilityKey("paper"))).toEqual(rel.all());
    const sum = news.summary();
    expect(sum.horizons).toEqual(["15m", "1h", "4h"]);
    expect(sum.sources[0]).toMatchObject({ source: "rss:test", n: 3, hits: 2 });
    expect(sum.sources[0].byHorizon["1h"]).toMatchObject({ n: 1, hits: 0 });
    expect(sum.byHorizon.map((h) => [h.horizon, h.n, h.hits])).toEqual([["15m", 1, 1], ["1h", 1, 0], ["4h", 1, 1]]);
  });

  it("ニュース判定 (0.3) はトレード由来の更新 (1) より影響が小さい", () => {
    const store = new MemoryStore();
    const rel = new SourceReliabilityTracker(store);
    expect(rel.opts.newsWeight).toBe(0.3);
    rel.observeNews("news", true, T0);
    rel.observeNews("news", true, T0);
    // トレード 2 件分の的中 (update 経由と同じ observe)
    const trade = (src: string) =>
      ({
        direction: "long", entryPrice: 100, exitPrice: 101, grossPnl: 1, exitTs: T0, assetClass: "crypto", rMultiple: 1,
        entryContext: { intel: { sentiment: 0.5, sourceContrib: { [src]: 0.5 } } },
      }) as never;
    rel.update(trade("trade"));
    rel.update(trade("trade"));
    expect(rel.weight("news")).toBeGreaterThan(1);
    expect(rel.weight("news")).toBeLessThan(rel.weight("trade"));
    // 重みはオプションで変えられる
    const rel2 = new SourceReliabilityTracker(new MemoryStore(), { newsWeight: 0.6 });
    expect(rel2.observeNews("x", false, T0).effN).toBeCloseTo(0.6, 10);
  });

  it("ノイズの範囲内の動きは判定しない (数えない)。範囲 = max(ATR 比 × √分数 × 0.5, 往復コスト比)", () => {
    // 15 分: max(0.0005 × √15 × 0.5 ≒ 0.00097, 0.001) = 0.001 / 4 時間: 0.0005 × √240 × 0.5 ≒ 0.00387
    const p = { atrPctPerMin: 0.0005, costPct: 0.001 };
    expect(noiseThreshold(p, 15 * MIN, 0.5)).toBeCloseTo(0.001, 10);
    expect(noiseThreshold(p, 4 * HOUR, 0.5)).toBeCloseTo(0.0005 * Math.sqrt(240) * 0.5, 10);
    expect(noiseThreshold({ atrPctPerMin: 0, costPct: 0 }, HOUR, 0.5)).toBe(0);

    const { news, rel } = setup();
    news.ingest([item("a")], markets, T0);
    // 15 分 +0.05% (< 0.1%)、1 時間 +0.3% (> 0.0005×√60×0.5 ≒ 0.19%)、4 時間 +0.3% (< 0.387%)
    const px = (ts: number) => (ts === T0 + 15 * MIN ? 100.05 : ts === T0 + HOUR ? 100.3 : 100.3);
    news.evaluate(T0 + 4 * HOUR, deps({ "BTC/USDT": px }));
    const s = news.summary();
    expect(s.sources[0]).toMatchObject({ n: 1, hits: 1, noise: 2 });
    expect(s.byHorizon.map((h) => [h.horizon, h.n, h.noise])).toEqual([["15m", 0, 1], ["1h", 1, 0], ["4h", 0, 1]]);
    expect(rel.get("rss:test")).toMatchObject({ newsN: 1, newsHits: 1 });
  });

  it("価格が取れなければ判定時刻から少しの間は現在の仲値、それより遅れたら期限切れ (数えない)", () => {
    const { news } = setup();
    news.ingest([item("a")], markets, T0);
    const d = { isWatched: () => true, midNow: () => 101 };
    expect(news.evaluate(T0 + 16 * MIN, d)).toBe(1); // 15 分: 1 分遅れ → 現在の仲値
    expect(news.evaluate(T0 + 2 * HOUR, d)).toBe(0); // 1 時間: 1 時間遅れ → 期限切れ
    const s = news.summary();
    expect(s.byHorizon.find((h) => h.horizon === "1h")).toMatchObject({ n: 0, expired: 1 });
  });

  it("判定待ちは最大 500 件 (古い順に捨てる)。監視をやめた銘柄の分は捨てる", () => {
    const { news } = setup();
    expect(news.opts.maxPending).toBe(500);
    for (let i = 0; i < 260; i++) news.ingest([item(`a${i}`, { assets: ["BTC", "ETH"] })], markets, T0 + i);
    expect(news.listPending()).toHaveLength(500);
    expect(news.listPending()[0].ingestedAt).toBe(T0 + 10); // 先頭 20 件 (10 記事分) を捨てた
    expect(news.summary().droppedCap).toBe(20);

    const small = setup({ maxPending: 3 }).news;
    small.ingest([item("x", { assets: ["BTC", "ETH"] }), item("y", { assets: ["BTC", "ETH"] })], markets, T0);
    expect(small.listPending().map((p) => `${p.itemId}:${p.symbol}`)).toEqual(["x:ETH/USDT", "y:BTC/USDT", "y:ETH/USDT"]);
    small.evaluate(T0 + MIN, deps({}, ["BTC/USDT"]));
    expect(small.listPending().map((p) => p.symbol)).toEqual(["BTC/USDT"]);
    expect(small.summary().droppedUnwatched).toBe(2);
  });

  it("kv に保存して再起動後も続ける (判定待ち・集計・既に見た id)", () => {
    const { store, rel, news } = setup();
    news.ingest([item("a")], markets, T0);
    news.evaluate(T0 + 15 * MIN, deps({ "BTC/USDT": () => 101 }));
    expect(store.kvGet<unknown[]>(newsPendingKey("paper"))).toHaveLength(1);
    expect(store.kvGet(newsStatsKey("paper"))).toBeDefined();

    const news2 = new NewsOutcomeTracker(store, rel);
    expect(news2.listPending()).toEqual(news.listPending());
    expect(news2.ingest([item("a")], markets, T0 + 20 * MIN)).toBe(0); // 同じ id は再登録しない
    news2.evaluate(T0 + HOUR, deps({ "BTC/USDT": () => 99 }));
    expect(news2.summary().sources[0]).toMatchObject({ n: 2, hits: 1 });
  });

  it("判定時間はオプションで変えられる。LearningService の snapshot に集計が出る", () => {
    expect(horizonLabel(15 * MIN)).toBe("15m");
    expect(horizonLabel(4 * HOUR)).toBe("4h");
    const store = new MemoryStore();
    const svc = new LearningService({ store, newsCheck: { horizonsMs: [5 * MIN] } });
    svc.news.ingest([item("a")], markets, T0);
    svc.news.evaluate(T0 + 5 * MIN, deps({ "BTC/USDT": () => 98 }));
    const snap = svc.snapshot({ now: T0 + 5 * MIN });
    expect(snap.news.horizons).toEqual(["5m"]);
    expect(snap.news.sources[0]).toMatchObject({ source: "rss:test", n: 1, hits: 0 });
    expect(snap.sources["rss:test"]).toMatchObject({ newsN: 1, newsHits: 0, n: 0 });
    // 情報の効き具合 (intelInfluence) は変えない
    expect(svc.intelInfluence("crypto")).toBe(1);
  });
});
