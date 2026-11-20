import { describe, expect, it } from "vitest";
import type { Candle, Signal, Strategy, StrategyContext } from "../src/core/types";
import { runBacktest, syntheticInstrument } from "../src/backtest";

/** バックテストの指値 (maker): 越えたら約定・期限・maker 手数料・同じ足で損切りと利確に届いたら損切り優先 */

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);
const closeOf = (i: number) => T0 + (i + 1) * M;

function bars(rows: [number, number, number, number][]): Candle[] {
  return rows.map(([o, h, l, c], i) => ({ ts: T0 + i * M, open: o, high: h, low: l, close: c, volume: 100 }));
}
const flat = (n: number, p = 100): [number, number, number, number][] => Array.from({ length: n }, () => [p, p, p, p]);

function sig(dir: "long" | "short", stopLoss: number, takeProfit?: number): Signal {
  return {
    strategyId: "scripted", horizon: "scalp", symbol: "SYN/USDT", direction: dir, confidence: 0.7, expectedEdgeBps: 100, entry: { type: "market" },
    stopLoss, takeProfit, maxHoldMs: 1_000 * M, reason: "scripted", features: {},
  };
}

/** 判定時刻 → シグナル */
function scripted(plan: Record<number, Signal>, opts: Partial<Strategy> = {}): Strategy {
  return {
    id: "scripted", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range"], primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1,
    defaultParams: {}, paramBounds: {},
    evaluate: (ctx: StrategyContext) => (ctx.position ? null : (plan[ctx.market.now] ?? null)),
    ...opts,
  };
}

const NO_COST = { spreadBps: 0, slippageBps: 0 };
const inst = syntheticInstrument({ takerFeeRate: 0.001, makerFeeRate: -0.0001, tickSize: 0, lotSize: 0, minQty: 0 });
const LIMIT = { entry: true, takeProfit: true, entryTimeoutMs: 5 * M };

describe("バックテスト: 指値のエントリー", () => {
  it("安値が指値に触れただけでは約定せず、下回った足で指値の価格・maker 手数料で約定する", () => {
    const candles = bars([...flat(3), [100, 100.5, 100, 100.3], [100.3, 100.4, 99.9, 100], ...flat(3)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("long", 98, 110) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryTs).toBe(T0 + 4 * M); // 触れただけのバー 3 ではなく、下回ったバー 4
    expect(t.entryPrice).toBe(100);
    expect(t.entryOrderType).toBe("limit");
    // エントリーは maker (受け取り)、終了時の決済は成行 (taker)
    expect(t.makerFees).toBeCloseTo(100 * t.qty * -0.0001, 6);
    expect(t.takerFees).toBeCloseTo(t.exitPrice * t.qty * 0.001, 6);
    expect(t.fees).toBeCloseTo(t.makerFees! + t.takerFees!, 6);
    expect(r.stats.limitEntries).toEqual({ placed: 1, filled: 1, expired: 0, canceled: 0 });
  });

  it("期限 (足の本数) 内に約定しなければ取引なし (後で下回っても約定しない)", () => {
    const candles = bars([...flat(3), [100, 100.5, 100, 100.2], [100.2, 100.5, 100.1, 100.3], [100.3, 100.5, 100.2, 100.3], [100, 100, 95, 96], ...flat(2, 96)]);
    const r = runBacktest({
      strategy: scripted({ [closeOf(2)]: sig("long", 90, 110) }), instrument: inst, candles, ...NO_COST,
      limitOrders: { ...LIMIT, entryTimeoutMs: 3 * M },
    });
    expect(r.trades).toHaveLength(0);
    expect(r.stats.limitEntries).toEqual({ placed: 1, filled: 0, expired: 1, canceled: 0 });
    expect(r.stats.skipped.limit_unfilled).toBe(1);
  });

  it("待っている間に逆方向のシグナルが出たら取り消す", () => {
    const candles = bars([...flat(3), [100, 100.5, 100, 100.2], [100.2, 100.3, 99, 99.5], ...flat(3, 99.5)]);
    const r = runBacktest({
      strategy: scripted({ [closeOf(2)]: sig("long", 98, 110), [closeOf(3)]: sig("short", 103, 90) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT,
    });
    expect(r.trades).toHaveLength(0);
    expect(r.stats.limitEntries).toMatchObject({ placed: 1, filled: 0, canceled: 1 });
  });

  it("成行の戦略 (entryOrder: market) は従来どおり次の足の始値で約定する", () => {
    const candles = bars([...flat(3), [100.4, 100.5, 100.2, 100.3], ...flat(3, 100.3)]);
    const r = runBacktest({
      strategy: scripted({ [closeOf(2)]: sig("long", 98, 110) }, { entryOrder: "market" }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT,
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryPrice).toBe(100.4);
    expect(r.trades[0].entryOrderType).toBe("market");
    expect(r.trades[0].makerFees).toBe(0);
  });

  it("指値で約定した足の有利な側の極値 (約定前かもしれない高値) でトレーリング・MFE を進めない (約定価格から追う)", () => {
    // バー 3 で指値 100 が約定 (安値 99.5 < 100)。同じ足の高値 110 は約定の前かもしれないので使わない
    const candles = bars([...flat(3), [101, 110, 99.5, 100], [100, 100.5, 99.8, 100.2], [100.2, 100.6, 100, 100.4]]);
    const s: Signal = { ...sig("long", 95, 200), trailingStopPct: 0.02 };
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: s }), instrument: inst, candles, ...NO_COST, limitOrders: { ...LIMIT, takeProfit: false } });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryTs).toBe(T0 + 3 * M);
    expect(t.entryPrice).toBe(100);
    // 高値 110 でトレーリング (107.8) を引き上げていたら次の足の始値で決済されていた
    expect(t.exitReason).toBe("manual");
    // MFE は約定の後の足の高値 (100.6) まで。不利な側 (安値 99.5) は約定の後なので MAE に含める
    expect(t.mfePct).toBeCloseTo(0.006, 9);
    expect(t.maePct).toBeCloseTo(0.005, 9);
  });

  it("limitOrders を渡さなければ従来どおり (指値の記録も付かない)", () => {
    const candles = bars([...flat(3), [100.4, 100.5, 100.2, 100.3], ...flat(3, 100.3)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("long", 98, 110) }), instrument: inst, candles, ...NO_COST });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].entryPrice).toBe(100.4);
    expect(r.trades[0].entryOrderType).toBeUndefined();
    expect(r.stats.limitEntries).toBeUndefined();
  });
});

describe("バックテスト: 利確の指値", () => {
  it("高値が利確価格に触れただけでは約定せず、越えた足で利確価格・maker で約定する", () => {
    const candles = bars([...flat(3), [100, 100, 99.9, 100], [100, 105, 100, 104], [104, 105.1, 103, 104], ...flat(2, 104)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("long", 98, 105) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe("take_profit");
    expect(t.exitTs).toBe(T0 + 6 * M); // 触れただけのバー 4 ではなく、越えたバー 5 の終わり
    expect(t.exitPrice).toBe(105);
    expect(t.exitOrderType).toBe("limit");
    expect(t.takerFees).toBe(0);
    expect(t.makerFees).toBeCloseTo((100 + 105) * t.qty * -0.0001, 6);
    expect(t.netPnl).toBeCloseTo(5 * t.qty - (100 + 105) * t.qty * -0.0001, 6);
  });

  it("同じ足で損切りと利確の両方に届いたら損切りを優先する", () => {
    const candles = bars([...flat(3), [100, 100, 99.9, 100], [100, 106, 97, 100], ...flat(2)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("long", 98, 105) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe("stop");
    expect(r.trades[0].exitPrice).toBe(98);
    expect(r.trades[0].takerFees).toBeGreaterThan(0);
  });

  it("指値で約定した足では利確を判定しない (足の中の順序が分からないため)", () => {
    const candles = bars([...flat(3), [100, 106, 99.9, 104], ...flat(3, 104)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("long", 98, 105) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe("manual"); // 最終足で決済 (利確は付かない)
  });

  it("売り: 高値が指値を上回ったら約定し、安値が利確価格を下回ったら利確", () => {
    const candles = bars([...flat(3), [100, 100.1, 99.5, 100], [100, 100, 95, 96], [96, 96, 94.9, 95], ...flat(2, 95)]);
    const r = runBacktest({ strategy: scripted({ [closeOf(2)]: sig("short", 102, 95) }), instrument: inst, candles, ...NO_COST, limitOrders: LIMIT });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.direction).toBe("short");
    expect(t.entryTs).toBe(T0 + 3 * M);
    expect(t.entryPrice).toBe(100);
    // バー 4 は安値 95 に触れただけ、バー 5 で 95 を下回って利確
    expect(t.exitReason).toBe("take_profit");
    expect(t.exitTs).toBe(T0 + 6 * M);
    expect(t.exitPrice).toBe(95);
  });
});
