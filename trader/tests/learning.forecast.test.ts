import { describe, expect, it } from "vitest";
import type { Candle, Timeframe } from "../src/core/types";
import {
  classifyForecast, closedOnly, forecastOverlap, computeForecastFeatures, DEFAULT_FORECAST_OPTIONS, FORECAST_FEATURES, forecastPendingKey, forecastSizeMultiplier,
  forecastStatsKey, forecastTimeframes, ForecastTracker, hitRateZ, horizonForStrategy, initialModel, loadForecastSummary, predictUp, sgdUpdate,
  skillConfirmed, type ForecastFeatures, type PendingForecast,
} from "../src/learning/forecast";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { SqliteStore } from "../src/storage/sqlite";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5);

/** 1 分足の終値の列 → 1m と、それをまとめた上位足 (すべて確定足) */
function candlesFrom(closes: number[], start = T0, tfs: Timeframe[] = ["1m", "5m", "15m", "1h"]): Partial<Record<Timeframe, Candle[]>> {
  const m1: Candle[] = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { ts: start + i * MIN, open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c, volume: 1 + (i % 3) };
  });
  const out: Partial<Record<Timeframe, Candle[]>> = {};
  const ms: Record<string, number> = { "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": HOUR };
  for (const tf of tfs) {
    if (tf === "1m") {
      out[tf] = m1;
      continue;
    }
    const n = ms[tf] / MIN;
    const agg: Candle[] = [];
    for (let i = 0; i + n <= m1.length; i += n) {
      const g = m1.slice(i, i + n);
      agg.push({ ts: g[0].ts, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close, volume: g.reduce((a, x) => a + x.volume, 0) });
    }
    out[tf] = agg;
  }
  return out;
}

function randomWalk(n: number, seed = 1, drift = 0, sigma = 0.001): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const z = (rng() + rng() + rng() - 1.5) * 2;
    p *= 1 + drift + sigma * z;
    out.push(p);
  }
  return out;
}

const pending = (o: Partial<PendingForecast> & Pick<PendingForecast, "id">): PendingForecast => ({
  symbol: "BTC/USDT", assetClass: "crypto", horizonMs: 15 * MIN, madeAt: T0, mid0: 100, pUp: 0.5, dir: "flat", f: [0, 0, 0, 0, 0],
  atrPctPerMin: 0.001, costPct: 0.001, ...o,
});

describe("予想の特徴量 (確定足のみ・先読みしない)", () => {
  it("形成中の足や未来の足を足しても特徴量・値幅は変わらない", () => {
    const closes = randomWalk(600, 3);
    const base = candlesFrom(closes);
    const now = T0 + 600 * MIN; // 最後の 1 分足 (ts = T0 + 599 分) がちょうど確定した時刻
    const withFuture: Partial<Record<Timeframe, Candle[]>> = {};
    for (const [tf, c] of Object.entries(base) as [Timeframe, Candle[]][]) {
      const last = c[c.length - 1];
      const ms = tf === "1m" ? MIN : tf === "5m" ? 5 * MIN : tf === "15m" ? 15 * MIN : HOUR;
      // 形成中の足 (ts + 時間足 > now) と、その先の未来の足。極端な値にする
      const forming = { ts: last.ts + ms, open: last.close, high: last.close * 3, low: last.close * 0.3, close: last.close * 2.5, volume: 999 };
      const future = { ...forming, ts: forming.ts + ms, close: last.close * 0.2 };
      withFuture[tf] = [...c, forming, future];
    }
    for (const h of DEFAULT_FORECAST_OPTIONS.horizonsMs) {
      const a = computeForecastFeatures({ candles: base, now, mid: closes[closes.length - 1], horizonMs: h });
      const b = computeForecastFeatures({ candles: withFuture, now, mid: closes[closes.length - 1], horizonMs: h });
      expect(a).toBeDefined();
      expect(b).toEqual(a);
    }
    // closedOnly は形成中の足を落とす
    expect(closedOnly(withFuture["5m"], "5m", now)).toHaveLength(base["5m"]!.length);
  });

  it("予想時間に合う時間足を選ぶ (15 分 → 5m と 1m、1 時間 → 15m、4 時間 → 1h。無い時間足は近いもの)", () => {
    expect(forecastTimeframes(15 * MIN, ["1m", "5m", "15m", "1h"])).toEqual(["5m", "1m"]);
    expect(forecastTimeframes(HOUR, ["1m", "5m", "15m", "1h"])).toEqual(["15m"]);
    expect(forecastTimeframes(4 * HOUR, ["1m", "5m", "15m", "1h"])).toEqual(["1h"]);
    expect(forecastTimeframes(4 * HOUR, ["1m", "5m"])).toEqual(["5m"]);
    expect(forecastTimeframes(15 * MIN, ["15m", "1h"])).toEqual(["15m"]);
    expect(forecastTimeframes(HOUR, [])).toEqual([]);
  });

  it("足が足りなければ予想しない", () => {
    const c = candlesFrom(randomWalk(20, 2), T0, ["1m"]);
    expect(computeForecastFeatures({ candles: c, now: T0 + 20 * MIN, mid: 100, horizonMs: 15 * MIN })).toBeUndefined();
  });

  it("特徴量は −1〜+1、pUp は 0〜1、方向は閾値で決まる", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const drift = (seed % 5 - 2) * 0.0008;
      const closes = randomWalk(400, seed, drift, 0.002 * (1 + (seed % 3)));
      const now = T0 + 400 * MIN;
      for (const h of DEFAULT_FORECAST_OPTIONS.horizonsMs) {
        const r = computeForecastFeatures({ candles: candlesFrom(closes), now, mid: closes[399], horizonMs: h, news: seed % 2 ? 5 : -5, consensus: -3 });
        if (!r) continue;
        for (const k of FORECAST_FEATURES) {
          expect(r.features[k]).toBeGreaterThanOrEqual(-1);
          expect(r.features[k]).toBeLessThanOrEqual(1);
        }
        expect(r.features.news).toBe(seed % 2 ? 1 : -1);
        expect(r.rangePct).toBeGreaterThan(0);
        const big = { w: Object.fromEntries(FORECAST_FEATURES.map((k) => [k, 3])) as ForecastFeatures, b: 1, updates: 0 };
        for (const m of [initialModel(), big]) {
          const p = predictUp(m, r.features);
          expect(p).toBeGreaterThan(0);
          expect(p).toBeLessThan(1);
        }
      }
    }
    expect(classifyForecast(0.5, 0.05)).toBe("flat");
    expect(classifyForecast(0.549, 0.05)).toBe("flat");
    expect(classifyForecast(0.451, 0.05)).toBe("flat");
    expect(classifyForecast(0.55, 0.05)).toBe("up");
    expect(classifyForecast(0.44, 0.05)).toBe("down");
    expect(classifyForecast(NaN, 0.05)).toBe("flat");
  });

  it("初期の重みは小さく、pUp は 0.5 付近から始まる", () => {
    const m = initialModel();
    const ones = Object.fromEntries(FORECAST_FEATURES.map((k) => [k, 1])) as ForecastFeatures;
    expect(Math.abs(predictUp(m, ones) - 0.5)).toBeLessThan(0.07);
  });
});

describe("答え合わせ (期限・ノイズ・的中率・Brier・較正)", () => {
  it("期限前は判定せず、期限後にまとめて判定する。ノイズは学習に使わず、flat の予想は的中率に数えない", () => {
    const store = new MemoryStore();
    const due = T0 + 15 * MIN;
    store.kvSet(forecastPendingKey("paper"), [
      pending({ id: "a", pUp: 0.7, dir: "up", symbol: "A" }), // 101 → 上昇・的中
      pending({ id: "b", pUp: 0.3, dir: "down", symbol: "A" }), // 101 → 上昇・外れ
      pending({ id: "c", pUp: 0.6, dir: "up", symbol: "C" }), // 100.1 → ノイズ (flat)
      pending({ id: "d", pUp: 0.52, dir: "flat", symbol: "D" }), // 99 → 下落 (flat の予想)
      pending({ id: "e", pUp: 0.8, dir: "up", symbol: "E", madeAt: T0 - HOUR }), // 価格なし・遅すぎ → 期限切れ
      pending({ id: "x", pUp: 0.8, dir: "up", symbol: "GONE" }), // 監視終了 → 捨てる
    ]);
    const t = new ForecastTracker({ store, mode: "paper" });
    const px: Record<string, number> = { A: 101, C: 100.1, D: 99 };
    const deps = { isWatched: (s: string) => s !== "GONE", midNow: () => undefined, priceAt: (s: string, ts: number) => (ts === due ? px[s] : undefined) };

    let r = t.evaluate(due - MIN, deps);
    expect(r.judged).toBe(0);
    expect(t.listPending().map((p) => p.id).sort()).toEqual(["a", "b", "c", "d"]); // e は期限切れ、x は捨てた
    expect(r.expired).toBe(1);

    r = t.evaluate(due, deps);
    expect(r).toMatchObject({ judged: 4, hits: 1, noise: 1, learned: 3 });
    expect(t.listPending()).toHaveLength(0);
    t.flush();

    const s = t.summary(due);
    const g = s.byClass.find((x) => x.horizon === "15m" && x.assetClass === "crypto")!;
    expect(g).toMatchObject({ n: 2, hits: 1, hitRate: 0.5, noise: 1, flatPred: 1, flatHits: 0, expired: 1, brierN: 3 });
    // Brier: (0.7−1)² + (0.3−1)² + (0.52−0)² を 3 件で割る
    expect(g.brier).toBeCloseTo((0.09 + 0.49 + 0.2704) / 3, 6);
    const cal = s.calibration.find((c) => c.horizon === "15m")!.bins;
    expect(cal[7]).toMatchObject({ n: 1, up: 1, upRate: 1 });
    expect(cal[3]).toMatchObject({ n: 1, up: 1 });
    expect(cal[5]).toMatchObject({ n: 1, up: 0, upRate: 0 });
    expect(cal[6].n).toBe(0); // ノイズ (c) は較正に入れない
    expect(s.bySymbol.find((x) => x.symbol === "A")).toMatchObject({ n: 2, hits: 1 });
    expect(s.droppedUnwatched).toBe(1);
    expect(s.learned).toBe(3);
    expect(s.models.find((m) => m.key === "15m|crypto")!.updates).toBe(3);

    // 判定済みの記録 (期限切れを含む 5 件)
    const recs = store.listForecastOutcomes({ mode: "paper" });
    expect(recs.map((x) => [x.id, x.outcome, x.hit]).sort()).toEqual([
      ["a", "up", true], ["b", "up", false], ["c", "flat", undefined], ["d", "down", undefined], ["e", "expired", undefined],
    ].sort());
    // ノイズの範囲 = max(0.001 × √15 × 0.5, 0.001)
    expect(recs.find((x) => x.id === "c")!.noisePct).toBeCloseTo(0.001 * Math.sqrt(15) * 0.5, 6);
  });

  it("1 分足が無いときは期限から lateToleranceMs 以内なら現在の仲値で判定する", () => {
    const store = new MemoryStore();
    store.kvSet(forecastPendingKey("paper"), [pending({ id: "a", pUp: 0.7, dir: "up" })]);
    const t = new ForecastTracker({ store, mode: "paper" });
    const r = t.evaluate(T0 + 18 * MIN, { isWatched: () => true, midNow: () => 98 });
    expect(r).toMatchObject({ judged: 1, hits: 0, expired: 0 });
  });

  it("的中率・z・実力の判定 (100 件以上かつ片側 95% で有意)", () => {
    expect(hitRateZ(100, 59)).toBeCloseTo(1.7, 6);
    expect(skillConfirmed(100, 59, DEFAULT_FORECAST_OPTIONS)).toBe(true);
    expect(skillConfirmed(100, 58, DEFAULT_FORECAST_OPTIONS)).toBe(false);
    expect(skillConfirmed(99, 80, DEFAULT_FORECAST_OPTIONS)).toBe(false);
    expect(skillConfirmed(40, 30, { minSamples: 30, zCritical: 1.645 })).toBe(true);
    // 重なる予想 (4 時間後を 5 分ごと = 48 件が同じ値動き) は z を √48 で割る
    expect(forecastOverlap(4 * HOUR, 5 * MIN)).toBe(48);
    expect(forecastOverlap(15 * MIN, 5 * MIN)).toBe(3);
    expect(forecastOverlap(MIN, 5 * MIN)).toBe(1);
    expect(skillConfirmed(258, 165, DEFAULT_FORECAST_OPTIONS)).toBe(true); // 補正なしなら z ≈ 4.4
    expect(skillConfirmed(258, 165, DEFAULT_FORECAST_OPTIONS, 48)).toBe(false);
    expect(skillConfirmed(2000, 1300, DEFAULT_FORECAST_OPTIONS, 48)).toBe(true);
    const store = new MemoryStore();
    const day = String(Math.floor(T0 / 86_400_000) * 86_400_000);
    const c = { n: 258, hits: 165, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 60, brierN: 258 };
    // LIVE の判定は基礎モデル (b|) のクラスタ単位の集計で行う (1 銘柄なのでクラスタ = 予想 1 件)
    // クラスタ 300 個・的中の割合の合計 195: z = 5.14 → 15 分 (√3 で割る) 2.97 ≥ 2.64 / 4 時間 (√48) 0.74
    const b = { ...c, n: 300, hits: 195, cn: 300, cs: 195 };
    store.kvSet(forecastStatsKey("paper"), { days: { [day]: { "c|15m|fx": c, "c|4h|fx": c, "b|15m|fx": b, "b|4h|fx": b } } });
    const t = new ForecastTracker({ store, mode: "paper" });
    expect(t.skill(15 * MIN, "fx", T0).live).toBe(true);
    expect(t.skill(4 * HOUR, "fx", T0).live).toBe(false);
    const sm = t.summary(T0).byClass;
    expect(sm.find((g) => g.horizon === "4h")).toMatchObject({ overlap: 48, live: false });
    expect(sm.find((g) => g.horizon === "4h")!.z).toBeCloseTo(sm.find((g) => g.horizon === "4h")!.zRaw / Math.sqrt(48), 2);
  });
});

describe("学習 (オンラインのロジスティック回帰)", () => {
  it("重みには上限があり、L2 正則化で使われない重みは縮む", () => {
    let m = initialModel();
    const f = { trend: 1, momentum: -1, meanRevert: 0, news: 0, consensus: 0 };
    for (let i = 0; i < 5000; i++) m = sgdUpdate(m, f, 1, { learningRate: 0.5, l2: 0, maxWeight: 3, maxBias: 1 });
    expect(m.w.trend).toBe(3);
    expect(m.w.momentum).toBe(-3);
    expect(m.b).toBe(1);
    expect(m.updates).toBe(5000);
    // 特徴量 0 の重みは L2 だけで縮む
    let z = { w: { trend: 2, momentum: -2, meanRevert: 0, news: 0, consensus: 0 }, b: 0, updates: 0 };
    const zero = { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 0 };
    for (let i = 0; i < 100; i++) z = sgdUpdate(z, zero, i % 2 ? 1 : 0, { learningRate: 0.1, l2: 0.05, maxWeight: 3, maxBias: 1 });
    expect(z.w.trend).toBeGreaterThan(0);
    expect(z.w.trend).toBeLessThan(2 * Math.pow(1 - 0.1 * 0.05, 100) + 1e-9);
    expect(z.w.momentum).toBeLessThan(0);
    expect(Math.abs(z.w.momentum)).toBeCloseTo(Math.abs(z.w.trend), 9);
  });

  it("上昇・下降が続く合成データで、トレンドの重みがプラスに育ち、的中率が上がる", () => {
    // 2〜8 時間ごとに向きが変わるドリフト (トレンドが続く相場)
    const rng = mulberry32(11);
    const N = 12 * 24 * 60; // 12 日分の 1 分足
    const closes: number[] = [];
    let p = 100;
    let drift = 0.0003;
    let left = 0;
    for (let i = 0; i < N; i++) {
      if (left-- <= 0) {
        drift = (rng() < 0.5 ? -1 : 1) * 0.00012;
        left = 120 + Math.floor(rng() * 360);
      }
      p *= 1 + drift + 0.0008 * (rng() + rng() + rng() - 1.5) * 2;
      closes.push(p);
    }
    const all = candlesFrom(closes, T0, ["1m", "5m"]);
    const store = new MemoryStore();
    // 初期の重みは 0 (はじめは予想に実力が無い = すべて flat)
    const t = new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN], initialWeight: 0 } });
    const lastIdx = (c: Candle[], now: number, ms: number) => {
      // now の時点で確定している足の数 (昇順・等間隔)
      return Math.max(0, Math.min(c.length, Math.floor((now - T0) / ms)));
    };
    const priceAt = (_s: string, ts: number) => closes[Math.floor((ts - T0) / MIN)];
    for (let now = T0 + 6 * HOUR; now < T0 + N * MIN - 20 * MIN; now += 5 * MIN) {
      t.evaluate(now, { isWatched: () => true, midNow: () => undefined, priceAt });
      const m1 = all["1m"]!.slice(Math.max(0, lastIdx(all["1m"]!, now, MIN) - 300), lastIdx(all["1m"]!, now, MIN));
      const m5 = all["5m"]!.slice(Math.max(0, lastIdx(all["5m"]!, now, 5 * MIN) - 300), lastIdx(all["5m"]!, now, 5 * MIN));
      t.forecast({ instrument: { symbol: "SYN", assetClass: "crypto" }, candles: { "1m": m1, "5m": m5 }, now, mid: m1[m1.length - 1].close, costPct: 0.0005 });
    }
    const w = t.model(15 * MIN, "crypto");
    expect(w.w.trend).toBeGreaterThan(0.3);
    const recs = store.listForecastOutcomes({}).filter((r) => r.outcome === "up" || r.outcome === "down");
    // 方向の当たり。flat の予想 (|pUp − 0.5| < 0.05、実力なし) は半分の当たりとみなす
    const acc = (rs: typeof recs) => rs.reduce((a, r) => a + (r.direction === "flat" ? 0.5 : (r.direction === r.outcome) ? 1 : 0), 0) / rs.length;
    const early = recs.slice(0, 60);
    const late = recs.slice(-1000);
    expect(acc(early)).toBeLessThan(0.62);
    expect(acc(late)).toBeGreaterThan(acc(early) + 0.05);
    expect(acc(late)).toBeGreaterThan(0.6);
    // 集計の的中率 (方向の予想 × 方向の結果) も 50% を上回り、反映の条件を満たす
    const s = t.summary(T0 + N * MIN);
    const g = s.byClass.find((x) => x.horizon === "15m" && x.assetClass === "crypto")!;
    expect(g.n).toBeGreaterThan(100);
    expect(g.hitRate).toBeGreaterThan(0.55);
    expect(g.live).toBe(true);
    // Brier は後半の方が良い (小さい)
    const brier = (rs: typeof recs) => rs.reduce((a, r) => a + (r.pUp - (r.outcome === "up" ? 1 : 0)) ** 2, 0) / rs.length;
    expect(brier(late)).toBeLessThan(brier(early));
  });
});

describe("取引への反映の倍率", () => {
  const o = DEFAULT_FORECAST_OPTIONS;
  it("実力が確かめられていなければ 1.0。一致は最大 1.2 倍、逆は最大 0.7 倍 (強さに比例)", () => {
    expect(forecastSizeMultiplier("long", { direction: "up", pUp: 0.9 }, false, o)).toBe(1);
    expect(forecastSizeMultiplier("long", undefined, true, o)).toBe(1);
    expect(forecastSizeMultiplier("long", { direction: "flat", pUp: 0.52 }, true, o)).toBe(1);
    expect(forecastSizeMultiplier("long", { direction: "up", pUp: 1 }, true, o)).toBeCloseTo(1.2, 9);
    expect(forecastSizeMultiplier("short", { direction: "down", pUp: 0 }, true, o)).toBeCloseTo(1.2, 9);
    expect(forecastSizeMultiplier("long", { direction: "down", pUp: 0 }, true, o)).toBeCloseTo(0.7, 9);
    expect(forecastSizeMultiplier("short", { direction: "up", pUp: 1 }, true, o)).toBeCloseTo(0.7, 9);
    expect(forecastSizeMultiplier("long", { direction: "up", pUp: 0.75 }, true, o)).toBeCloseTo(1.1, 9);
    expect(forecastSizeMultiplier("long", { direction: "down", pUp: 0.25 }, true, o)).toBeCloseTo(0.85, 9);
    for (let p = 0; p <= 1; p += 0.01) {
      for (const sig of ["long", "short"] as const) {
        const m = forecastSizeMultiplier(sig, { direction: classifyForecast(p, 0.05), pUp: p }, true, o);
        expect(m).toBeGreaterThanOrEqual(0.7 - 1e-12);
        expect(m).toBeLessThanOrEqual(1.2 + 1e-12);
      }
    }
  });

  it("戦略の時間軸に合う予想時間 (scalp → 15 分、short → 1 時間、mid / long → 4 時間)", () => {
    const hs = DEFAULT_FORECAST_OPTIONS.horizonsMs;
    expect(horizonForStrategy("scalp", hs)).toBe(15 * MIN);
    expect(horizonForStrategy("short", hs)).toBe(HOUR);
    expect(horizonForStrategy("mid", hs)).toBe(4 * HOUR);
    expect(horizonForStrategy("long", hs)).toBe(4 * HOUR);
    expect(horizonForStrategy("short", [30 * MIN, 2 * HOUR])).toBe(30 * MIN);
  });

  it("multiplierFor: 統計で実力が確かめられた (時間, 資産クラス) だけ倍率を返す", () => {
    const store = new MemoryStore();
    const closes = randomWalk(400, 5);
    const now = T0 + 400 * MIN;
    const day = String(Math.floor(now / 86_400_000) * 86_400_000);
    // 重み 0・バイアス 1 → pUp = sigmoid(1) で必ず up
    store.kvSet("forecast:model:paper", { "15m|crypto": { w: { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 0 }, b: 1, updates: 0 } });
    const t = new ForecastTracker({ store, mode: "paper" });
    t.forecast({ instrument: { symbol: "BTC/USDT", assetClass: "crypto" }, candles: candlesFrom(closes), now, mid: closes[399] });
    const strength = (1 / (1 + Math.exp(-1)) - 0.5) * 2;
    expect(t.multiplierFor("BTC/USDT", "long", "scalp", now)).toMatchObject({ mult: 1, live: false, direction: "up" });

    // 判定済み 200 件・的中 130 件 (表示用) と、基礎モデルのクラスタ 300 個・的中の割合の合計 210 (z ≈ 6.8 / √3 ≈ 4.0 ≥ 2.64) を入れて再起動
    const cc = { n: 200, hits: 130, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 45, brierN: 200 };
    const bc = { n: 300, hits: 210, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 60, brierN: 300, cn: 300, cs: 210 };
    store.kvSet(forecastStatsKey("paper"), { days: { [day]: { "c|15m|crypto": cc, "b|15m|crypto": bc } }, recorded: 0, droppedCap: 0, droppedUnwatched: 0, learned: 0, sinceAudit: { judged: 0, hits: 0, n: 0, noise: 0, expired: 0 }, live: [] });
    const t2 = new ForecastTracker({ store, mode: "paper" });
    t2.forecast({ instrument: { symbol: "BTC/USDT", assetClass: "crypto" }, candles: candlesFrom(closes), now, mid: closes[399] });
    expect(t2.multiplierFor("BTC/USDT", "long", "scalp", now).mult).toBeCloseTo(1 + 0.2 * strength, 9);
    expect(t2.multiplierFor("BTC/USDT", "short", "scalp", now).mult).toBeCloseTo(1 - 0.3 * strength, 9);
    // 1 時間の予想 (short 戦略) は実力未確認 (かつ初期の重み) → 1.0
    expect(t2.multiplierFor("BTC/USDT", "long", "short", now).mult).toBe(1);
    // 古い予想は使わない
    expect(t2.multiplierFor("BTC/USDT", "long", "scalp", now + 11 * MIN)).toMatchObject({ mult: 1 });
    // 別の資産クラスは未確認
    expect(t2.multiplierFor("ETH/USDT", "long", "scalp", now).mult).toBe(1);
    expect(t2.statusFor("BTC/USDT", now)!.horizons.find((h) => h.horizon === "15m")).toMatchObject({ live: true, n: 200, hitRate: 0.65, direction: "up" });
  });
});

describe("永続化と上限", () => {
  it("未判定の予想・重み・集計は再起動 (同じ store で作り直し) 後も続く。mode 別に分かれる", () => {
    const store = new SqliteStore(":memory:");
    try {
      const closes = randomWalk(400, 9);
      const now = T0 + 400 * MIN;
      const a = new ForecastTracker({ store, mode: "paper" });
      a.forecast({ instrument: { symbol: "BTC/USDT", assetClass: "crypto" }, candles: candlesFrom(closes), now, mid: closes[399] });
      a.flush();
      const ids = a.listPending().map((p) => p.id).sort();
      expect(ids).toHaveLength(3);

      const b = new ForecastTracker({ store, mode: "paper" });
      expect(b.listPending().map((p) => p.id).sort()).toEqual(ids);
      expect(new ForecastTracker({ store, mode: "live" }).listPending()).toHaveLength(0);
      // 判定 → 学習 → 保存
      b.evaluate(now + 15 * MIN, { isWatched: () => true, midNow: () => closes[399] * 1.05 });
      b.flush();
      const c = new ForecastTracker({ store, mode: "paper" });
      expect(c.listPending()).toHaveLength(2);
      expect(c.model(15 * MIN, "crypto").updates).toBe(1);
      expect(c.summary(now + 15 * MIN).byClass.find((g) => g.horizon === "15m")).toMatchObject({ brierN: 1 });
      expect(store.listForecastOutcomes({ mode: "paper" })).toHaveLength(1);
      expect(loadForecastSummary(store, now + 15 * MIN).recorded).toBe(3);
    } finally {
      store.close();
    }
  });

  it("未判定は 2,000 件まで (古い順に捨てる)", () => {
    const store = new MemoryStore();
    const t = new ForecastTracker({ store, mode: "paper" });
    const closes = randomWalk(300, 4);
    const c = candlesFrom(closes, T0, ["1m", "5m"]);
    for (let i = 0; i < 700; i++) {
      t.forecast({ instrument: { symbol: "S" + (i % 7), assetClass: "crypto" }, candles: c, now: T0 + 300 * MIN + i, mid: closes[299] });
    }
    t.flush();
    const p = t.listPending();
    expect(p).toHaveLength(2_000);
    // 2,100 件中、古い 100 件 (33 回分 = 99 件と 34 回目の 1 件) を捨てた
    expect(Math.min(...p.map((x) => x.madeAt))).toBe(T0 + 300 * MIN + 33);
    expect(p.filter((x) => x.madeAt === T0 + 300 * MIN + 33)).toHaveLength(2);
    expect(store.kvGet<unknown[]>(forecastPendingKey("paper"))).toHaveLength(2_000);
    expect(t.summary(T0 + 300 * MIN).droppedCap).toBe(100);
  });

  it("判定済みの記録は 30 日で消し、集計の窓からも外れる", () => {
    const store = new MemoryStore();
    store.kvSet(forecastPendingKey("paper"), [pending({ id: "old", pUp: 0.8, dir: "up" })]);
    const t = new ForecastTracker({ store, mode: "paper" });
    t.evaluate(T0 + 15 * MIN, { isWatched: () => true, midNow: () => 105 });
    expect(store.listForecastOutcomes({})).toHaveLength(1);
    expect(t.summary(T0 + 20 * MIN).byClass[0].n).toBe(1);
    const later = T0 + 32 * 86_400_000;
    t.evaluate(later, { isWatched: () => true, midNow: () => 105 });
    expect(store.listForecastOutcomes({})).toHaveLength(0);
    expect(t.summary(later).byClass).toHaveLength(0);
  });

  it("監査ログには要約と反映状態の変化だけを残す", () => {
    const store = new MemoryStore();
    // 基礎モデルの予想 (pb / db) つき。5 分ごとに出した予想 (= 別々のクラスタ)
    const many = Array.from({ length: 150 }, (_, i) => pending({ id: "p" + i, pUp: 0.8, dir: "up", pb: 0.8, db: "up", madeAt: T0 + 5 * MIN - i * 5 * MIN }));
    store.kvSet(forecastPendingKey("paper"), many);
    const t = new ForecastTracker({ store, mode: "paper", options: { auditEveryMs: HOUR } });
    const d = { isWatched: () => true, midNow: () => 105, priceAt: () => 105 };
    t.evaluate(T0 + 10 * MIN, d); // 148 件判定 (要約は起点だけ記録)
    t.evaluate(T0 + 20 * MIN, d); // 残り 2 件 (計 150 件、全部的中)
    t.evaluate(T0 + 80 * MIN, d);
    const types = store.listAudit({}).map((a) => a.type);
    expect(types.filter((x) => x === "learning.forecast_live")).toHaveLength(1);
    expect(types.filter((x) => x === "learning.forecast_summary")).toHaveLength(1);
    expect(types.every((x) => x.startsWith("learning.forecast_"))).toBe(true);
    const sum = store.listAudit({ type: "learning.forecast_summary" })[0].data;
    expect(sum).toMatchObject({ judged: 150, n: 150, hits: 150 });
  });
});
