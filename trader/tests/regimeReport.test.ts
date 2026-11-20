/** regime コマンドの純粋関数 (合成の足、オフライン) */
import { describe, expect, it } from "vitest";
import type { Candle, Instrument, Timeframe } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { buildRegimeReport, confirmedCount, formatRegimeReport, regimeNeed, regimeSeries, regimeTimes, runRegimeCommand } from "../src/engine/regimeReport";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { regimeOptionsFor } from "../src/regime/detect";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5);
const opts = regimeOptionsFor("crypto");

/** 1m の合成足: 毎本 drift だけ動き、ノイズは小さい (一定のトレンド) */
function trendCandles(n: number, drift: number, start = 10_000_000, tf: Timeframe = "1m", seed = 1): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  const out: Candle[] = [];
  const rng = mulberry32(seed);
  let px = start;
  for (let i = 0; i < n; i++) {
    const open = px;
    // 値幅は乱数で散らす (一定だとボラティリティの順位が常に最大になり high_vol になってしまう)
    const close = px + drift + (rng() - 0.5) * 20;
    out.push({ ts: T0 + i * ms, open, close, high: Math.max(open, close) + rng() * 10, low: Math.min(open, close) - rng() * 10, volume: 1 });
    px = close;
  }
  return out;
}

describe("regimeReport", () => {
  it("下降トレンドの足で trend_down が出る (上昇なら trend_up)", () => {
    const need = regimeNeed(opts);
    const n = need + 60;
    const times = [T0 + n * MIN];
    const down = regimeSeries(trendCandles(n, -30), "1m", times, opts);
    expect(down.cells[0].label).toBe("trend_down");
    expect(down.cells[0].trend!).toBeLessThan(0);
    expect(down.cells[0].adx!).toBeGreaterThan(25);
    const up = regimeSeries(trendCandles(n, 30), "1m", times, opts);
    expect(up.cells[0].label).toBe("trend_up");
  });

  it("先読みしない: 時刻 t より後の足を変えても t の判定は変わらない", () => {
    const need = regimeNeed(opts);
    const base = trendCandles(need + 80, -30);
    const t = T0 + (need + 40) * MIN;
    const changed = base.map((c, i) => (i >= need + 40 ? { ...c, open: 1, high: 1e9, low: 1, close: 5e8 } : c));
    const a = regimeSeries(base, "1m", [t], opts).cells[0];
    const b = regimeSeries(changed, "1m", [t], opts).cells[0];
    expect(b).toEqual(a);
    // 確定の境界: ts + tf <= t の足だけを数える (t ちょうどに始まる足は未確定)
    expect(confirmedCount(base, MIN, T0 + 10 * MIN)).toBe(10);
    expect(confirmedCount(base, MIN, T0 + 10 * MIN - 1)).toBe(9);
    expect(a.bars).toBe(need + 40);
  });

  it("必要本数に足りない時間足は「足りない」、集計から除く。ラベル変化に印が付き、割合が合う", () => {
    const need = regimeNeed(opts);
    // 前半は下降、後半は急に上昇
    const down = trendCandles(need + 30, -30);
    const last = down[down.length - 1].close;
    const up = trendCandles(120, 40, last).map((c, i) => ({ ...c, ts: T0 + (need + 30 + i) * MIN }));
    const candles = [...down, ...up];
    const times = regimeTimes(T0 + (need - 5) * MIN, T0 + (need + 150) * MIN, 5 * MIN);
    const s = regimeSeries(candles, "1m", times, opts);
    expect(s.insufficient).toBeGreaterThan(0);
    expect(s.cells.filter((c) => !c.label).length).toBe(s.insufficient);
    const judged = s.cells.filter((c) => c.label);
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(judged.length);
    expect(s.cells.length).toBe(s.insufficient + total);
    for (const l of Object.keys(s.counts) as (keyof typeof s.counts)[]) expect(s.counts[l]).toBe(judged.filter((c) => c.label === l).length);
    // changed は直前の判定済みの行とラベルが違うときだけ
    judged.forEach((c, i) => expect(!!c.changed).toBe(i > 0 && judged[i - 1].label !== c.label));
    expect(judged.some((c) => c.changed)).toBe(true);
    // 足が全く足りない時間足
    const [short] = buildRegimeReport({ candlesByTf: { "4h": trendCandles(10, -5, 10_000_000, "4h") }, timeframes: ["4h"], from: T0, until: T0 + 3 * 3_600_000, stepMs: 5 * MIN });
    expect(short.insufficient).toBe(short.cells.length);
    const text = formatRegimeReport([short, s], { symbol: "BTC/JPY", from: T0, until: T0 + 3_600_000, stepMs: 5 * MIN });
    expect(text).toContain("足りない");
    expect(text).toContain("スプレッドは 0");
    expect(text).toContain("◀ 変化");
    expect(text).toContain("下降トレンド");
  });

  it("runRegimeCommand: feed (モック) から足を取り、時間足ごとに表示する", async () => {
    const need = regimeNeed(opts);
    const now = T0 + (need + 400) * MIN;
    const all = trendCandles(need + 400, -30);
    const inst = { symbol: "BTC/JPY", assetClass: "crypto" } as unknown as Instrument;
    const feed = {
      listInstruments: async () => [inst],
      fetchCandles: async (_s: string, tf: Timeframe, limit: number, since?: number) =>
        tf === "1m" ? all.filter((c) => c.ts >= (since ?? 0)).slice(0, limit) : [],
    };
    const text = await runRegimeCommand({ feed, symbol: "BTC/JPY", hours: 1, timeframes: ["1m", "15m"], now });
    expect(text).toContain("■ 1m");
    expect(text).toContain("下降トレンド");
    expect(text).toMatch(/■ 15m[\s\S]*足りない/);
    await expect(runRegimeCommand({ feed, symbol: "XXX/JPY", hours: 1, now })).rejects.toThrow(/銘柄/);
  });
});
