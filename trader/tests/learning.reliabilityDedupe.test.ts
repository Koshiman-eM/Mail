/**
 * 情報源の信頼度の細部 (round 3):
 * 1. 同じ記事群による多重カウントの防止 (トレード: (情報源, 記事 id) 単位で 1 記事 1 回 / ニュース: 1 記事あたり合計 0.3)
 * 2. 初回観測の初期化 (事前 0、序盤は w / effN の係数 = 重み付き平均)
 * 5. エグジット後の値動きの補完で差分だけ反映
 * 7. 未来時刻の記事 (rss で丸め、aggregate でも防御)
 */
import { describe, expect, it } from "vitest";
import type { IntelBias, IntelItem, SourceReliability, TradeRecord } from "../src/core/types";
import { buildBiases, effectivePublishedAt } from "../src/intel/aggregate";
import { normalizePublishedAt, parseFeed } from "../src/intel/sources/rss";
import { NewsOutcomeTracker, newsPendingKey, type NewsMarketInfo } from "../src/learning/newsCheck";
import {
  SourceReliabilityTracker, sourceAppliedKey, sourceCreditsKey, sourceReliabilityKey,
} from "../src/learning/reliability";
import { LearningService } from "../src/learning/service";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5, 12);
const MIN = 60_000;
const HOUR = 3_600_000;

const intelItem = (id: string, source: string, over: Partial<IntelItem> = {}): IntelItem => ({
  id, source, kind: "news", title: id, publishedAt: T0 - 30 * MIN, fetchedAt: T0 - 29 * MIN, assets: ["BTC"], sentiment: 0.6, importance: 0.8, ...over,
});

let seq = 0;
function trade(o: { move: number; contrib: Record<string, number>; ids?: string[]; postExit?: number; entryTs?: number; id?: string }): TradeRecord {
  seq++;
  const exitPrice = 100 * (1 + o.move);
  const intel: IntelBias = { asset: "BTC", sentiment: 0.5, confidence: 0.6, eventRisk: 0, sourceIds: o.ids ?? [], sourceContrib: o.contrib };
  const entryTs = o.entryTs ?? T0 + seq * MIN;
  return {
    id: o.id ?? `d${seq}`, mode: "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s1", horizon: "short", direction: "long",
    qty: 1, entryTs, entryPrice: 100, intendedEntryPrice: 100, exitTs: entryTs + 10 * MIN, exitPrice, intendedExitPrice: exitPrice, initialStop: 98,
    grossPnl: exitPrice - 100, fees: 0, netPnl: exitPrice - 100, returnPct: (exitPrice - 100) / 100, rMultiple: (exitPrice - 100) / 2, mfePct: 0.01, maePct: 0.01,
    exitReason: "signal",
    ...(o.postExit !== undefined ? { postExitMovePct: o.postExit } : {}),
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      intel, confidence: 0.5, expectedEdgeBps: 30, costBps: 5, params: {}, features: {}, riskMultiplier: 1, reason: "t",
    },
  };
}

describe("1. 同じ記事群による多重カウントの防止 (トレード)", () => {
  it("同じ記事を根拠にした取引が続いても、記事 1 本あたりの合計の重みは 1 (2 件目以降は更新しない)", () => {
    const store = new MemoryStore();
    store.saveIntel([intelItem("a1", "rss:a"), intelItem("b1", "rss:b")]);
    const tr = new SourceReliabilityTracker(store);
    // 同じ 2 本の記事 (a1: rss:a / b1: rss:b) を根拠に 5 回取引 → 情報源ごとに 1 回分だけ
    for (let i = 0; i < 5; i++) tr.update(trade({ move: 0.01, contrib: { "rss:a": 0.5, "rss:b": -0.4 }, ids: ["a1", "b1"] }));
    expect(tr.get("rss:a")).toMatchObject({ n: 1, hits: 1 });
    expect(tr.get("rss:a")!.effN).toBeCloseTo(1, 10);
    expect(tr.get("rss:b")).toMatchObject({ n: 1, hits: 0 });
    expect(store.kvGet(sourceCreditsKey("paper"))).toMatchObject({ "rss:a": { a1: expect.any(Number) }, "rss:b": { b1: expect.any(Number) } });

    // 新しい記事 a2 が加わった取引: rss:a は a2 の質量の割合だけ、rss:b は新しい記事が無いので更新しない
    store.saveIntel([intelItem("a2", "rss:a", { publishedAt: T0 - 30 * MIN })]);
    const before = tr.get("rss:a")!.effN!;
    tr.update(trade({ move: 0.01, contrib: { "rss:a": 0.5, "rss:b": -0.4 }, ids: ["a1", "a2", "b1"], entryTs: T0 - 30 * MIN }));
    expect(tr.get("rss:a")!.effN! - before).toBeCloseTo(0.5, 6); // 同じ公開時刻・重要度の 2 本のうち 1 本が新しい
    expect(tr.get("rss:b")!.n).toBe(1);
  });

  it("記事が引けないとき (保存されていない) は sourceIds を記事として扱う。sourceIds が空の古いトレードは従来どおり 1", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    tr.update(trade({ move: 0.01, contrib: { x: 0.5 }, ids: ["u1", "u2"] }));
    tr.update(trade({ move: 0.01, contrib: { x: 0.5 }, ids: ["u1", "u2"] }));
    expect(tr.get("x")!.n).toBe(1);
    tr.update(trade({ move: 0.01, contrib: { x: 0.5 }, ids: ["u1", "u2", "u3", "u4"] }));
    expect(tr.get("x")!.effN).toBeCloseTo(1.5, 10);
    // 古いトレード (sourceIds なし) は毎回 1
    tr.update(trade({ move: 0.01, contrib: { y: 0.5 } }));
    tr.update(trade({ move: 0.01, contrib: { y: 0.5 } }));
    expect(tr.get("y")).toMatchObject({ n: 2, effN: 2 });
    // dedupeArticles=false なら従来どおり
    const tr2 = new SourceReliabilityTracker(new MemoryStore(), { dedupeArticles: false });
    for (let i = 0; i < 3; i++) tr2.update(trade({ move: 0.01, contrib: { x: 0.5 }, ids: ["u1"] }));
    expect(tr2.get("x")!.n).toBe(3);
  });

  it("旧方式との比較: 24 時間に同じ記事で 10 回取引すると、旧方式は 10 件分、新方式は 1 件分", () => {
    const store = new MemoryStore();
    store.saveIntel([intelItem("a1", "rss:a")]);
    const tr = new SourceReliabilityTracker(store);
    const old = new SourceReliabilityTracker(new MemoryStore(), { dedupeArticles: false });
    for (let i = 0; i < 10; i++) {
      tr.update(trade({ move: 0.01, contrib: { "rss:a": 0.5 }, ids: ["a1"] }));
      old.update(trade({ move: 0.01, contrib: { "rss:a": 0.5 }, ids: ["a1"] }));
    }
    expect(old.get("rss:a")!.effN).toBe(10);
    expect(tr.get("rss:a")!.effN).toBe(1);
    expect(tr.weight("rss:a")).toBeLessThan(old.weight("rss:a"));
  });
});

describe("1. ニュースの答え合わせ: 1 記事あたりの合計の重みは 0.3", () => {
  const markets: NewsMarketInfo[] = [
    { instrument: { symbol: "BTC/USDT", baseCurrency: "BTC" }, mid: 100, atrPctPerMin: 0.0001, costPct: 0.0001 },
    { instrument: { symbol: "ETH/USDT", baseCurrency: "ETH" }, mid: 50, atrPctPerMin: 0.0001, costPct: 0.0001 },
    { instrument: { symbol: "SOL/USDT", baseCurrency: "SOL" }, mid: 20, atrPctPerMin: 0.0001, costPct: 0.0001 },
  ];
  const up = (base: number) => (_s: string, _ts: number) => base * 1.02;
  const deps = { isWatched: () => true, midNow: () => undefined, priceAt: (s: string, ts: number) => up(s.startsWith("BTC") ? 100 : s.startsWith("ETH") ? 50 : 20)(s, ts) };

  it("3 つの時間 × 3 資産 = 9 判定でも合計 0.3 (旧方式は 2.7)", () => {
    const store = new MemoryStore();
    const rel = new SourceReliabilityTracker(store);
    const news = new NewsOutcomeTracker(store, rel);
    news.ingest([intelItem("n1", "rss:n", { assets: ["BTC", "ETH", "SOL"], publishedAt: T0 - MIN })], markets, T0);
    expect(news.listPending().map((p) => p.share)).toEqual([1 / 9, 1 / 9, 1 / 9]);
    expect(news.evaluate(T0 + 4 * HOUR, deps)).toBe(9);
    const r = rel.get("rss:n")!;
    expect(r).toMatchObject({ newsN: 9, newsHits: 9, n: 0 });
    expect(r.effN).toBeCloseTo(0.3, 10);
  });

  it("保存済みの判定待ち (share なし) は同じ記事 id の件数から割合を補う", () => {
    const store = new MemoryStore();
    const legacy = ["BTC/USDT", "ETH/USDT"].map((symbol) => ({
      itemId: "old", source: "rss:o", asset: symbol.split("/")[0], symbol, direction: 1, strength: 0.6, ingestedAt: T0, publishedAt: T0 - MIN,
      mid0: symbol.startsWith("BTC") ? 100 : 50, atrPctPerMin: 0.0001, costPct: 0.0001, done: [],
    }));
    store.kvSet(newsPendingKey("paper"), legacy);
    const rel = new SourceReliabilityTracker(store);
    const news = new NewsOutcomeTracker(store, rel);
    expect(news.listPending().map((p) => p.share)).toEqual([1 / 6, 1 / 6]);
    news.evaluate(T0 + 4 * HOUR, deps);
    expect(rel.get("rss:o")!.effN).toBeCloseTo(0.3, 10);
  });
});

describe("2. 初回観測の初期化 (事前 0、序盤は重み付き平均)", () => {
  it("重み 0.3 の外れ 1 件のあと重み 1 の当たり 3 件: 重み付き平均 (−0.3 + 3) / 3.3 になる (旧方式は −1 から α=0.1 でしか戻らない)", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    tr.observeNews("s", false, T0);
    expect(tr.get("s")!.ewmaScore).toBeCloseTo(-1, 10);
    expect(tr.weight("s")).toBeCloseTo(1 - 0.3 / 5.3, 10); // 縮小推定で 1 に寄せる
    for (let i = 0; i < 3; i++) tr.update(trade({ move: 0.01, contrib: { s: 0.5 } }));
    expect(tr.get("s")!.ewmaScore).toBeCloseTo(2.7 / 3.3, 10);
    expect(tr.weight("s")).toBeGreaterThan(1);
    // 旧方式なら −1 → (1 − 0.1)^3 で戻るだけ: −1 + 2 × (1 − 0.9^3) ≒ −0.458
    // 順番を入れ替えても (当たり 3 件のあとに外れ 1 件) 同じ値
    const tr2 = new SourceReliabilityTracker(new MemoryStore());
    for (let i = 0; i < 3; i++) tr2.update(trade({ move: 0.01, contrib: { s: 0.5 } }));
    tr2.observeNews("s", false, T0);
    expect(tr2.get("s")!.ewmaScore).toBeCloseTo(2.7 / 3.3, 10);
  });

  it("effN が 1/ewmaAlpha を超えたら指数加重 (係数 ewmaAlpha × w)", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    for (let i = 0; i < 20; i++) tr.update(trade({ move: 0.01, contrib: { s: 0.5 } }));
    expect(tr.get("s")!.ewmaScore).toBeCloseTo(1, 10);
    tr.update(trade({ move: -0.01, contrib: { s: 0.5 } }));
    expect(tr.get("s")!.ewmaScore).toBeCloseTo(1 - 0.1 * 2, 10);
  });

  it("保存済みの値 (旧形式: effN なし) はそのまま読み込み、続きから更新する", () => {
    const store = new MemoryStore();
    const saved: Record<string, SourceReliability> = { old: { source: "old", n: 30, hits: 20, ewmaScore: 0.4, weight: 1.343, updatedAt: T0 } };
    store.kvSet(sourceReliabilityKey("paper"), saved);
    const tr = new SourceReliabilityTracker(store);
    expect(tr.get("old")).toEqual(saved.old);
    expect(tr.weight("old")).toBe(1.343);
    tr.update(trade({ move: 0.01, contrib: { old: 0.5 } }));
    expect(tr.get("old")).toMatchObject({ n: 31, hits: 21, effN: 31 });
    expect(tr.get("old")!.ewmaScore).toBeCloseTo(0.4 + 0.1 * (1 - 0.4), 10);
  });
});

describe("5. エグジット後の値動きの補完で差分だけ反映", () => {
  it("決済時は上昇 (強気が的中) → 補完で大きく下落 → 当たりを外れに入れ替える (件数は増やさない)", () => {
    const store = new MemoryStore();
    const tr = new SourceReliabilityTracker(store);
    for (let i = 0; i < 20; i++) tr.update(trade({ move: 0.01, contrib: { s: 0.5 }, postExit: 0 }));
    const t = trade({ move: 0.001, contrib: { s: 0.5 } });
    tr.update(t);
    const atClose = tr.get("s")!;
    expect(atClose).toMatchObject({ n: 21, hits: 21 });
    expect(store.kvGet<Record<string, unknown>>(sourceAppliedKey("paper"))).toHaveProperty(t.id);
    // ロングで小さく勝ったが、その後 2% 下落 → 下落と判定
    const revised = tr.reviseWithPostExit({ ...t, postExitMovePct: -0.02 }, t.exitTs + HOUR);
    expect(revised).toEqual(["s"]);
    const after = tr.get("s")!;
    expect(after).toMatchObject({ n: 21, hits: 20, effN: atClose.effN });
    expect(after.ewmaScore).toBeCloseTo(atClose.ewmaScore - 0.1 * 2, 10);
    // 2 回目は何もしない (二重に反映しない)
    expect(tr.reviseWithPostExit({ ...t, postExitMovePct: -0.02 }, t.exitTs + 2 * HOUR)).toEqual([]);
    expect(tr.get("s")).toEqual(after);
  });

  it("決済時に方向不明なら補完後に新しく更新する。同じ向き・決済時の記録なしは何もしない", () => {
    const tr = new SourceReliabilityTracker(new MemoryStore());
    const flat = trade({ move: 0, contrib: { s: 0.5 } });
    expect(tr.update(flat)).toEqual([]);
    expect(tr.get("s")).toBeUndefined();
    expect(tr.reviseWithPostExit({ ...flat, postExitMovePct: 0.02 })).toEqual(["s"]);
    expect(tr.get("s")).toMatchObject({ n: 1, hits: 1, effN: 1 });
    const same = trade({ move: 0.01, contrib: { s: 0.5 } });
    tr.update(same);
    expect(tr.reviseWithPostExit({ ...same, postExitMovePct: 0.01 })).toEqual([]);
    // この仕組みの前に決済したトレード (記録なし) は何もしない
    expect(tr.reviseWithPostExit({ ...trade({ move: 0.01, contrib: { s: 0.5 } }), postExitMovePct: -0.05 })).toEqual([]);
    expect(tr.get("s")).toMatchObject({ n: 2, hits: 2 });
  });

  it("LearningService.periodic: 後追い値動きの補完のあとに信頼度を直す", async () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store, priceAt: () => 95, postExitHorizonMs: { short: HOUR } });
    const t = trade({ move: 0.001, contrib: { s: 0.5 } });
    svc.onTradeClosed(t);
    expect(svc.reliability.get("s")).toMatchObject({ n: 1, hits: 1 });
    const res = await svc.periodic(t.exitTs + 2 * HOUR);
    expect(res.postExitFilled).toBe(1);
    expect(res.reliabilityRevised).toBe(1);
    expect(svc.reliability.get("s")).toMatchObject({ n: 1, hits: 0 });
    // 永続化されている
    expect(new SourceReliabilityTracker(store).get("s")).toMatchObject({ n: 1, hits: 0 });
  });
});

describe("7. 未来時刻の記事", () => {
  const NOW = Date.UTC(2026, 0, 5, 12);
  it("rss: now より 5 分以上未来の公開時刻は now に丸める (5 分以内はそのまま)", () => {
    expect(normalizePublishedAt(NOW + 10 * MIN, NOW)).toBe(NOW);
    expect(normalizePublishedAt(NOW + 4 * MIN, NOW)).toBe(NOW + 4 * MIN);
    expect(normalizePublishedAt(NOW - HOUR, NOW)).toBe(NOW - HOUR);
    expect(normalizePublishedAt(Number.NaN, NOW)).toBe(NOW);
    const future = new Date(NOW + 365 * 86_400_000).toUTCString();
    const xml = `<?xml version="1.0"?><rss><channel><item><title>BTC rallies</title><link>https://x/1</link><pubDate>${future}</pubDate></item></channel></rss>`;
    expect(parseFeed(xml, { source: "rss:x", now: NOW })[0].publishedAt).toBe(NOW);
  });

  it("aggregate: 未来の記事は取得時刻 (それも未来なら now) として減衰させる", () => {
    const it = (over: Partial<IntelItem>): IntelItem => ({ id: "f", source: "rss:a", kind: "news", title: "f", publishedAt: NOW, fetchedAt: NOW, assets: ["BTC"], sentiment: 0.8, importance: 0.8, ...over });
    expect(effectivePublishedAt({ publishedAt: NOW + 86_400_000, fetchedAt: NOW - 12 * HOUR }, NOW)).toBe(NOW - 12 * HOUR);
    expect(effectivePublishedAt({ publishedAt: NOW + 86_400_000, fetchedAt: NOW + HOUR }, NOW)).toBe(NOW);
    expect(effectivePublishedAt({ publishedAt: NOW + 2 * MIN, fetchedAt: NOW }, NOW)).toBe(NOW + 2 * MIN);
    // 12 時間前に取得した「1 日後」の記事は、12 時間前の記事と同じ重み (旧: 最大の重みのまま)
    const fut = buildBiases([it({ publishedAt: NOW + 86_400_000, fetchedAt: NOW - 12 * HOUR })], { now: NOW }).BTC;
    const old = buildBiases([it({ publishedAt: NOW - 12 * HOUR, fetchedAt: NOW - 12 * HOUR })], { now: NOW }).BTC;
    const fresh = buildBiases([it({})], { now: NOW }).BTC;
    expect(fut.sentiment).toBeCloseTo(old.sentiment, 10);
    expect(fut.sentiment).toBeLessThan(fresh.sentiment);
  });
});
