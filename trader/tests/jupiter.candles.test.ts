import { describe, expect, it } from "vitest";
import { fillGaps, PolledCandleBuilder, polledCandlesFor, PolledCandleStore, resamplePolled, type PolledCandle } from "../src/market/jupiter/candles";

const M = 60_000;
const T0 = Date.UTC(2025, 0, 1, 0, 0, 0);

describe("PolledCandleBuilder (価格 → 1m 足)", () => {
  it("同じ分の価格を OHLC にまとめ、出来高は 0 で volumeKnown: false", () => {
    const b = new PolledCandleBuilder();
    for (const [s, p] of [[0, 10], [15, 12], [30, 9], [45, 11]] as const) b.push(T0 + s * 1000, p);
    b.push(T0 + M + 5_000, 11.5);
    const c = b.candles(T0 + 2 * M);
    expect(c).toEqual([
      { ts: T0, open: 10, high: 12, low: 9, close: 11, volume: 0, volumeKnown: false, filled: false, samples: 4 },
      { ts: T0 + M, open: 11.5, high: 11.5, low: 11.5, close: 11.5, volume: 0, volumeKnown: false, filled: false, samples: 1 },
    ]);
  });

  it("確定足だけを返す (形成中は includeForming のときだけ)", () => {
    const b = new PolledCandleBuilder();
    b.push(T0, 10);
    b.push(T0 + M + 1000, 11);
    expect(b.candles(T0 + M + 30_000).map((c) => c.ts)).toEqual([T0]);
    expect(b.candles(T0 + M + 30_000, { includeForming: true }).map((c) => c.ts)).toEqual([T0, T0 + M]);
  });

  it("不正な価格 (0・負・NaN) と今の足より古い価格は捨てる", () => {
    const b = new PolledCandleBuilder();
    expect(b.push(T0 + M, 10)).toBe(true);
    expect(b.push(T0 + M + 1, 0)).toBe(false);
    expect(b.push(T0 + M + 2, -1)).toBe(false);
    expect(b.push(T0 + M + 3, Number.NaN)).toBe(false);
    expect(b.push(T0, 99)).toBe(false); // 前の分
    expect(b.push(T0 + M + 4, 10.5)).toBe(true); // 同じ分の後の時刻は使う
    expect(b.size).toBe(1);
    expect(b.lastBar()?.close).toBe(10.5);
  });

  it("空白は直前の終値で横ばいの足を差し込み、filled を付ける (carry forward)", () => {
    const b = new PolledCandleBuilder();
    b.push(T0, 10);
    b.push(T0 + 20_000, 10.4);
    b.push(T0 + 3 * M, 11);
    const c = b.candles(T0 + 4 * M);
    expect(c.map((x) => [x.ts - T0, x.open, x.close, x.filled, x.samples])).toEqual([
      [0, 10, 10.4, false, 2],
      [M, 10.4, 10.4, true, 0],
      [2 * M, 10.4, 10.4, true, 0],
      [3 * M, 11, 11, false, 1],
    ]);
    expect(c[1]).toMatchObject({ high: 10.4, low: 10.4, volume: 0, volumeKnown: false });
  });

  it("末尾も確定した分だけ埋め、maxFillBars 本で止める (feed が止まったら足を作らない)", () => {
    const b = new PolledCandleBuilder({ maxFillBars: 3 });
    b.push(T0, 10);
    expect(b.candles(T0 + 2 * M + 30_000).map((x) => x.filled)).toEqual([false, true]);
    const c = b.candles(T0 + 100 * M);
    expect(c.map((x) => x.ts - T0)).toEqual([0, M, 2 * M, 3 * M]);
  });

  it("長い空白は先頭から maxFillBars 本だけ埋め、残りは空白のまま。後から価格が来ても一度返した足は変わらない", () => {
    const b = new PolledCandleBuilder({ maxFillBars: 2 });
    b.push(T0, 10);
    const before = b.candles(T0 + 6 * M);
    expect(before.map((x) => x.ts - T0)).toEqual([0, M, 2 * M]);
    b.push(T0 + 6 * M, 12);
    const after = b.candles(T0 + 7 * M);
    expect(after.map((x) => x.ts - T0)).toEqual([0, M, 2 * M, 6 * M]);
    expect(after.slice(0, 3)).toEqual(before);
  });

  it("seed: 外部の足 (出来高あり) を入れ、ポーリングの足は上書きしない", () => {
    const b = new PolledCandleBuilder();
    b.push(T0 + 2 * M, 5);
    const added = b.seed([
      { ts: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { ts: T0 + M, open: 1.5, high: 1.6, low: 1.4, close: 1.55, volume: 50 },
      { ts: T0 + 2 * M, open: 9, high: 9, low: 9, close: 9, volume: 1 },
      { ts: T0 + 30_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }, // 区切りに合わない
      { ts: T0 - M, open: 0, high: 1, low: 1, close: 1, volume: 1 }, // 不正な価格
    ]);
    expect(added).toBe(2);
    const c = b.candles(T0 + 3 * M);
    expect(c.map((x) => [x.close, x.volume, x.volumeKnown])).toEqual([[1.5, 100, true], [1.55, 50, true], [5, 0, false]]);
  });

  it("maxCandles を超えたら古い足から捨てる", () => {
    const b = new PolledCandleBuilder({ maxCandles: 10 });
    for (let i = 0; i < 25; i++) b.push(T0 + i * M, 10 + i);
    expect(b.size).toBe(10);
    expect(b.candles(T0 + 25 * M)[0].ts).toBe(T0 + 15 * M);
  });
});

describe("resamplePolled (上位足)", () => {
  const series = (n: number, start = T0): PolledCandle[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: start + i * M, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 0, volumeKnown: false, filled: i % 2 === 1, samples: i % 2 === 1 ? 0 : 3,
    }));

  it("5m: OHLC は resample.ts と同じ (確定したバケットだけ)。フラグは中の 1m から", () => {
    const r = resamplePolled(series(12), "5m");
    expect(r).toHaveLength(2); // 10〜11 分の足は未確定
    expect(r[0]).toEqual({ ts: T0, open: 100, high: 105, low: 99, close: 104.5, volume: 0, filled: false, volumeKnown: false, samples: 9 });
    expect(r[1].ts).toBe(T0 + 5 * M);
  });

  it("中の 1m がすべて埋めた足なら filled", () => {
    const c = series(5).map((x) => ({ ...x, filled: true, samples: 0 }));
    expect(resamplePolled(c, "5m")[0].filled).toBe(true);
  });

  it("データ途中から始まる先頭のバケットは捨てる", () => {
    const r = resamplePolled(series(13, T0 + 2 * M), "5m");
    expect(r.map((x) => x.ts)).toEqual([T0 + 5 * M, T0 + 10 * M]);
  });

  it("15m / 1h / 4h", () => {
    const c = series(8 * 60);
    expect(resamplePolled(c, "15m")).toHaveLength(32);
    expect(resamplePolled(c, "1h")).toHaveLength(8);
    const h4 = resamplePolled(c, "4h");
    expect(h4).toHaveLength(2);
    expect(h4[0]).toMatchObject({ open: 100, close: 100.5 + 239, high: 101 + 239, low: 99, samples: 120 * 3 });
  });

  it("出来高の分かる足と混ざると volumeKnown: false", () => {
    const c = series(5).map((x, i) => ({ ...x, volumeKnown: i !== 2, volume: i !== 2 ? 10 : 0 }));
    const r = resamplePolled(c, "5m")[0];
    expect(r.volumeKnown).toBe(false);
    expect(r.volume).toBe(40);
  });

  it("polledCandlesFor / PolledCandleStore: 価格から 5m を作る", () => {
    const store = new PolledCandleStore();
    for (let s = 0; s < 10 * 60; s += 10) store.pushPrices(new Map([["mintA", { usd: 1 + s / 1000, ts: T0 + s * 1000 }]]));
    const c5 = store.candles("mintA", "5m", T0 + 10 * M);
    expect(c5).toHaveLength(2);
    expect(c5[0].samples).toBe(30);
    expect(c5[0].open).toBe(1);
    expect(store.candles("mintA", "1m", T0 + 10 * M, 3)).toHaveLength(3);
    expect(store.candles("unknown", "1m", T0)).toEqual([]);
    const b = store.builder("mintA");
    expect(polledCandlesFor(b, "1m", T0 + 10 * M)).toHaveLength(10);
  });
});

describe("fillGaps", () => {
  it("間が無ければそのまま、maxFillBars 0 なら埋めない", () => {
    const c: PolledCandle[] = [
      { ts: 0, open: 1, high: 1, low: 1, close: 1, volume: 0, volumeKnown: false, filled: false, samples: 1 },
      { ts: 3 * M, open: 2, high: 2, low: 2, close: 2, volume: 0, volumeKnown: false, filled: false, samples: 1 },
    ];
    expect(fillGaps(c, M, 0)).toHaveLength(2);
    expect(fillGaps(c, M, 5).map((x) => x.close)).toEqual([1, 1, 1, 2]);
  });
});
