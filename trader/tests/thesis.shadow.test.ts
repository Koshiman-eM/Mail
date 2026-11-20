/** 仮想トレード (見送ったシグナル) の読みの管理: 実際の建玉と同じ src/engine/thesis.ts の規則で決済する */
import { describe, expect, it } from "vitest";
import type { ShadowTradeRecord } from "../src/core/types";
import { DEFAULT_THESIS_SETTINGS, THESIS_DISABLED, type ThesisSettings } from "../src/engine/thesis";
import { ShadowTracker, shadowOpenKey, type ShadowOpen, type ShadowRecordInput } from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";

const T0 = Date.UTC(2026, 0, 5);
const MIN = 60_000;
const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
const q = (bid: number, ask: number) => ({ bid, ask });
const ON: ThesisSettings = { ...DEFAULT_THESIS_SETTINGS };

/** 買い: ask 100.1 / bid 99.9 (仲値 100)、損切り 98.1 → 1R = 2、利確なし、最大保有 10 分 */
function input(sig: Partial<ShadowRecordInput["signal"]> = {}): ShadowRecordInput {
  return {
    instrument: inst,
    quote: q(99.9, 100.1),
    signal: { strategyId: "scalp_x", direction: "long", confidence: 0.7, expectedEdgeBps: 15, stopLoss: 98.1, maxHoldMs: 10 * MIN, horizon: "scalp", ...sig },
    regime: "range",
    reason: "lower_score",
    now: T0,
  };
}

const tracker = (thesis: ThesisSettings | undefined, store = new MemoryStore(), closed: ShadowTradeRecord[] = []) =>
  new ShadowTracker({ store, mode: "paper", options: thesis ? { thesis } : {}, onClosed: (t) => closed.push(t) });

/** エントリーの約定 (仲値 + 半スプレッド + 約定ずれ 1bps) と往復の手数料から、時間切れで決済したときの純 R */
const netRAt = (bid: number) => {
  const entry = 100 + 0.1 + 0.0001 * 100;
  const fill = bid * (1 - 0.0001);
  return (fill - entry - 0.001 * (entry + fill)) / 2;
};

describe("仮想トレードの読みの管理", () => {
  it("期限で利益が出ていなければ thesis_timeout (答え合わせの記録付き)", () => {
    const tr = tracker(ON);
    tr.record(input());
    expect(tr.list()[0].thesisExpectedMs).toBe(10 * MIN);
    expect(tr.update(T0 + 9 * MIN, () => q(100, 100.2))).toEqual([]);
    const [r] = tr.update(T0 + 10 * MIN, () => q(100, 100.2));
    expect(r).toMatchObject({ exitReason: "thesis_timeout", thesisOutcome: "timeout", thesisExpectedMs: 10 * MIN });
    expect(r.thesisNetRAtDeadline).toBeCloseTo(netRAt(100), 9);
    expect(r.netR).toBeCloseTo(netRAt(100), 9);
  });

  it("期限の半分を過ぎて −0.5R 以下なら途中で thesis_failed", () => {
    const tr = tracker(ON);
    tr.record(input());
    expect(tr.update(T0 + 4 * MIN, () => q(98.7, 98.9))).toEqual([]);
    const [r] = tr.update(T0 + 5 * MIN, () => q(98.7, 98.9));
    expect(r).toMatchObject({ exitReason: "thesis_failed", thesisOutcome: "failed_early" });
    expect(r.netR).toBeLessThan(-0.5);
  });

  it("期限で読み当たりなら延長し、前回までの高値 − 0.5R (建値より下にはしない) を割ったら trailing。延長は kv に残る", () => {
    const store = new MemoryStore();
    const closed: ShadowTradeRecord[] = [];
    const tr = tracker(ON, store, closed);
    tr.record(input());
    expect(tr.update(T0 + 10 * MIN, () => q(101.5, 101.7))).toEqual([]);
    const o = tr.list()[0];
    expect(o.thesisExtendedAt).toBe(T0 + 10 * MIN);
    expect(o.thesisNetRAtDeadline).toBeCloseTo(netRAt(101.5), 9);
    expect(store.kvGet<ShadowOpen[]>(shadowOpenKey("paper"))?.[0].thesisExtendedAt).toBe(T0 + 10 * MIN);
    // 再起動しても延長は続く (期限を過ぎていても決済しない)
    const tr2 = tracker(ON, store, closed);
    expect(tr2.update(T0 + 12 * MIN, () => q(101.6, 101.8))).toEqual([]);
    // 高値 (仲値) 101.7 − 1 = 100.7 を割る → trailing (窓開けなので現在の bid − 約定ずれで約定)
    const [r] = tr2.update(T0 + 13 * MIN, () => q(100.4, 100.6));
    expect(r).toMatchObject({ exitReason: "trailing", thesisOutcome: "extended", thesisExtendedAt: T0 + 10 * MIN });
    expect(r.exitPrice).toBeCloseTo(100.4 * (1 - 0.0001), 9);
    expect(closed).toHaveLength(1);
  });

  it("期限の前に +1.5R まで伸びて期限で +0.3R: 延長して持ち続ける。延長後の極値は延長した時刻以降の足と気配だけ", () => {
    const store = new MemoryStore();
    const tr = tracker(ON, store);
    tr.record(input());
    // 1m 足 (仲値): 延長より前に 103.2 まで (+1.5R 超)、延長後は 100.95 まで
    const candles = [
      { ts: T0 + 6 * MIN, high: 103.2, low: 103 },
      { ts: T0 + 10 * MIN, high: 101.05, low: 100.9 },
      { ts: T0 + 11 * MIN, high: 101, low: 100.9 },
    ];
    const rangeOf = (_s: string, since: number) => {
      const cs = candles.filter((c) => c.ts >= since && c.ts + MIN <= tNow);
      return cs.length ? { high: Math.max(...cs.map((c) => c.high)), low: Math.min(...cs.map((c) => c.low)), lastCandleTs: cs[cs.length - 1].ts } : undefined;
    };
    let tNow = T0 + 7 * MIN;
    expect(tr.update(tNow, () => q(103.1, 103.3), { rangeOf })).toEqual([]);
    expect(tr.list()[0].mfeR).toBeGreaterThan(1.5);
    // 期限: bid 100.93 → 純R ≈ 0.3 → 延長。極値は bid 100.93 から (延長より前の 103 台は使わない)
    tNow = T0 + 10 * MIN;
    expect(tr.update(tNow, () => q(100.93, 101.13), { rangeOf })).toEqual([]);
    const o = tr.list()[0];
    expect(o.thesisExtendedAt).toBe(T0 + 10 * MIN);
    expect(o.thesisNetRAtDeadline).toBeCloseTo(netRAt(100.93), 9);
    expect(o.thesisNetRAtDeadline).toBeGreaterThan(0.29);
    expect(o.thesisPeak).toBeCloseTo(100.93, 9);
    // 持ち続ける (ストップは建値 ≈ 100.31。延長より前の高値から測れば 102 台で決済してしまう)
    for (let m = 12; m <= 20; m++) {
      tNow = T0 + m * MIN;
      expect(tr.update(tNow, () => q(100.93, 101.13), { rangeOf })).toEqual([]);
    }
    // 延長後の足の高値 101.05 (仲値) − 半スプレッド 0.1 = 100.95 まで進む (kv に保存して再起動しても続く)
    const saved = store.kvGet<ShadowOpen[]>(shadowOpenKey("paper"))!;
    expect(saved[0].thesisPeak).toBeCloseTo(100.95, 9);
    expect(tr.size).toBe(1);
  });

  it("延長後の保護ストップは延長した時刻以降に始まった足と気配だけで判定する (延長を含む足の、延長より前の安値では決済しない)", () => {
    const closed: ShadowTradeRecord[] = [];
    const tr = tracker(ON, new MemoryStore(), closed);
    tr.record(input());
    // 10:00 に始まる足の安値 100.0 は延長 (10:00:30) より前。延長後のストップ (建値 ≈ 100.31) より下だが、この足では判定しない
    const candles = [{ ts: T0 + 9 * MIN, high: 101.6, low: 101.4 }, { ts: T0 + 10 * MIN, high: 101.7, low: 100 }];
    let tNow = 0;
    const rangeOf = (_s: string, since: number) => {
      const cs = candles.filter((c) => c.ts >= since && c.ts + MIN <= tNow);
      return cs.length ? { high: Math.max(...cs.map((c) => c.high)), low: Math.min(...cs.map((c) => c.low)), lastCandleTs: cs[cs.length - 1].ts } : undefined;
    };
    tNow = T0 + 10 * MIN + 30_000;
    expect(tr.update(tNow, () => q(101.5, 101.7), { rangeOf })).toEqual([]);
    expect(tr.list()[0].thesisExtendedAt).toBe(tNow);
    tNow = T0 + 11 * MIN + 1_000;
    expect(tr.update(tNow, () => q(101.5, 101.7), { rangeOf })).toEqual([]);
    expect(closed).toHaveLength(0);
    // 延長より後に始まった足で割れば trailing
    candles.push({ ts: T0 + 11 * MIN, high: 101.5, low: 100.2 });
    tNow = T0 + 12 * MIN + 1_000;
    const [r] = tr.update(tNow, () => q(101.4, 101.6), { rangeOf });
    expect(r).toMatchObject({ exitReason: "trailing", thesisOutcome: "extended" });
  });

  it("途中で読み外れは値動きだけ (仲値 − エントリー価格) で判定する: コストで純 R が −0.5 を下回っても途中では切らない", () => {
    const tr = tracker(ON);
    // 1R = 0.4 (ask 100.1 − 損切り 99.7)。動かなくても純 R ≈ −1、値動きだけの R = (100 − 100.1) / 0.4 = −0.25
    tr.record(input({ stopLoss: 99.7 }));
    expect(tr.update(T0 + 6 * MIN, () => q(99.9, 100.1))).toEqual([]);
    expect(tr.update(T0 + 10 * MIN, () => q(99.9, 100.1))[0].exitReason).toBe("thesis_timeout");
    const t2 = tracker(ON);
    t2.record(input({ stopLoss: 99.7 }));
    // 仲値 99.85 → (99.85 − 100.1) / 0.4 = −0.625
    expect(t2.update(T0 + 6 * MIN, () => q(99.75, 99.95))[0].exitReason).toBe("thesis_failed");
  });

  it("延長しても 期限 × THESIS_EXTEND_MULT で thesis_cap", () => {
    const tr = tracker({ ...ON, extendMult: 2 });
    tr.record(input());
    expect(tr.update(T0 + 10 * MIN, () => q(101.5, 101.7))).toEqual([]);
    expect(tr.update(T0 + 19 * MIN, () => q(101.6, 101.8))).toEqual([]);
    const [r] = tr.update(T0 + 20 * MIN, () => q(101.6, 101.8));
    expect(r).toMatchObject({ exitReason: "thesis_cap", thesisOutcome: "extended" });
  });

  it("シグナルの expectedMs を読みの期限にする", () => {
    const tr = tracker(ON);
    tr.record(input({ maxHoldMs: 30 * MIN, expectedMs: 4 * MIN }));
    const [r] = tr.update(T0 + 4 * MIN, () => q(100, 100.2));
    expect(r).toMatchObject({ exitReason: "thesis_timeout", thesisExpectedMs: 4 * MIN });
  });

  it("無効なら従来どおり time (純 R・途中の逆行によらない)。読みの期限も記録しない", () => {
    for (const thesis of [THESIS_DISABLED, undefined]) {
      const tr = tracker(thesis);
      tr.record(input());
      expect(tr.list()[0].thesisExpectedMs).toBeUndefined();
      expect(tr.update(T0 + 6 * MIN, () => q(98.7, 98.9))).toEqual([]);
      const [r] = tr.update(T0 + 10 * MIN, () => q(101.5, 101.7));
      expect(r.exitReason).toBe("time");
      expect(r.thesisOutcome).toBeUndefined();
    }
  });

  it("以前の記録 (thesisExpectedMs なし) と最大保有の無いシグナルは従来どおり", () => {
    const store = new MemoryStore();
    const tr = tracker(ON, store);
    tr.record(input());
    tr.flush();
    // 以前の形式の未決済に戻す (読みの項目なし)
    const saved = store.kvGet<ShadowOpen[]>(shadowOpenKey("paper"))!;
    const { thesisExpectedMs: _t, ...old } = saved[0];
    store.kvSet(shadowOpenKey("paper"), [old]);
    const tr2 = tracker(ON, store);
    expect(tr2.update(T0 + 6 * MIN, () => q(98.7, 98.9))).toEqual([]);
    const [r] = tr2.update(T0 + 10 * MIN, () => q(100, 100.2));
    expect(r.exitReason).toBe("time");
    expect(r.thesisOutcome).toBeUndefined();
    // 最大保有の無いシグナル: 既定の保有上限 (24 時間) は読みの期限にしない
    const tr3 = tracker(ON);
    tr3.record(input({ maxHoldMs: 0 }));
    expect(tr3.list()[0].thesisExpectedMs).toBeUndefined();
    expect(tr3.update(T0 + 60 * MIN, () => q(100, 100.2))).toEqual([]);
  });
});
