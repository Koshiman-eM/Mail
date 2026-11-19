import { describe, expect, it } from "vitest";
import { foldBoundaries, foldedBacktest } from "../src/backtest/evaluate";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { TIMEFRAME_MS, type Candle, type IntelBias, type MarketBrief, type Strategy } from "../src/core/types";
import { createParamValidator, HistoryCache, intelTimeline } from "../src/engine/learningHooks";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";
import { getStrategy } from "../src/strategies/registry";

const H = TIMEFRAME_MS["1h"];
const START = Date.UTC(2025, 0, 1);
const inst = syntheticInstrument({ symbol: "SYN/USDT" });

/** 事前に用意した足を since からページングで返す偽の feed (呼び出し回数を数える) */
function mockFeed(candles: Candle[], o: { fail?: boolean } = {}) {
  const f = {
    calls: 0,
    fail: o.fail ?? false,
    async fetchCandles(_s: string, _tf: string, limit: number, since?: number) {
      f.calls++;
      if (f.fail) throw new Error("network down");
      return candles.filter((c) => since === undefined || c.ts >= since).slice(0, limit);
    },
  };
  return f;
}
const clockAt = (t: number) => ({ t, now() { return this.t; } });
const brief = (t: number, sentiment: number): MarketBrief => ({
  generatedAt: t, riskOn: 0, summary: "", watchlist: [], events: [], stub: true,
  biases: { SYN: { asset: "SYN", sentiment, confidence: 0.8, eventRisk: 0, sourceIds: ["s"], sourceContrib: { "rss:a": 0.5 } } },
});

describe("パラメータ検証 (長い履歴・区間分割)", () => {
  const s = getStrategy("short_breakout")!; // 主時間足 1h
  const candles = generateCandles({ seed: 11, bars: 3200, timeframe: "1h", startTs: START, vol: 0.004 });
  const end = candles[candles.length - 1].ts + H;

  /** ウォームアップを短くした同じ戦略 (同じ 1h 足) を同じキャッシュで検証する */
  let v2Shared: (feed: ReturnType<typeof mockFeed>) => Promise<unknown> = async () => undefined;

  it("feed から主時間足 3000 本をページングで取得し、5 区間の成績を返す。現行と候補は同じデータ・区間 (キャッシュ)", async () => {
    const feed = mockFeed(candles);
    const cache = new HistoryCache({ ttlMs: 6 * 3_600_000, failureTtlMs: 60_000 });
    const short: Strategy = { ...s, id: "short_warmup", warmup: 10 };
    const v = createParamValidator({ hub: { watched: () => [inst] }, strategies: [s, short], clock: clockAt(end), feedFor: () => feed, pageLimit: 500, cache });
    v2Shared = () => v("short_warmup", "crypto", s.defaultParams);
    const a = (await v(s.id, "crypto", s.defaultParams))!;
    expect(a.folds).toHaveLength(5);
    expect(feed.calls).toBeGreaterThanOrEqual(6); // 3080 本以上 / 500 本
    // ウォームアップの違う同じ時間足の戦略も同じ履歴を使う (取り直さない)
    const callsAfterFirst = feed.calls;
    await v2Shared(feed);
    expect(feed.calls).toBe(callsAfterFirst);
    const span = a.folds[4].to - a.folds[0].from;
    expect(span).toBe(3000 * H);
    expect(a.folds.reduce((n, f) => n + f.trades, 0)).toBe(a.trades.length);
    expect(a.trades.length).toBeGreaterThan(0);
    for (const t of a.trades) expect(t.entryTs).toBeGreaterThanOrEqual(a.folds[0].from);
    const calls = feed.calls;
    const b = (await v(s.id, "crypto", { ...s.defaultParams, stopAtr: s.defaultParams.stopAtr * 1.1 }))!;
    expect(feed.calls).toBe(calls); // キャッシュから
    expect(b.dataKey).toBe(a.dataKey);
    expect(b.folds.map((f) => [f.from, f.to])).toEqual(a.folds.map((f) => [f.from, f.to]));
  });

  it("取得失敗・履歴不足・板必須・feed なし・資産クラス違いは undefined。失敗は一定時間再取得しない", async () => {
    const clock = clockAt(end);
    const bad = mockFeed(candles, { fail: true });
    const v = createParamValidator({ hub: { watched: () => [inst] }, strategies: [s, getStrategy("scalp_obi")!], clock, feedFor: () => bad });
    expect(await v(s.id, "crypto", s.defaultParams)).toBeUndefined();
    expect(await v(s.id, "crypto", s.defaultParams)).toBeUndefined();
    expect(bad.calls).toBe(1);
    bad.fail = false;
    clock.t += 31 * 60_000;
    expect(await v(s.id, "crypto", s.defaultParams)).toBeDefined();

    const short = mockFeed(candles.slice(-1500)); // 要求 3080 本に対して半分未満
    const v2 = createParamValidator({ hub: { watched: () => [inst] }, strategies: [s], clock: clockAt(end), feedFor: () => short });
    expect(await v2(s.id, "crypto", s.defaultParams)).toBeUndefined();
    expect(await v(s.id, "fx", s.defaultParams)).toBeUndefined();
    expect(await v("scalp_obi", "crypto", getStrategy("scalp_obi")!.defaultParams)).toBeUndefined();
    expect(await v("unknown", "crypto", {})).toBeUndefined();
    const none = createParamValidator({ hub: { watched: () => [inst] }, strategies: [s], clock: clockAt(end), feedFor: () => undefined });
    expect(await none(s.id, "crypto", s.defaultParams)).toBeUndefined();
  });

  it("HistoryCache: ttl 内は再利用、超えたら取り直す", async () => {
    const cache = new HistoryCache({ ttlMs: 1000, failureTtlMs: 100 });
    let n = 0;
    const load = async () => [{ ts: ++n, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    expect((await cache.get("k", 0, 50, load))![0].ts).toBe(1);
    expect((await cache.get("k", 999, 60, load))![0].ts).toBe(1); // 取得済みの範囲に含まれる
    expect((await cache.get("k", 999, 40, load))![0].ts).toBe(2); // より古い開始時刻は取り直す
    expect((await cache.get("k", 1999, 40, load))![0].ts).toBe(3); // ttl 切れ
  });

  it("その時点で記録済みのバイアスを時刻順に戦略へ渡す (先読みしない・古いブリーフは使わない)", async () => {
    const seen: { now: number; s?: number }[] = [];
    const spy: Strategy = {
      ...s, id: "spy", warmup: 30,
      evaluate: (ctx) => {
        seen.push({ now: ctx.market.now, s: ctx.intel?.sentiment });
        return null;
      },
    };
    const store = new MemoryStore();
    const firstFold = end - 3000 * H;
    store.saveBrief(brief(firstFold + 100 * H, 0.5));
    store.saveBrief(brief(firstFold + 102 * H, -0.5));
    const feed = mockFeed(candles);
    const v = createParamValidator({
      hub: { watched: () => [inst] }, strategies: [spy], clock: clockAt(end), feedFor: () => feed,
      briefsBetween: (a, b) => store.listBriefs!({ since: a, until: b }), intelInfluence: () => 0.5,
    });
    await v("spy", "crypto", spy.defaultParams);
    const at = (t: number) => seen.find((x) => x.now === t);
    expect(at(firstFold + 99 * H)?.s).toBeUndefined(); // ブリーフ作成前の判定 (確定時刻 = 足の終わり) には渡さない
    expect(at(firstFold + 100 * H)?.s).toBeCloseTo(0.25, 12); // 0.5 × 効き具合 0.5
    expect(at(firstFold + 101 * H)?.s).toBeCloseTo(0.25, 12);
    expect(at(firstFold + 103 * H)?.s).toBeCloseTo(-0.25, 12);
    expect(at(firstFold + 120 * H)?.s).toBeUndefined(); // 6 時間より古い
  });

  it("intelTimeline と Store.listBriefs (memory / sqlite)", () => {
    const f = intelTimeline(inst, [brief(2000, -0.2), brief(1000, 0.4)], 1, 500);
    expect(f(999)).toBeUndefined();
    expect(f(1000)?.sentiment).toBeCloseTo(0.4, 12);
    expect(f(1600)).toBeUndefined();
    expect((f(2100) as IntelBias).sentiment).toBeCloseTo(-0.2, 12);
    for (const st of [new MemoryStore(), new SqliteStore(":memory:")]) {
      st.saveBrief(brief(300, 0));
      st.saveBrief(brief(100, 0));
      st.saveBrief(brief(200, 0));
      expect(st.listBriefs!({ since: 150 }).map((b) => b.generatedAt)).toEqual([200, 300]);
      expect(st.listBriefs!({ until: 200 }).map((b) => b.generatedAt)).toEqual([100, 200]);
      st.close();
    }
  });

  it("foldedBacktest: 区間ごとに独立に走らせ、区間内のエントリーだけを数える", () => {
    const bounds = foldBoundaries(candles[0].ts + 100 * H, end, 4);
    expect(bounds).toHaveLength(5);
    const runs = foldedBacktest(s, s.defaultParams, inst, candles, bounds, { baseTimeframe: "1h" });
    expect(runs).toHaveLength(4);
    for (const r of runs) for (const t of r.trades) {
      expect(t.entryTs).toBeGreaterThanOrEqual(r.from);
      expect(t.entryTs).toBeLessThan(r.to);
      expect(t.exitTs).toBeLessThanOrEqual(r.to); // 区間末で決済 (持ち越さない)
    }
  });
});
