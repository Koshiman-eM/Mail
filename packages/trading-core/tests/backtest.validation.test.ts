import { describe, expect, it, vi } from "vitest";
import {
  aggregateAcrossSymbols, buyAndHold, coverageWarning, equalWeightCurve, foldSummaries, formatAggregateRows, formatFoldRows, totalR,
} from "../src/engine/backtestValidation";
import { fetchCandlesPaged, formatBacktestRows, runBacktestCommand } from "../src/engine/backtestCommand";
import type { Candle, EquityPoint, Instrument, MarketDataFeed, Strategy, Timeframe, TradeRecord } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";

const H4 = TIMEFRAME_MS["4h"];
const DAY = 86_400_000;

const candle = (ts: number, open: number, close: number, high = Math.max(open, close), low = Math.min(open, close)): Candle => ({ ts, open, high, low, close, volume: 1 });
const trade = (netPnl: number, rMultiple: number, exitTs = 0): TradeRecord => ({ netPnl, rMultiple, exitTs, entryTs: exitTs - 1, fees: 0, grossPnl: netPnl }) as unknown as TradeRecord;
const pt = (ts: number, equity: number): EquityPoint => ({ ts, equity, mode: "backtest" });

describe("保有 (buy & hold)", () => {
  it("最初の始値 → 最後の終値のリターンと、終値の最大ドローダウン (fromTs より前の足は使わない)", () => {
    const cs = [candle(0, 50, 60), candle(H4, 100, 110), candle(2 * H4, 110, 90), candle(3 * H4, 90, 120)];
    const b = buyAndHold(cs, H4, H4)!;
    expect(b.from).toBe(H4);
    expect(b.to).toBe(4 * H4);
    expect(b.returnPct).toBeCloseTo(0.2, 10);
    expect(b.maxDrawdown).toBeCloseTo((110 - 90) / 110, 10);
    expect(b.curve[0]).toEqual({ ts: H4, value: 1 });
    expect(b.curve.at(-1)).toEqual({ ts: 4 * H4, value: 1.2 });
    expect(buyAndHold(cs, 10 * H4, H4)).toBeUndefined();
  });
});

describe("区間別の成績", () => {
  it("通しの結果を等分して切り出す (取引は決済時刻、合計 R・勝率・PF)", () => {
    const curve = [pt(0, 1_000_000), pt(10, 1_010_000), pt(20, 1_000_000), pt(30, 1_030_000)];
    const trades = [trade(10_000, 1, 5), trade(-10_000, -1, 15), trade(20_000, 2, 25), trade(10_000, 1, 28)];
    const f = foldSummaries({ trades, equityCurve: curve }, 0, 30, 3);
    expect(f.map((x) => x.trades)).toEqual([1, 1, 2]);
    expect(f.map((x) => x.totalR)).toEqual([1, -1, 3]);
    expect(f[2].winRate).toBe(1);
    expect(f[1].profitFactor).toBe(0);
    expect(f[0].returnPct).toBeCloseTo(0.01, 10);
    expect(foldSummaries({ trades, equityCurve: curve }, 0, 30, 0)).toEqual([]);
    const table = formatFoldRows(f);
    expect(table).toContain("合計R");
    expect(table).toContain("+3.00R");
    expect(table.split("\n")).toHaveLength(5);
  });
});

describe("複数銘柄の合計", () => {
  it("取引数・合計 R・勝率・PF (初期評価額比で合算)・等加重の合成の最大ドローダウン・保有の合成", () => {
    const rows = aggregateAcrossSymbols([
      {
        symbol: "A", strategyId: "s", initialEquity: 1_000_000, trades: [trade(20_000, 2), trade(-10_000, -1)],
        equityCurve: [pt(1, 1_020_000), pt(2, 1_010_000)],
        benchmark: { from: 0, to: 2, returnPct: 0.5, maxDrawdown: 0.1, curve: [{ ts: 1, value: 1.5 }, { ts: 2, value: 1.5 }] },
      },
      {
        symbol: "B", strategyId: "s", initialEquity: 1_000_000, trades: [trade(-10_000, -1)],
        equityCurve: [pt(1, 990_000), pt(2, 990_000)],
        benchmark: { from: 0, to: 2, returnPct: -0.5, maxDrawdown: 0.5, curve: [{ ts: 1, value: 0.5 }, { ts: 2, value: 0.5 }] },
      },
      { symbol: "A", strategyId: "t", initialEquity: 1_000_000, trades: [], equityCurve: [pt(1, 1_000_000)] },
    ]);
    expect(rows.map((r) => r.strategyId)).toEqual(["s", "t"]);
    const s = rows[0];
    expect(s.symbols).toBe(2);
    expect(s.trades).toBe(3);
    expect(s.totalR).toBe(0);
    expect(s.winRate).toBeCloseTo(1 / 3, 10);
    expect(s.profitFactor).toBeCloseTo(1, 10);
    expect(s.returnPct).toBeCloseTo(0, 10);
    // 合成: t=1 → (1.02 + 0.99) / 2 = 1.005、t=2 → 1.0
    expect(s.maxDrawdown).toBeCloseTo(0.005 / 1.005, 10);
    expect(s.benchmarkReturnPct).toBeCloseTo(0, 10);
    expect(s.benchmarkMaxDrawdown).toBe(0);
    expect(rows[1].trades).toBe(0);
    expect(rows[1].benchmarkReturnPct).toBeUndefined();
    expect(formatAggregateRows(rows)).toContain("最大DD(合成)");
  });

  it("等加重の曲線: 系列が始まる前は 1、終わった後は最後の値", () => {
    expect(equalWeightCurve([[{ ts: 1, value: 2 }], [{ ts: 2, value: 4 }]])).toEqual([{ ts: 1, value: 1.5 }, { ts: 2, value: 3 }]);
    expect(totalR([{ rMultiple: 1 }, { rMultiple: NaN }, { rMultiple: -0.5 }])).toBe(0.5);
  });

  it("実際の期間が短ければ警告 (1 日未満のずれは警告しない)", () => {
    expect(coverageWarning({ requestedFrom: 0, from: DAY / 2, to: 10 * DAY }, 10 * DAY)).toBeUndefined();
    expect(coverageWarning({ requestedFrom: 0, from: 3 * DAY, to: 10 * DAY }, 10 * DAY)).toMatch(/要求の 10\.0 日より短い/);
    expect(coverageWarning({ requestedFrom: 0, from: 0, to: 5 * DAY }, 10 * DAY)).toMatch(/最近の足が欠けています/);
  });
});

/** 4h・1d だけを使う戦略 (足の取得の確認用。シグナルは出さない) */
const fourHour: Strategy = {
  id: "test_4h", horizon: "short", assetClasses: ["crypto"], regimes: ["trend_up"], primaryTimeframe: "4h", timeframes: ["4h", "1d"], warmup: 60,
  defaultParams: {}, paramBounds: {}, evaluate: () => null,
};

const inst: Instrument = {
  symbol: "SOL/USDT", venue: "ccxt:binance", assetClass: "crypto", baseCurrency: "SOL", quoteCurrency: "USDT", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: false,
};

/** since から 1 回 perCall 本までを返す取引所の feed (呼ばれた時間足を記録) */
function pagedFeed(perCall: number, first = 0): MarketDataFeed & { tfs: Timeframe[]; calls: number } {
  const f = {
    venue: "mock", tfs: [] as Timeframe[], calls: 0,
    listInstruments: async () => [inst],
    fetchQuote: async () => { throw new Error("no quote"); },
    async fetchCandles(_s: string, tf: Timeframe, limit: number, since?: number) {
      f.tfs.push(tf);
      f.calls++;
      const ms = TIMEFRAME_MS[tf];
      const start = Math.max(first, Math.ceil((since ?? 0) / ms) * ms);
      const n = Math.min(limit, perCall);
      return Array.from({ length: n }, (_, i) => start + i * ms).filter((ts) => ts + ms <= NOW).map((ts) => candle(ts, 100 + (ts / ms) % 7, 101 + (ts / ms) % 5));
    },
  };
  return f;
}
const NOW = Date.UTC(2026, 10, 24);

describe("長期の実データの取得", () => {
  it("4h の戦略は 1000 日でも 4h の足だけを取る (1m を取らない)", async () => {
    const feed = pagedFeed(1000);
    const rows = await runBacktestCommand({ strategy: fourHour.id, strategies: [fourHour], days: 1000, source: "ccxt", seed: 1, feed, symbol: "SOL/USDT", now: NOW });
    expect(new Set(feed.tfs)).toEqual(new Set(["4h"]));
    expect(rows[0].baseTimeframe).toBe("4h");
    expect(rows[0].bars).toBe(1000 * 6 + 110);
    expect(feed.calls).toBeLessThanOrEqual(8);
    expect(rows[0].period!.from).toBe(NOW - 1000 * DAY);
    expect(rows[0].period!.to).toBe(NOW);
    expect(rows[0].benchmark).toBeDefined();
    expect(formatBacktestRows(rows, { benchmark: true })).toContain("保有リターン");
    expect(formatBacktestRows(rows)).not.toContain("保有リターン");
  });

  it("1 回の上限が小さい取引所 (300 本) でもページングで全期間を取る。進まない・0 本なら止まる", async () => {
    const feed = pagedFeed(300);
    const from = NOW - 2500 * H4;
    const got = await fetchCandlesPaged(feed, "SOL/USDT", "4h", from, NOW);
    expect(got).toHaveLength(2500);
    expect(feed.calls).toBe(9);
    // since を無視して同じ最初の 300 本を返し続ける取引所: 2 回目は新しい足が無く (進まず) 止まる
    const stuck = { fetchCandles: vi.fn(async () => Array.from({ length: 300 }, (_, i) => candle(from + i * H4, 1, 1))) };
    const s = await fetchCandlesPaged(stuck, "X", "4h", from, NOW);
    expect(s).toHaveLength(300);
    expect(stuck.fetchCandles).toHaveBeenCalledTimes(2);
    const empty = { fetchCandles: vi.fn(async () => [] as Candle[]) };
    expect(await fetchCandlesPaged(empty, "X", "4h", from, NOW)).toEqual([]);
    expect(empty.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it("1 ページが小さくても長い期間を途中で打ち切らない (ページ数の上限は本数から決める)", async () => {
    const feed = pagedFeed(50);
    const from = NOW - 30_000 * H4;
    const got = await fetchCandlesPaged(feed, "SOL/USDT", "4h", from, NOW);
    expect(got).toHaveLength(30_000);
  });

  it("履歴が要求より短い (上場が新しい) ときは取れた最初の足からウォームアップしてトレードし、実際の期間を返す", async () => {
    const listed = NOW - 200 * DAY;
    const feed = pagedFeed(1000, listed);
    const rows = await runBacktestCommand({ strategy: fourHour.id, strategies: [fourHour], days: 1000, source: "ccxt", seed: 1, feed, symbol: "SOL/USDT", now: NOW, folds: 4 });
    const p = rows[0].period!;
    expect(p.requestedFrom).toBe(NOW - 1000 * DAY);
    expect(p.from).toBe(listed + 110 * H4);
    expect(coverageWarning(p, NOW)).toMatch(/要求の 1000\.0 日より短い/);
    expect(rows[0].folds).toHaveLength(4);
    expect(rows[0].folds![0].from).toBe(p.from);
  });

  it("adjustInstrument で銘柄定義 (コスト) を差し替える。例外は足を取る前に出る", async () => {
    const feed = pagedFeed(1000);
    const rows = await runBacktestCommand({
      strategy: fourHour.id, strategies: [fourHour], days: 30, source: "ccxt", seed: 1, feed, symbol: "SOL/USDT", now: NOW,
      adjustInstrument: (i) => ({ ...i, takerFeeRate: 0, makerFeeRate: 0, fixedFeePerOrder: 0.02 }),
    });
    expect(rows[0].instrument).toMatchObject({ takerFeeRate: 0, fixedFeePerOrder: 0.02 });
    const f2 = pagedFeed(1000);
    await expect(runBacktestCommand({
      strategy: fourHour.id, strategies: [fourHour], days: 30, source: "ccxt", seed: 1, feed: f2, symbol: "SOL/USDT", now: NOW,
      adjustInstrument: () => { throw new Error("USD 建てだけ"); },
    })).rejects.toThrow(/USD 建てだけ/);
    expect(f2.calls).toBe(0);
  });
});
