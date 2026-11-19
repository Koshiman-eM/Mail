import { describe, expect, it, vi } from "vitest";
import type { ShadowTradeRecord } from "../src/core/types";
import { StrategyAllocator, armKey } from "../src/learning/allocator";
import { LearningService } from "../src/learning/service";
import {
  ShadowTracker, shadowCountersKey, shadowOpenKey, shadowR, summarizeShadowTrades, type ShadowRecordInput,
} from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
const q = (bid: number, ask: number) => ({ bid, ask });

/** 買い: ask 100.1 / bid 99.9 (仲値 100, スプレッド 0.2)、損切り 98.1 → 1R = 2、利確 104.1 */
function input(over: Partial<ShadowRecordInput> & { sig?: Partial<ShadowRecordInput["signal"]> } = {}): ShadowRecordInput {
  const { sig, ...rest } = over;
  return {
    instrument: inst,
    quote: q(99.9, 100.1),
    signal: {
      strategyId: "scalp_x", direction: "long", confidence: 0.7, expectedEdgeBps: 15, stopLoss: 98.1, takeProfit: 104.1, maxHoldMs: 10 * MIN, horizon: "scalp",
      ...(sig ?? {}),
    },
    regime: "range",
    reason: "risk: 期待値幅 #bps < コスト #bps × #",
    now: T0,
    ...rest,
  };
}

const tracker = (store = new MemoryStore(), opts: ConstructorParameters<typeof ShadowTracker>[0]["options"] = {}, onClosed?: (t: ShadowTradeRecord) => void) =>
  new ShadowTracker({ store, mode: "paper", options: opts, ...(onClosed ? { onClosed } : {}) });

describe("ShadowTracker (見送ったシグナルの仮想トレード)", () => {
  it("記録: エントリーは買いなら ask・売りなら bid、1R = |エントリー − 損切り|", () => {
    const tr = tracker();
    expect(tr.record(input())).toBe(true);
    expect(tr.record(input({ sig: { strategyId: "short_y", direction: "short", stopLoss: 101.9, takeProfit: 96 } }))).toBe(true);
    const [l, s] = tr.list();
    expect(l).toMatchObject({ direction: "long", entryPrice: 100.1, entryMid: 100, risk: 2, reason: "risk: 期待値幅 #bps < コスト #bps × #", mode: "paper", regime: "range" });
    expect(l.entrySpread).toBeCloseTo(0.2, 10);
    expect(s).toMatchObject({ direction: "short", entryPrice: 99.9 });
    expect(s.risk).toBeCloseTo(2, 10);
    // flat・損切りが逆側は記録しない
    expect(tr.record(input({ sig: { strategyId: "z", direction: "flat" } }))).toBe(false);
    expect(tr.record(input({ sig: { strategyId: "z", stopLoss: 100.5 } }))).toBe(false);
    expect(tr.stats().invalid).toBe(1);
  });

  it("利確で閉じ、往復手数料・スプレッド・約定ずれ (片道 2bps) を差し引いた純 R になる", () => {
    const closed: ShadowTradeRecord[] = [];
    const tr = tracker(new MemoryStore(), {}, (t) => closed.push(t));
    tr.record(input());
    expect(tr.update(T0 + MIN, () => q(102, 102.2))).toEqual([]); // 未到達
    const res = tr.update(T0 + 2 * MIN, () => q(104.2, 104.4)); // bid ≥ 104.1
    expect(res).toHaveLength(1);
    const r = res[0];
    expect(r.exitReason).toBe("take_profit");
    expect(r.exitPrice).toBe(104.1);
    // gross = (104.1 − 100) / 2 = 2.05
    expect(r.grossR).toBeCloseTo(2.05, 10);
    // cost = (0.001 × (100 + 104.1) + 0.2 + 0.0002 × (100 + 104.1)) / 2
    const cost = (0.001 * 204.1 + 0.2 + 0.0002 * 204.1) / 2;
    expect(r.costR).toBeCloseTo(cost, 10);
    expect(r.netR).toBeCloseTo(2.05 - cost, 10);
    expect(r.netR).toBeLessThan(r.grossR);
    expect(r.mfeR).toBeCloseTo((104.3 - 100) / 2, 10);
    expect(closed).toEqual(res);
    expect(tr.size).toBe(0);
    // 約定ずれのオプション
    const r0 = shadowR({ direction: "long", entryMid: 100, entrySpread: 0.2, risk: 2, takerFeeRate: 0.001, slippageBps: 0 }, 104.1);
    const r10 = shadowR({ direction: "long", entryMid: 100, entrySpread: 0.2, risk: 2, takerFeeRate: 0.001, slippageBps: 10 }, 104.1);
    expect(r10.netR).toBeCloseTo(r0.netR - (0.001 * 204.1) / 2, 10);
    const tr2 = tracker(new MemoryStore(), { slippageBps: 10 });
    tr2.record(input());
    expect(tr2.list()[0].slippageBps).toBe(10);
  });

  it("損切りは決済側 (買い: bid / 売り: ask) で判定する。窓開けで越えたら仲値", () => {
    const tr = tracker();
    tr.record(input());
    tr.record(input({ sig: { strategyId: "short_y", direction: "short", stopLoss: 101.9, takeProfit: 96 } }));
    // 仲値 98.2 は損切り 98.1 より上だが bid 98.05 ≤ 98.1 → 買いは損切り。売りは ask 98.35 で利確に届かない
    const res = tr.update(T0 + MIN, () => q(98.05, 98.35));
    expect(res.map((r) => [r.direction, r.exitReason])).toEqual([["long", "stop"]]);
    expect(res[0].exitPrice).toBe(98.1);
    const cost = (0.001 * 198.1 + 0.2 + 0.0002 * 198.1) / 2;
    expect(res[0].netR).toBeCloseTo((98.1 - 100) / 2 - cost, 10);
    // 売り: ask ≥ 101.9 で損切り。窓開け (仲値 103 > 101.9) なら仲値で閉じる
    const res2 = tr.update(T0 + 2 * MIN, () => q(102.9, 103.1));
    expect(res2[0]).toMatchObject({ direction: "short", exitReason: "stop", exitPrice: 103 });
    expect(res2[0].grossR).toBeCloseTo(-(103 - 100) / 2, 10);
  });

  it("同じ判定で損切りと利確の両方に届きうる場合は損切りを先にする", () => {
    const tr = tracker();
    tr.record(input());
    // 前回以降の 1m 足が 97〜105 (両方に届く)、現在の気配は中立
    const res = tr.update(T0 + 2 * MIN, () => q(100, 100.2), { rangeOf: () => ({ high: 105, low: 97, lastCandleTs: T0 + MIN }) });
    expect(res).toHaveLength(1);
    expect(res[0].exitReason).toBe("stop");
    expect(res[0].netR).toBeLessThan(-1);
    expect(res[0].maeR).toBeGreaterThan(1);
    expect(res[0].mfeR).toBeGreaterThan(2);
  });

  it("時間切れは仲値で閉じる", () => {
    const tr = tracker();
    tr.record(input());
    expect(tr.update(T0 + 9 * MIN, () => q(100.9, 101.1))).toEqual([]);
    const res = tr.update(T0 + 10 * MIN, () => q(100.9, 101.1));
    expect(res[0]).toMatchObject({ exitReason: "time", exitPrice: 101, exitTs: T0 + 10 * MIN });
    expect(res[0].grossR).toBeCloseTo(0.5, 10);
  });

  it("重複 (同じ銘柄・戦略・方向で未決済あり) は作らない。決済後は再び作れる", () => {
    const tr = tracker();
    expect(tr.record(input())).toBe(true);
    expect(tr.record(input({ now: T0 + 1000 }))).toBe(false);
    expect(tr.record(input({ sig: { direction: "short", stopLoss: 101.9, takeProfit: 96 } }))).toBe(true); // 方向が違う
    expect(tr.record(input({ sig: { strategyId: "other" } }))).toBe(true); // 戦略が違う
    expect(tr.size).toBe(3);
    expect(tr.stats().duplicate).toBe(1);
    tr.update(T0 + MIN, () => q(104.2, 104.4));
    expect(tr.record(input({ now: T0 + 2 * MIN }))).toBe(true);
  });

  it("上限: 未決済の最大件数と 1 分あたりの作成数を超えた分は捨てる", () => {
    const tr = tracker(new MemoryStore(), { maxOpen: 3, maxPerMinute: 100 });
    for (let i = 0; i < 5; i++) tr.record(input({ sig: { strategyId: `s${i}` } }));
    expect(tr.size).toBe(3);
    expect(tr.stats().droppedCap).toBe(2);

    const tr2 = tracker(new MemoryStore(), { maxOpen: 100, maxPerMinute: 2 });
    for (let i = 0; i < 4; i++) tr2.record(input({ sig: { strategyId: `s${i}` }, now: T0 + i * 1000 }));
    expect(tr2.size).toBe(2);
    expect(tr2.stats().droppedRate).toBe(2);
    expect(tr2.record(input({ sig: { strategyId: "late" }, now: T0 + 61_000 }))).toBe(true);
    // 既定は 200 件・30 件/分
    expect(tracker().opts).toMatchObject({ maxOpen: 200, maxPerMinute: 30, slippageBps: 2 });
  });

  it("再起動後も続く (未決済は kv shadow:open:<mode> に保存)", () => {
    const store = new MemoryStore();
    const tr = tracker(store);
    tr.record(input());
    tr.update(T0 + MIN, () => q(101, 101.2)); // 未決済のまま MFE を更新
    expect(store.kvGet<unknown[]>(shadowOpenKey("paper"))).toHaveLength(1);
    expect(store.kvGet(shadowOpenKey("live"))).toBeUndefined();
    expect(store.kvGet(shadowCountersKey("paper"))).toMatchObject({ created: 1 });

    const closed: ShadowTradeRecord[] = [];
    const tr2 = tracker(store, {}, (t) => closed.push(t));
    expect(tr2.list()).toEqual(tr.list());
    expect(tr2.record(input({ now: T0 + 2 * MIN }))).toBe(false); // 復元後も重複を防ぐ
    tr2.update(T0 + 3 * MIN, () => q(104.2, 104.4));
    expect(closed).toHaveLength(1);
    expect(closed[0].mfeR).toBeGreaterThan(0.5);
    expect(store.kvGet<unknown[]>(shadowOpenKey("paper"))).toEqual([]);
    // live の tracker は paper の分を読まない
    expect(new ShadowTracker({ store, mode: "live" }).size).toBe(0);
  });

  it("監視をやめた銘柄の仮想トレードは捨てる (学習に渡さない)", () => {
    const onClosed = vi.fn();
    const tr = tracker(new MemoryStore(), {}, onClosed);
    tr.record(input());
    expect(tr.update(T0 + MIN, () => q(104.2, 104.4), { isWatched: () => false })).toEqual([]);
    expect(onClosed).not.toHaveBeenCalled();
    expect(tr.size).toBe(0);
    expect(tr.stats().unwatched).toBe(1);
  });

  it("学習側の例外は握りつぶす (update は例外を投げない)", () => {
    const onError = vi.fn();
    const tr = new ShadowTracker({ store: new MemoryStore(), mode: "paper", onClosed: () => { throw new Error("boom"); }, onError });
    tr.record(input());
    expect(() => tr.update(T0 + MIN, () => q(104.2, 104.4))).not.toThrow();
    expect(onError).toHaveBeenCalledWith("shadow.onClosed", expect.any(Error));
    expect(tr.size).toBe(0);
  });

  it("集計: 見送り理由ごと・戦略ごとの件数・勝率・平均の純 R", () => {
    const base = (id: string, reason: string, strategyId: string, netR: number) =>
      ({ id, reason, strategyId, netR, exitReason: netR > 0 ? "take_profit" : "stop" }) as ShadowTradeRecord;
    const s = summarizeShadowTrades([base("1", "direction_bias", "a", 1), base("2", "direction_bias", "b", -1), base("3", "direction_bias", "a", 2), base("4", "arm_disabled", "a", -0.5)]);
    expect(s.closed).toBe(4);
    expect(s.winRate).toBe(0.5);
    expect(s.avgNetR).toBeCloseTo(0.375, 10);
    expect(s.byReason[0]).toMatchObject({ key: "direction_bias", n: 3, wins: 2 });
    expect(s.byReason[0].avgNetR).toBeCloseTo(2 / 3, 10);
    expect(s.byStrategy[0]).toMatchObject({ key: "a", n: 3, wins: 2, avgNetR: 2.5 / 3 });
    expect(s.byReasonStrategy.find((g) => g.key === "direction_bias / a")).toMatchObject({ n: 2, wins: 2, avgNetR: 1.5 });
    expect(s.exitReasons).toEqual({ take_profit: 2, stop: 2 });
  });
});

const shadowRec = (netR: number, over: Partial<ShadowTradeRecord> = {}): ShadowTradeRecord => ({
  id: `sh-${Math.random()}`, mode: "paper", symbol: "BTC/USDT", assetClass: "crypto", strategyId: "scalp_x", horizon: "scalp", regime: "range",
  direction: "long", reason: "direction_bias", confidence: 0.6, expectedEdgeBps: 20, entryTs: T0, entryPrice: 100.1, entryMid: 100, entrySpread: 0.2,
  stopLoss: 98.1, maxHoldMs: 600_000, takerFeeRate: 0.001, slippageBps: 2, exitTs: T0 + MIN, exitPrice: 100, exitReason: netR > 0 ? "take_profit" : "stop",
  grossR: netR, costR: 0, netR, mfeR: 0, maeR: 0, ...over,
});

const realTrade = (r: number) =>
  ({
    id: `t-${Math.random()}`, strategyId: "scalp_x", assetClass: "crypto", exitTs: T0 + MIN, netPnl: r, returnPct: r / 100, rMultiple: r,
    entryContext: { regime: { label: "range" } },
  }) as never;

describe("StrategyAllocator: 仮想トレードによる重み付き更新", () => {
  const key = armKey("scalp_x", "range", "crypto");

  it("重み 0.25 で更新され、実際の取引 1 件より影響が小さい", () => {
    const real = new StrategyAllocator(new MemoryStore());
    const sh = new StrategyAllocator(new MemoryStore());
    expect(sh.opts.shadowWeight).toBe(0.25);
    real.update(realTrade(2));
    sh.updateShadow(shadowRec(2));
    const a = real.get(key)!;
    const b = sh.get(key)!;
    // ベータ分布: 勝ちで alpha に重みを足す (実 +1、仮想 +0.25)
    expect(a.alpha).toBeCloseTo(2 + 1, 10);
    expect(b.alpha).toBeCloseTo(2 + 0.25, 10);
    expect(b.beta).toBeCloseTo(2, 10);
    // 件数: 実際の取引の n は増えず、shadowN と重み付きの件数 wN が増える
    expect(b.n).toBe(0);
    expect(b.shadowN).toBe(1);
    expect(b.wN).toBeCloseTo(0.25, 10);
    // 縮小推定の期待 R・勝率・配分倍率の動きが小さい
    expect(sh.meanR(key)).toBeGreaterThan(0);
    expect(sh.meanR(key)).toBeLessThan(real.meanR(key));
    expect(sh.meanR(key)).toBeCloseTo((0.25 * 2) / (0.25 + 10), 10);
    expect(sh.winRate(key) - 0.5).toBeLessThan(real.winRate(key) - 0.5);
    expect(Math.abs(sh.weight(key) - 1)).toBeLessThan(Math.abs(real.weight(key) - 1));
    // 4 件の仮想 ≒ 実 1 件 (ベータ分布の加算量)
    for (let i = 0; i < 3; i++) sh.updateShadow(shadowRec(2));
    expect(sh.get(key)!.wN).toBeCloseTo(1, 10);
    // スナップショットで区別できる
    const snap = sh.snapshot()[0];
    expect(snap).toMatchObject({ key, n: 0, shadowN: 4, shadowWinRate: 1, shadowMeanR: 2, meanR: 0 });
  });

  it("重みはオプションで変えられる", () => {
    const al = new StrategyAllocator(new MemoryStore(), { shadowWeight: 0.5 });
    al.updateShadow(shadowRec(-1));
    expect(al.get(key)!.beta).toBeCloseTo(2.5, 10);
  });

  it("仮想の結果だけでは腕は止まらない (無効化の判定は実際の取引の件数だけ)", () => {
    const al = new StrategyAllocator(new MemoryStore());
    for (let i = 0; i < 500; i++) al.updateShadow(shadowRec(-1.5));
    expect(al.get(key)!.n).toBe(0);
    expect(al.upperConfidenceR(key)).toBeLessThan(0);
    expect(al.isDisabled(key)).toBe(false);
    expect(al.weight(key)).toBeGreaterThan(0);
    // 実際の取引が minSamplesToDisable に達して初めて止まりうる
    for (let i = 0; i < 29; i++) al.update(realTrade(-1));
    expect(al.isDisabled(key)).toBe(false);
    al.update(realTrade(-1));
    expect(al.get(key)!.n).toBe(30);
    expect(al.isDisabled(key)).toBe(true);
  });

  it("仮想トレードだけの旧データ互換: wN が無い状態は n を使う", () => {
    const store = new MemoryStore();
    store.kvSet(`arm:paper:${key}`, { key, alpha: 3, beta: 2, n: 1, sumR: 1, sumR2: 1, ewmaR: 1, ewmaVarR: 0, updatedAt: T0 });
    store.kvSet("arm:paper:index", [key]);
    const al = new StrategyAllocator(store);
    expect(al.meanR(key)).toBeCloseTo(1 / 11, 10);
    al.updateShadow(shadowRec(1));
    expect(al.get(key)!.wN).toBeCloseTo(1.25, 10);
  });
});

describe("LearningService: 仮想トレードの保存・腕の更新・集計", () => {
  it("onShadowClosed は保存して腕を重み付きで更新する。unwatched は使わない。snapshot に集計が出る", () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store });
    svc.onShadowClosed(shadowRec(1.5, { id: "a" }));
    svc.onShadowClosed(shadowRec(-1, { id: "b", reason: "arm_disabled" }));
    svc.onShadowClosed(shadowRec(3, { id: "c", exitReason: "unwatched" }));
    expect(store.listShadowTrades().map((t) => t.id)).toEqual(["a", "b"]);
    const arm = svc.allocator.get(armKey("scalp_x", "range", "crypto"))!;
    expect(arm.shadowN).toBe(2);
    expect(arm.n).toBe(0);
    store.kvSet(shadowOpenKey("paper"), [{}, {}]);
    const snap = svc.snapshot({ now: T0 + 2 * MIN });
    expect(snap.shadow).toMatchObject({ closed: 2, wins: 1, open: 2 });
    expect(snap.shadow.byReason.map((g) => g.key).sort()).toEqual(["arm_disabled", "direction_bias"]);
    expect(snap.arms[0]).toMatchObject({ shadowN: 2, n: 0 });
    expect(snap.news).toMatchObject({ pending: 0, recorded: 0 });
    // ParamTuner・要因分析には使わない
    expect(store.listAttributions()).toEqual([]);
  });

  it("periodic で保持期間より古い仮想トレードを消す", async () => {
    const store = new MemoryStore();
    const svc = new LearningService({ store, shadowRetentionMs: 10 * MIN, tuneEveryMs: 1e12, reflectEveryMs: 1e12 });
    svc.onShadowClosed(shadowRec(1, { id: "old", exitTs: T0 }));
    svc.onShadowClosed(shadowRec(1, { id: "new", exitTs: T0 + 20 * MIN }));
    store.kvSet("learning:paper:lastTune", T0 + 30 * MIN);
    store.kvSet("learning:paper:lastReflect", T0 + 30 * MIN);
    await svc.periodic(T0 + 25 * MIN);
    expect(store.listShadowTrades().map((t) => t.id)).toEqual(["new"]);
  });
});
