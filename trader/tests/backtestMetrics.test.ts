import { describe, expect, it } from "vitest";
import type { EquityPoint, TradeRecord } from "../src/core/types";
import { computeMetrics, maxDrawdownOf, PROFIT_FACTOR_CAP, scoreResult } from "../src/backtest/metrics";
import type { BacktestMetrics } from "../src/backtest/types";

const H = 3_600_000;

function trade(netPnl: number, r: number, holdMs: number, fees = 1): TradeRecord {
  return {
    id: `t${netPnl}`,
    mode: "backtest",
    symbol: "X",
    venue: "paper",
    assetClass: "crypto",
    strategyId: "s",
    horizon: "short",
    direction: "long",
    qty: 1,
    entryTs: 0,
    entryPrice: 100,
    intendedEntryPrice: 100,
    exitTs: holdMs,
    exitPrice: 100,
    intendedExitPrice: 100,
    initialStop: 99,
    grossPnl: netPnl + fees,
    fees,
    netPnl,
    returnPct: netPnl / 100,
    rMultiple: r,
    mfePct: 0,
    maePct: 0,
    exitReason: "stop",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0, volatilityPercentile: 0.5, spreadBps: 0 },
      confidence: 0.5,
      expectedEdgeBps: 10,
      costBps: 5,
      params: {},
      features: {},
      riskMultiplier: 1,
      reason: "",
    },
  };
}

const curve = (eqs: number[]): EquityPoint[] => eqs.map((equity, i) => ({ ts: i * H, equity, mode: "backtest" }));

describe("computeMetrics", () => {
  it("勝率・PF・期待値R・保有時間・手数料", () => {
    const trades = [trade(20, 2, 2 * H), trade(-10, -1, 4 * H), trade(-10, -1, 6 * H), trade(30, 3, 0)];
    const m = computeMetrics(trades, curve([1000, 1020, 1010, 1000, 1030]), 1000);
    expect(m.trades).toBe(4);
    expect(m.winRate).toBe(0.5);
    expect(m.profitFactor).toBeCloseTo(50 / 20);
    expect(m.expectancyR).toBeCloseTo(0.75);
    expect(m.avgHoldMs).toBe(3 * H);
    expect(m.fees).toBe(4);
    expect(m.grossPnl).toBe(34);
    expect(m.netPnl).toBe(30);
    expect(m.returnPct).toBeCloseTo(0.03);
    expect(m.finalEquity).toBe(1030);
  });

  it("最大ドローダウンはピーク比", () => {
    expect(maxDrawdownOf(curve([100, 120, 90, 130, 117]))).toBeCloseTo(0.25);
    const m = computeMetrics([], curve([1000, 1200, 900, 1300]), 1000);
    expect(m.maxDrawdown).toBeCloseTo(0.25);
  });

  it("シャープ・ソルティノ (年率, 記録間隔ベース)", () => {
    const eqs = [1000, 1010, 1005, 1020, 1015, 1030];
    const m = computeMetrics([], curve(eqs), 1000, { periodMs: H });
    const rets = eqs.slice(1).map((e, i) => e / eqs[i] - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    const ppy = (365 * 24 * H) / H;
    expect(m.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(ppy), 6);
    const down = Math.sqrt(rets.reduce((a, b) => a + (b < 0 ? b * b : 0), 0) / rets.length);
    expect(m.sortino).toBeCloseTo((mean / down) * Math.sqrt(ppy), 6);
    expect(m.sortino).toBeGreaterThan(m.sharpe);
  });

  it("損失ゼロの PF は上限値、取引ゼロは 0", () => {
    expect(computeMetrics([trade(10, 1, H)], curve([1000, 1010]), 1000).profitFactor).toBe(PROFIT_FACTOR_CAP);
    const m = computeMetrics([], curve([1000, 1000]), 1000);
    expect(m.profitFactor).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.sharpe).toBe(0);
  });
});

describe("scoreResult", () => {
  const base: BacktestMetrics = {
    netPnl: 0,
    returnPct: 0,
    sharpe: 0,
    sortino: 0,
    maxDrawdown: 0,
    winRate: 0,
    profitFactor: 0,
    expectancyR: 0,
    trades: 0,
    avgHoldMs: 0,
    fees: 0,
    grossPnl: 0,
    finalEquity: 0,
  };

  it("取引ゼロは -1", () => {
    expect(scoreResult(base)).toBe(-1);
  });

  it("期待値とシャープが高いほど高く、ドローダウンで下がる", () => {
    const a = scoreResult({ ...base, trades: 50, expectancyR: 0.3, sharpe: 1.5, maxDrawdown: 0.05 });
    const b = scoreResult({ ...base, trades: 50, expectancyR: 0.1, sharpe: 1.5, maxDrawdown: 0.05 });
    const c = scoreResult({ ...base, trades: 50, expectancyR: 0.3, sharpe: 0.5, maxDrawdown: 0.05 });
    const d = scoreResult({ ...base, trades: 50, expectancyR: 0.3, sharpe: 1.5, maxDrawdown: 0.2 });
    expect(a).toBeGreaterThan(b);
    expect(a).toBeGreaterThan(c);
    expect(a).toBeGreaterThan(d);
  });

  it("取引数が少ないと罰則 (同じ成績でも多い方が高い)", () => {
    const few = scoreResult({ ...base, trades: 3, expectancyR: 1, sharpe: 2 });
    const many = scoreResult({ ...base, trades: 60, expectancyR: 1, sharpe: 2 });
    expect(many).toBeGreaterThan(few);
    expect(scoreResult({ ...base, trades: 3, expectancyR: 1, sharpe: 2 }, { minTrades: 3 })).toBeGreaterThan(few);
  });

  it("NaN・極端値でも有限", () => {
    const s = scoreResult({ ...base, trades: 10, expectancyR: Number.NaN, sharpe: 1e9, maxDrawdown: 5 });
    expect(Number.isFinite(s)).toBe(true);
  });
});
