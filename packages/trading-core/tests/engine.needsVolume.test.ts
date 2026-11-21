/**
 * Strategy.needsVolume: 出来高が後から分かる feed (Jupiter: volumeKnown が false → true) で、出来高が不明な間は
 * 同じ足を評価済みにせず次のティックで取り直す (足の確定から VOLUME_RETRY_MAX_MS まで)。コアだけで動かす (ネット不要)。
 */
import { describe, expect, it } from "vitest";
import type { Candle, Clock, MarketDataFeed, Quote, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { VOLUME_RETRY_MAX_MS } from "../src/engine/engine";
import { ClosedCandleCacheFeed } from "../src/engine/feedCache";
import { assembleRuntime } from "../src/engine/runtime";
import { defaultSyntheticSpecs, mulberry32, SyntheticFeed } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { shortBreakout } from "../src/strategies/short";
import { VOLUME_WINDOW_BARS, volumeWindowUnknown } from "../src/strategies/common";
import { testConfig } from "../src/testing/runtime";

const MIN = 60_000;
const HOUR = 3_600_000;
/** 1h の足の確定の直後 (足 23:00 が確定した時刻) */
const START = Date.UTC(2026, 0, 5);
const SYMBOL = "BTC/USDT";

/** 足の出来高の既知・不明を切り替える feed (Jupiter の volumeKnown の再現)。mode: "unknown" = false / "known" = true / "none" = 項目なし (ccxt・合成) */
class VolumeFlagFeed implements MarketDataFeed {
  readonly venue: string;
  /** Jupiter と同じく、hub は毎回足を取り直す (後から埋めた出来高を反映する) */
  readonly candlesAreLocal = true;
  mode: "unknown" | "known" | "none";
  constructor(private readonly inner: MarketDataFeed, mode: "unknown" | "known" | "none") {
    this.venue = inner.venue;
    this.mode = mode;
  }
  listInstruments() {
    return this.inner.listInstruments();
  }
  fetchQuote(symbol: string): Promise<Quote> {
    return this.inner.fetchQuote(symbol);
  }
  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const rows = await this.inner.fetchCandles(symbol, tf, limit, since);
    if (this.mode === "none") return rows;
    return rows.map((c) => ({ ...c, volumeKnown: this.mode === "known" }));
  }
}

/** 評価の回数を数える 1h の戦略 (常にシグナルなし)。needsVolume で出来高待ちの有無を切り替える */
function probe(id: string, needsVolume: boolean): Strategy & { calls: number[] } {
  const calls: number[] = [];
  return {
    id, horizon: "short", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    ...(needsVolume ? { needsVolume: true } : {}),
    primaryTimeframe: "1h", timeframes: ["1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    calls,
    evaluate(ctx: StrategyContext): Signal | null {
      calls.push(ctx.market.candles["1h"]!.at(-1)!.ts);
      return null;
    },
  };
}

/** 保有していなければ買う 1h の戦略 (needsVolume)。保有中の評価 (決済側) の回数も数える */
function longOnce(id: string): Strategy & { entryCalls: number[]; heldCalls: number[] } {
  const entryCalls: number[] = [];
  const heldCalls: number[] = [];
  return {
    id, horizon: "short", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    needsVolume: true,
    primaryTimeframe: "1h", timeframes: ["1h"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    entryCalls, heldCalls,
    evaluate(ctx: StrategyContext): Signal | null {
      const ts = ctx.market.candles["1h"]!.at(-1)!.ts;
      if (ctx.position) {
        heldCalls.push(ts);
        return null;
      }
      entryCalls.push(ts);
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "short", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 300,
        entry: { type: "market" }, stopLoss: px * 0.9, maxHoldMs: 6 * HOUR, reason: `test ${id}`, features: { x: 1 },
      };
    },
  };
}

async function setup(mode: "unknown" | "known" | "none", strategies: readonly Strategy[]) {
  const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
  const specs = defaultSyntheticSpecs().filter((s) => s.instrument.symbol === SYMBOL);
  const inner = new ClosedCandleCacheFeed(new SyntheticFeed({ seed: 3, clock, historyMs: 3 * 86_400_000, specs }), { clock });
  const feed = new VolumeFlagFeed(inner, mode);
  const instruments = await feed.listInstruments();
  const runtime = await assembleRuntime(
    testConfig({ LIMIT_TAKE_PROFIT: "false", BASE_CURRENCY: "JPY" }),
    { markets: [{ feed, instruments }] },
    { clock, store: new MemoryStore(), intelSources: [], ai: null, rng: mulberry32(7), strategies },
  );
  const tickAt = async (t: number) => {
    clock.t = t;
    return runtime.engine.tick(t);
  };
  return { runtime, feed, tickAt };
}

describe("needsVolume: 出来高が不明な間は評価済みにせず取り直す", () => {
  it("short_breakout だけが needsVolume (1m の戦略には付けない)", async () => {
    const { ALL_STRATEGIES } = await import("../src/strategies/registry");
    expect(ALL_STRATEGIES.filter((s) => s.needsVolume).map((s) => s.id)).toEqual(["short_breakout"]);
    expect(shortBreakout.primaryTimeframe).toBe("1h");
  });

  it("volumeWindowUnknown: 末尾 21 本だけを見る (それより古い不明な足は無視)", () => {
    const mk = (n: number, bad: number[]): Candle[] =>
      Array.from({ length: n }, (_, i) => ({ ts: i * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1, ...(bad.includes(i) ? { volumeKnown: false } : {}) }));
    expect(volumeWindowUnknown(mk(100, []))).toBe(false);
    expect(volumeWindowUnknown(mk(100, [99]))).toBe(true);
    expect(volumeWindowUnknown(mk(100, [100 - VOLUME_WINDOW_BARS]))).toBe(true);
    expect(volumeWindowUnknown(mk(100, [100 - VOLUME_WINDOW_BARS - 1]))).toBe(false);
  });

  it("出来高が不明な間は評価されず、同じ足で分かったら 1 回だけ評価される", async () => {
    const s = probe("probe_vol", true);
    const { feed, tickAt } = await setup("unknown", [s]);
    for (const dt of [0, 30_000, MIN, 2 * MIN]) await tickAt(START + dt);
    expect(s.calls).toHaveLength(0);
    // 出来高が分かった (同じ足)
    feed.mode = "known";
    await tickAt(START + 3 * MIN);
    expect(s.calls).toEqual([START - HOUR]);
    // 以後は同じ足を評価しない
    for (const dt of [4 * MIN, 5 * MIN, 30 * MIN]) await tickAt(START + dt);
    expect(s.calls).toHaveLength(1);
  });

  it("足の確定から 10 分たっても不明なら待たずに 1 回評価して (fail-closed)、評価済みにする", async () => {
    const s = probe("probe_vol", true);
    const { tickAt } = await setup("unknown", [s]);
    await tickAt(START + VOLUME_RETRY_MAX_MS - 1_000);
    expect(s.calls).toHaveLength(0);
    await tickAt(START + VOLUME_RETRY_MAX_MS);
    expect(s.calls).toEqual([START - HOUR]);
    await tickAt(START + VOLUME_RETRY_MAX_MS + 30_000);
    await tickAt(START + 20 * MIN);
    expect(s.calls).toHaveLength(1);
  });

  it("次の足が出たら新しい足を (その足の出来高待ちから) 数え直す", async () => {
    const s = probe("probe_vol", true);
    const { feed, tickAt } = await setup("unknown", [s]);
    await tickAt(START + 10 * MIN); // 10 分で諦めて評価
    expect(s.calls).toEqual([START - HOUR]);
    await tickAt(START + HOUR + MIN); // 新しい足 (00:00) は確定の直後なので待つ
    expect(s.calls).toHaveLength(1);
    feed.mode = "known";
    await tickAt(START + HOUR + 2 * MIN);
    expect(s.calls).toEqual([START - HOUR, START]);
  });

  it("volumeKnown を持たない足 (ccxt・合成) は従来どおり最初のティックで 1 回評価", async () => {
    const s = probe("probe_vol", true);
    const { tickAt } = await setup("none", [s]);
    await tickAt(START);
    expect(s.calls).toEqual([START - HOUR]);
    await tickAt(START + 30_000);
    await tickAt(START + 5 * MIN);
    expect(s.calls).toHaveLength(1);
  });

  it("needsVolume でない戦略は、出来高が不明でも最初のティックで評価済みにする (従来どおり)", async () => {
    const s = probe("probe_plain", false);
    const { tickAt } = await setup("unknown", [s]);
    await tickAt(START);
    expect(s.calls).toEqual([START - HOUR]);
    await tickAt(START + 30_000);
    await tickAt(START + 5 * MIN);
    expect(s.calls).toHaveLength(1);
  });

  it("保有中の評価 (決済側) は出来高を待たない", async () => {
    const s = longOnce("long_once");
    const { runtime, feed, tickAt } = await setup("known", [s]);
    await tickAt(START);
    expect(s.entryCalls).toEqual([START - HOUR]);
    expect(runtime.engine.positions.list()).toHaveLength(1);
    // 次の足 (出来高は不明) でも、保有中なら新しい足をすぐ評価する
    feed.mode = "unknown";
    await tickAt(START + HOUR + 30_000);
    expect(s.heldCalls).toEqual([START]);
    expect(s.entryCalls).toHaveLength(1);
  });
});
