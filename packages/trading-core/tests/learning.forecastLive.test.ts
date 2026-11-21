/**
 * 予想の LIVE 判定 (round 3):
 * 3. クラスタ単位 (同じ間隔・同じ資産クラスの予想を 1 観測)・Bonferroni 補正・ヒステリシス
 * 4. 戦略の合意 (consensus) の循環: 取引に使う予想と LIVE の判定は consensus を除いた基礎モデル、適用した予想 (markApplied) の別集計
 */
import { describe, expect, it } from "vitest";
import type { Candle, Timeframe } from "../src/core/types";
import {
  clusterZ, DEFAULT_FORECAST_OPTIONS, forecastBaseModelKey, forecastModelKey, forecastPendingKey, forecastStatsKey, ForecastTracker, LIVE_RULE,
  liveDecision, liveThresholds, normalQuantile, type ForecastCounts, type PendingForecast,
} from "../src/learning/forecast";
import { normalCdf } from "../src/learning/stats";
import { MemoryStore } from "../src/storage/memory";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5);
const DAY = String(Math.floor(T0 / 86_400_000) * 86_400_000);

const counts = (o: Partial<ForecastCounts>): ForecastCounts => ({ n: 0, hits: 0, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 0, brierN: 0, ...o });
const pending = (o: Partial<PendingForecast> & Pick<PendingForecast, "id">): PendingForecast => ({
  symbol: "BTC/USDT", assetClass: "crypto", horizonMs: 15 * MIN, madeAt: T0, mid0: 100, pUp: 0.8, dir: "up", f: [0, 0, 0, 0, 0],
  atrPctPerMin: 0.0001, costPct: 0.0001, pb: 0.8, db: "up", ...o,
});
const statsWith = (groups: Record<string, ForecastCounts>, extra: Record<string, unknown> = {}) => ({
  days: { [DAY]: groups }, recorded: 0, droppedCap: 0, droppedUnwatched: 0, learned: 0, sinceAudit: { judged: 0, hits: 0, n: 0, noise: 0, expired: 0 }, live: [], ...extra,
});

function candles(n: number, start = T0): Partial<Record<Timeframe, Candle[]>> {
  const m1: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    p *= 1 + 0.0005 * Math.sin(i / 7);
    m1.push({ ts: start + i * MIN, open: o, high: Math.max(o, p) * 1.0002, low: Math.min(o, p) * 0.9998, close: p, volume: 1 });
  }
  const m5: Candle[] = [];
  for (let i = 0; i + 5 <= m1.length; i += 5) {
    const g = m1.slice(i, i + 5);
    m5.push({ ts: g[0].ts, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[4].close, volume: 5 });
  }
  return { "1m": m1, "5m": m5 };
}

describe("3. LIVE の判定: Bonferroni 補正・ヒステリシス・クラスタ単位", () => {
  it("正規分布の関数と閾値: 既定は 12 グループで片側 α = 0.05 / 12 → z ≈ 2.64、止めるのは 2.14 未満", () => {
    expect(normalCdf(1.645)).toBeCloseTo(0.95, 3);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6449, 3);
    expect(normalQuantile(1 - 0.05 / 12)).toBeCloseTo(2.638, 2);
    const th = liveThresholds(DEFAULT_FORECAST_OPTIONS);
    expect(th.groups).toBe(12);
    expect(th.zOn).toBeCloseTo(2.638, 2);
    expect(th.zOff).toBeCloseTo(th.zOn - 0.5, 10);
    expect(liveThresholds({ ...DEFAULT_FORECAST_OPTIONS, liveGroups: 1 }).zOn).toBeCloseTo(1.645, 2);
  });

  it("ヒステリシス: 入るのは z ≥ zOn、LIVE 中は z ≥ zOff なら続ける", () => {
    const o = DEFAULT_FORECAST_OPTIONS;
    const th = liveThresholds(o);
    // z = (cs − 0.5 − cn/2) / √(cn/4)。cn = 400 → z = (cs − 200.5) / 10
    const base = (cs: number) => counts({ n: 400, hits: Math.round(cs), cn: 400, cs });
    expect(clusterZ(base(225.5))).toBeCloseTo(2.5, 10);
    expect(liveDecision(false, base(225.5), undefined, 1, o, th)).toBe(false); // 2.5 < 2.64
    expect(liveDecision(true, base(225.5), undefined, 1, o, th)).toBe(true); // 2.5 ≥ 2.14
    expect(liveDecision(true, base(220.5), undefined, 1, o, th)).toBe(false); // 2.0 < 2.14
    expect(liveDecision(false, base(230.5), undefined, 1, o, th)).toBe(true); // 3.0
    // 件数が minSamples 未満なら入らない
    expect(liveDecision(false, counts({ n: 99, hits: 99, cn: 99, cs: 99 }), undefined, 1, o, th)).toBe(false);
  });

  it("同じ間隔に出した同じ資産クラスの 3 銘柄 (同じ動き) は 1 クラスタとして数える", () => {
    const store = new MemoryStore();
    const syms = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];
    const ps: PendingForecast[] = [];
    for (let k = 0; k < 10; k++) {
      for (const [i, symbol] of syms.entries()) ps.push(pending({ id: `p${k}_${i}`, symbol, madeAt: T0 + k * 5 * MIN + i * 1000 }));
    }
    store.kvSet(forecastPendingKey("paper"), ps);
    const t = new ForecastTracker({ store, mode: "paper" });
    // 2 回目以降の判定では、同じクラスタの残りの銘柄が後から来ても同じクラスタに足す
    t.evaluate(T0 + 15 * MIN + 500, { isWatched: () => true, midNow: () => 105 });
    t.evaluate(T0 + 3 * HOUR, { isWatched: () => true, midNow: () => 105, priceAt: () => 105 });
    const g = t.summary(T0 + 3 * HOUR).byClass.find((x) => x.horizon === "15m" && x.assetClass === "crypto")!;
    expect(g.n).toBe(30);
    expect(g.base).toMatchObject({ n: 30, hits: 30, clusters: 10 });
    // 銘柄の半分だけ当たったクラスタは 0.5 として数える
    const store2 = new MemoryStore();
    store2.kvSet(forecastPendingKey("paper"), [
      pending({ id: "a", symbol: "BTC/USDT" }), pending({ id: "b", symbol: "ETH/USDT", db: "down", pb: 0.2 }),
    ]);
    const t2 = new ForecastTracker({ store: store2, mode: "paper" });
    t2.evaluate(T0 + 15 * MIN, { isWatched: () => true, midNow: () => 105 });
    t2.flush();
    const st = store2.kvGet<{ days: Record<string, Record<string, ForecastCounts>> }>(forecastStatsKey("paper"))!;
    const b = Object.values(st.days)[0]["b|15m|crypto"];
    expect(b).toMatchObject({ n: 2, hits: 1, cn: 1 });
    expect(b.cs).toBeCloseTo(0.5, 10);
  });

  it("保存済みの集計 (基礎モデルの集計なし) や旧規則の live は使わない (より保守的)", () => {
    const store = new MemoryStore();
    // 旧方式なら LIVE (z ≈ 4.2) の集計と、旧規則で LIVE だった記録
    store.kvSet(forecastStatsKey("paper"), statsWith({ "c|15m|crypto": counts({ n: 200, hits: 130 }) }, { live: ["15m|crypto"] }));
    const t = new ForecastTracker({ store, mode: "paper" });
    expect(t.skill(15 * MIN, "crypto", T0).live).toBe(false);
    t.evaluate(T0, { isWatched: () => true, midNow: () => undefined });
    t.flush();
    expect(store.kvGet(forecastStatsKey("paper"))).toMatchObject({ live: [], liveRule: LIVE_RULE });
    expect(store.listAudit({ type: "learning.forecast_live" })[0].data).toMatchObject({ horizon: "15m", assetClass: "crypto", live: false });
  });
});

describe("4. 戦略の合意 (consensus) の循環を避ける", () => {
  it("取引に使う予想は consensus を除いた基礎モデル。consensus がいくら強くても倍率は変わらない", () => {
    const store = new MemoryStore();
    // 全特徴量のモデルは consensus だけに重み 3、基礎モデルはバイアス 1 だけ (pUp = sigmoid(1) で up)
    store.kvSet(forecastModelKey("paper"), { "15m|crypto": { w: { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 3 }, b: 0, updates: 10 } });
    store.kvSet(forecastBaseModelKey("paper"), { "15m|crypto": { w: { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 0 }, b: 1, updates: 10 } });
    store.kvSet(forecastStatsKey("paper"), statsWith({ "b|15m|crypto": counts({ n: 300, hits: 210, cn: 300, cs: 210 }) }));
    const t = new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN] } });
    const now = T0 + 400 * MIN;
    const mk = (consensus: number) =>
      t.forecast({ instrument: { symbol: "BTC/USDT", assetClass: "crypto" }, candles: candles(400), now, mid: 100, consensus: () => consensus })!;
    const strong = mk(-1);
    expect(strong.horizons[0].direction).toBe("down"); // 表示用の全特徴量のモデルは consensus に引っぱられる
    expect(strong.horizons[0].base).toMatchObject({ direction: "up" });
    const m1 = t.multiplierFor("BTC/USDT", "long", "scalp", now);
    mk(1);
    const m2 = t.multiplierFor("BTC/USDT", "long", "scalp", now);
    expect(m1.live).toBe(true);
    expect(m1.mult).toBeCloseTo(m2.mult, 12);
    expect(m1.mult).toBeCloseTo(1 + 0.2 * (1 / (1 + Math.exp(-1)) - 0.5) * 2, 9);
    expect(m1).toMatchObject({ direction: "up", horizonMs: 15 * MIN, madeAt: now });
    expect(t.statusFor("BTC/USDT", now)!.horizons[0]).toMatchObject({ direction: "up", baseDirection: "up" });
  });

  it("基礎モデルが無ければ全特徴量のモデルから consensus を除いて始め、判定のたびに別に学習する", () => {
    const store = new MemoryStore();
    store.kvSet(forecastModelKey("paper"), { "15m|crypto": { w: { trend: 0.5, momentum: 0, meanRevert: 0, news: 0, consensus: 2 }, b: 0.3, updates: 5 } });
    const t = new ForecastTracker({ store, mode: "paper" });
    expect(t.baseModel(15 * MIN, "crypto")).toMatchObject({ b: 0.3, updates: 0, w: { trend: 0.5, consensus: 0 } });
    store.kvSet(forecastPendingKey("paper"), [pending({ id: "x", f: [0.5, 0, 0, 0, 1] })]);
    const t2 = new ForecastTracker({ store, mode: "paper" });
    t2.evaluate(T0 + 15 * MIN, { isWatched: () => true, midNow: () => 105 });
    t2.flush();
    const bm = store.kvGet<Record<string, { w: Record<string, number>; updates: number }>>(forecastBaseModelKey("paper"))!["15m|crypto"];
    expect(bm.updates).toBe(1);
    expect(bm.w.consensus).toBe(0);
    expect(store.kvGet<Record<string, { updates: number }>>(forecastModelKey("paper"))!["15m|crypto"].updates).toBe(6);
  });

  it("markApplied: シグナルと同じ向きで発注に使われた予想を別に集計し、そこで効いていなければ LIVE を止める", () => {
    const store = new MemoryStore();
    store.kvSet(forecastBaseModelKey("paper"), { "15m|crypto": { w: { trend: 0, momentum: 0, meanRevert: 0, news: 0, consensus: 0 }, b: 1, updates: 10 } });
    // 基礎モデルの集計は有意 (z ≈ 4)。適用した予想は 40 件中 15 件しか当たっていない
    const groups = { "b|15m|crypto": counts({ n: 300, hits: 210, cn: 300, cs: 210 }) };
    store.kvSet(forecastStatsKey("paper"), statsWith(groups));
    const t = new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN] } });
    const now = T0 + 400 * MIN;
    t.forecast({ instrument: { symbol: "BTC/USDT", assetClass: "crypto" }, candles: candles(400), now, mid: 100 });
    expect(t.multiplierFor("BTC/USDT", "long", "scalp", now).live).toBe(true);
    // 逆向き (short) は記録しない。同じ向き (long) は 1 回だけ記録する
    expect(t.markApplied("BTC/USDT", "short", "scalp", now)).toBe(false);
    expect(t.markApplied("BTC/USDT", "long", "scalp", now)).toBe(true);
    expect(t.markApplied("BTC/USDT", "long", "scalp", now)).toBe(true);
    expect(t.listPending().filter((p) => p.ap === 1)).toHaveLength(1);
    // 古い予想・別の銘柄は記録しない
    expect(t.markApplied("BTC/USDT", "long", "scalp", now + 11 * MIN)).toBe(false);
    expect(t.markApplied("ETH/USDT", "long", "scalp", now)).toBe(false);
    // 判定: 適用した予想が外れる (下落)
    t.evaluate(now + 15 * MIN, { isWatched: () => true, midNow: () => 90 });
    const g = t.summary(now + 15 * MIN).byClass.find((x) => x.horizon === "15m")!;
    expect(g.applied).toMatchObject({ n: 1, hits: 0, clusters: 1 });

    // 適用した予想が minAppliedSamples 件以上で 50% を上回っていなければ LIVE にしない
    const bad = { ...groups, "a|15m|crypto": counts({ n: 40, hits: 15, cn: 40, cs: 15 }) };
    store.kvSet(forecastStatsKey("paper"), statsWith(bad));
    const t2 = new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN] } });
    expect(t2.skill(15 * MIN, "crypto", now).live).toBe(false);
    // 件数が足りない間・効いている間は基礎モデルの判定どおり
    store.kvSet(forecastStatsKey("paper"), statsWith({ ...groups, "a|15m|crypto": counts({ n: 20, hits: 5, cn: 20, cs: 5 }) }));
    expect(new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN] } }).skill(15 * MIN, "crypto", now).live).toBe(true);
    store.kvSet(forecastStatsKey("paper"), statsWith({ ...groups, "a|15m|crypto": counts({ n: 40, hits: 28, cn: 40, cs: 28 }) }));
    expect(new ForecastTracker({ store, mode: "paper", options: { horizonsMs: [15 * MIN] } }).skill(15 * MIN, "crypto", now).live).toBe(true);
  });
});
