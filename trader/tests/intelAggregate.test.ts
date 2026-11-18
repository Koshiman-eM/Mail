import { describe, expect, it } from "vitest";
import { buildBiases, EVENT_POST_MS, EVENT_PRE_MS } from "../src/intel/aggregate";
import type { EconEvent, IntelItem, SourceReliability } from "../src/core/types";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const item = (id: string, over: Partial<IntelItem> = {}): IntelItem => ({
  id,
  source: "rss:a",
  kind: "news",
  title: id,
  publishedAt: NOW,
  fetchedAt: NOW,
  assets: ["BTC"],
  sentiment: 0.8,
  importance: 0.8,
  ...over,
});
const rel = (source: string, weight: number): Record<string, SourceReliability> => ({
  [source]: { source, n: 20, hits: 10, ewmaScore: 0, weight, updatedAt: NOW },
});
const opts = { now: NOW, halfLifeMs: 6 * H };

describe("buildBiases", () => {
  it("センチメントの方向・sourceIds・sourceContrib", () => {
    const b = buildBiases([item("1"), item("2", { source: "rss:b", sentiment: 0.4 })], opts).BTC;
    expect(b.sentiment).toBeGreaterThan(0.3);
    expect(b.sourceIds.sort()).toEqual(["1", "2"]);
    expect(b.sourceContrib["rss:a"]).toBeGreaterThan(b.sourceContrib["rss:b"]);
    expect(b.eventRisk).toBe(0);
  });
  it("時間減衰: 古い記事は影響が小さい", () => {
    const fresh = buildBiases([item("1")], opts).BTC;
    const old = buildBiases([item("1", { publishedAt: NOW - 12 * H })], opts).BTC;
    expect(old.sentiment).toBeLessThan(fresh.sentiment);
    expect(old.confidence).toBeLessThan(fresh.confidence);
    // 新しい逆向き記事が古い記事を上回る
    const mix = buildBiases([item("1", { publishedAt: NOW - 18 * H }), item("2", { sentiment: -0.8 })], opts).BTC;
    expect(mix.sentiment).toBeLessThan(0);
  });
  it("信頼度 weight が大きいほど sentiment/confidence が大きい (単一情報源)", () => {
    const run = (w: number) => buildBiases([item("1")], { ...opts, reliability: rel("rss:a", w) }).BTC;
    const lo = run(0.2);
    const mid = run(1);
    const hi = run(2);
    expect(lo.sentiment).toBeLessThan(mid.sentiment);
    expect(mid.sentiment).toBeLessThan(hi.sentiment);
    expect(lo.confidence).toBeLessThan(hi.confidence);
    expect(run(0).sentiment).toBe(0);
    expect(run(0).confidence).toBe(0);
  });
  it("信頼度 weight は複数情報源の対立で勝敗を決める", () => {
    const items = [item("1", { source: "rss:good", sentiment: 0.8 }), item("2", { source: "rss:bad", sentiment: -0.8 })];
    const neutral = buildBiases(items, opts).BTC;
    expect(Math.abs(neutral.sentiment)).toBeLessThan(1e-9);
    const reliability = { ...rel("rss:good", 1.8), ...rel("rss:bad", 0.2) };
    const b = buildBiases(items, { ...opts, reliability }).BTC;
    expect(b.sentiment).toBeGreaterThan(0.3);
    const flipped = buildBiases(items, { ...opts, reliability: { ...rel("rss:good", 0.2), ...rel("rss:bad", 1.8) } }).BTC;
    expect(flipped.sentiment).toBeLessThan(-0.3);
  });
  it("weight 0 でも sourceContrib は素の方向を保持 (学習で再評価できる)", () => {
    const b = buildBiases([item("1")], { ...opts, reliability: rel("rss:a", 0) }).BTC;
    expect(b.sourceContrib["rss:a"]).toBeGreaterThan(0);
  });
  it("一致度: 意見が割れると confidence が下がる", () => {
    const agree = buildBiases([item("1"), item("2")], opts).BTC;
    const split = buildBiases([item("1"), item("2", { sentiment: -0.8 })], opts).BTC;
    expect(split.confidence).toBeLessThan(agree.confidence);
  });
  it("重複 id・calendar/metric・未分析は無視", () => {
    const b = buildBiases([item("1"), item("1"), item("2", { sentiment: undefined }), item("3", { kind: "calendar" })], opts).BTC;
    expect(b.sourceIds).toEqual(["1"]);
  });
  it("Fear&Greed: 極端な強欲はマイナス、恐怖はプラス (CRYPTO)", () => {
    const fng = (v: number): IntelItem => item("f", { source: "fng:alternative.me", kind: "metric", assets: ["CRYPTO"], sentiment: undefined, metrics: { fng: v } });
    expect(buildBiases([fng(90)], opts).CRYPTO.sentiment).toBeLessThan(-0.05);
    expect(buildBiases([fng(10)], opts).CRYPTO.sentiment).toBeGreaterThan(0.05);
    expect(Math.abs(buildBiases([fng(50)], opts).CRYPTO.sentiment)).toBeLessThan(1e-9);
  });
});

describe("経済指標ブラックアウト", () => {
  const ev = (dtMs: number, over: Partial<EconEvent> = {}): EconEvent => ({ ts: NOW + dtMs, title: "NFP", currency: "USD", impact: "high", source: "calendar:ff", ...over });
  it("30 分前から +15 分まで blackoutUntil = ts+15分", () => {
    const e = ev(20 * 60_000);
    const b = buildBiases([], { ...opts, events: [e] });
    expect(b.USD.blackoutUntil).toBe(e.ts + EVENT_POST_MS);
    expect(b.USD.eventRisk).toBe(1);
    expect(b.FX.blackoutUntil).toBe(e.ts + EVENT_POST_MS);
    expect(b.CRYPTO.blackoutUntil).toBeUndefined();
    expect(b.CRYPTO.eventRisk).toBeGreaterThan(0);
  });
  it("境界: 31 分前は未発動、16 分後は終了", () => {
    expect(buildBiases([], { ...opts, events: [ev(EVENT_PRE_MS + 60_000)] }).USD.blackoutUntil).toBeUndefined();
    expect(buildBiases([], { ...opts, events: [ev(EVENT_PRE_MS + 60_000)] }).USD.eventRisk).toBeGreaterThan(0.5);
    expect(buildBiases([], { ...opts, events: [ev(-(EVENT_POST_MS + 60_000))] }).USD.blackoutUntil).toBeUndefined();
  });
  it("遠い将来・medium/low は blackout なし", () => {
    expect(buildBiases([], { ...opts, events: [ev(24 * H)] }).USD).toBeUndefined();
    const m = buildBiases([], { ...opts, events: [ev(10 * 60_000, { impact: "medium", currency: "JPY" })] });
    expect(m.JPY.blackoutUntil).toBeUndefined();
    expect(m.JPY.eventRisk).toBeCloseTo(0.5);
  });
});
