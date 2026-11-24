import { describe, expect, it } from "vitest";
import type { Candle, OrderBook, TradePrint } from "../src/core/types";
import { microprice, orderBookImbalance, spreadBps, tradeFlowImbalance } from "../src/indicators/microstructure";
import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  macd,
  percentileRank,
  rsi,
  rsiLast,
  sma,
  smaLast,
  stdev,
  stdevLast,
  vwapLast,
} from "../src/indicators/series";

const bar = (i: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ ts: i * 60_000, open: o, high: h, low: l, close: c, volume: v });

describe("移動平均", () => {
  it("SMA: ウォームアップは NaN・既知値", () => {
    const s = sma([1, 2, 3, 4, 5], 3);
    expect(s.length).toBe(5);
    expect(Number.isNaN(s[0]) && Number.isNaN(s[1])).toBe(true);
    expect(s.slice(2)).toEqual([2, 3, 4]);
    expect(smaLast([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it("EMA: 初期値は SMA、以降 k=2/(n+1)", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(e[1])).toBe(true);
    expect(e[2]).toBeCloseTo(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });
  it("EMA: 先頭の NaN を飛ばす", () => {
    const e = ema([NaN, NaN, 2, 4, 6], 2);
    expect(Number.isNaN(e[2])).toBe(true);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(6 * (2 / 3) + 3 / 3);
  });
});

describe("オシレーター", () => {
  it("RSI (Wilder) の手計算値", () => {
    // 変化: +1, -1, +1, +1 / 期間 2
    const r = rsi([1, 2, 1, 2, 3], 2);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(r[2]).toBeCloseTo(50);
    expect(r[3]).toBeCloseTo(75);
    expect(r[4]).toBeCloseTo(87.5);
  });
  it("RSI: 単調増加は 100、単調減少は 0", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsiLast(up, 14)).toBe(100);
    expect(rsiLast(up.slice().reverse(), 14)).toBe(0);
  });
  it("MACD = EMA(fast) - EMA(slow)、hist = MACD - signal", () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.1);
    const m = macd(xs, 12, 26, 9);
    const ef = ema(xs, 12);
    const es = ema(xs, 26);
    expect(m.macd[40]).toBeCloseTo(ef[40] - es[40]);
    expect(Number.isNaN(m.signal[25 + 7])).toBe(true);
    expect(Number.isFinite(m.signal[25 + 8])).toBe(true);
    expect(m.hist[50]).toBeCloseTo(m.macd[50] - m.signal[50]);
  });
});

describe("ボラティリティ・レンジ", () => {
  it("ATR (Wilder) の手計算値", () => {
    const c = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 10, 11), bar(2, 11, 11.5, 8, 9), bar(3, 9, 10, 9, 9.5)];
    // TR: 2, 2, 3.5, 1
    const a = atr(c, 2);
    expect(Number.isNaN(a[0])).toBe(true);
    expect(a[1]).toBeCloseTo(2);
    expect(a[2]).toBeCloseTo((2 + 3.5) / 2);
    expect(a[3]).toBeCloseTo((2.75 + 1) / 2);
  });
  it("ADX: 一定幅の直線上昇は +DI=100・ADX=100", () => {
    const c = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i + 0.3));
    const r = adx(c, 14);
    expect(Number.isNaN(r.adx[26])).toBe(true);
    expect(r.adx[27]).toBeCloseTo(100);
    expect(r.plusDI[39]).toBeGreaterThan(r.minusDI[39]);
    expect(r.minusDI[39]).toBeCloseTo(0);
  });
  it("ボリンジャー (母標準偏差)", () => {
    const b = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(b.middle[4]).toBeCloseTo(3);
    expect(b.upper[4]).toBeCloseTo(3 + 2 * Math.SQRT2);
    expect(b.lower[4]).toBeCloseTo(3 - 2 * Math.SQRT2);
    expect(b.percentB[4]).toBeCloseTo((5 - b.lower[4]) / (b.upper[4] - b.lower[4]));
  });
  it("ドンチャン", () => {
    const c = [bar(0, 1, 2, 0.5, 1), bar(1, 1, 3, 1, 2), bar(2, 2, 2.5, 0.8, 2), bar(3, 2, 2.2, 1.5, 2)];
    const d = donchian(c, 3);
    expect(Number.isNaN(d.upper[1])).toBe(true);
    expect(d.upper[2]).toBe(3);
    expect(d.lower[2]).toBe(0.5);
    expect(d.upper[3]).toBe(3);
    expect(d.lower[3]).toBe(0.8);
  });
});

describe("VWAP・統計", () => {
  it("ローリング VWAP は典型価格の出来高加重", () => {
    const c = [bar(0, 10, 10, 10, 10, 1), bar(1, 20, 20, 20, 20, 3), bar(2, 30, 30, 30, 30, 1)];
    expect(Number.isNaN(vwapLast(c.slice(0, 1), 2))).toBe(true);
    expect(vwapLast(c.slice(0, 2), 2)).toBeCloseTo((10 + 60) / 4);
    expect(vwapLast(c, 2)).toBeCloseTo((60 + 30) / 4);
    // 出来高 0 は単純平均
    expect(vwapLast([bar(0, 1, 1, 1, 1, 0), bar(1, 3, 3, 3, 3, 0)], 2)).toBeCloseTo(2);
  });
  it("標準偏差", () => {
    expect(stdev([1, 2, 3], 3)[2]).toBeCloseTo(Math.sqrt(2 / 3));
    expect(stdevLast([1, 2, 3], 3)).toBeCloseTo(Math.sqrt(2 / 3));
    // 大きな価格でも桁落ちしない
    expect(stdevLast([60000.1, 60000.2, 60000.3], 3)).toBeCloseTo(Math.sqrt(2 / 3) * 0.1, 8);
  });
  it("パーセンタイル順位", () => {
    expect(percentileRank([1, 2, 3, 4], 5)).toBe(1);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 2.5)).toBe(0.5);
    // 同値は 0.5 として数える・非有限は除く・空は NaN
    expect(percentileRank([3, 3], 3)).toBe(0.5);
    expect(percentileRank([1, NaN, 3], 2)).toBe(0.5);
    expect(Number.isNaN(percentileRank([], 1))).toBe(true);
  });
});

describe("板・約定の特徴量", () => {
  const book: OrderBook = {
    ts: 0,
    bids: [
      [99, 30],
      [98, 10],
    ],
    asks: [
      [101, 10],
      [102, 10],
    ],
  };
  it("板不均衡", () => {
    expect(orderBookImbalance(book, 1)).toBeCloseTo((30 - 10) / 40);
    expect(orderBookImbalance(book, 5)).toBeCloseTo((40 - 20) / 60);
    expect(orderBookImbalance({ ts: 0, bids: [], asks: [] }, 5)).toBe(0);
  });
  it("マイクロプライスは厚い側の反対へ寄る", () => {
    // (99*10 + 101*30) / 40 = 100.5
    expect(microprice(book)).toBeCloseTo(100.5);
    expect(Number.isNaN(microprice({ ts: 0, bids: [], asks: [[1, 1]] }))).toBe(true);
  });
  it("スプレッド bps", () => {
    expect(spreadBps({ bid: 99, ask: 101 })).toBeCloseTo(200);
    expect(Number.isNaN(spreadBps({ bid: 0, ask: 101 }))).toBe(true);
  });
  it("約定フロー不均衡は窓内だけを数える", () => {
    const prints: TradePrint[] = [
      { ts: 1_000, price: 1, size: 100, side: "sell" }, // 窓外
      { ts: 5_000, price: 1, size: 3, side: "buy" },
      { ts: 9_000, price: 1, size: 1, side: "sell" },
      { ts: 11_000, price: 1, size: 100, side: "sell" }, // 未来
    ];
    expect(tradeFlowImbalance(prints, 8_000, 10_000)).toBeCloseTo((3 - 1) / 4);
    expect(tradeFlowImbalance([], 8_000, 10_000)).toBe(0);
  });
});
