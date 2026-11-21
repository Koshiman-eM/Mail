/**
 * テンポ・最大保有の周辺: バックテストの maxHoldMinutes、backtest コマンドの扱い、表示 (status の 1 行・report の区分)、
 * 再起動時の復元の時刻の選び方。すべて合成データ (オフライン)
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { syntheticInstrument } from "../src/backtest/synthetic";
import { buildReportText, tempoStatusLine } from "../src/cli";
import { loadConfig } from "../src/core/config";
import type { Candle, Signal, Strategy, StrategyContext, TradeRecord } from "../src/core/types";
import { runBacktestCommand } from "../src/engine/backtestCommand";
import { renderTempoTable, summarizeByTempo, tempoClassOf } from "../src/engine/report";
import {
  clampMaxHoldMs, formatTempoLine, isHoldLimitedHorizon, TempoController, tempoSeedTimestamps, tempoStatusView,
} from "../src/engine/tempo";
import { MemoryStore } from "../src/storage/memory";

const M = 60_000;
const T0 = Date.UTC(2024, 0, 1);

describe("clampMaxHoldMs / isHoldLimitedHorizon", () => {
  it("上限までに縮める。0・非有限 (時間切れなし) は上限。上限が無効ならそのまま", () => {
    expect(clampMaxHoldMs(60 * M, 30 * M)).toBe(30 * M);
    expect(clampMaxHoldMs(10 * M, 30 * M)).toBe(10 * M);
    expect(clampMaxHoldMs(0, 30 * M)).toBe(30 * M);
    expect(clampMaxHoldMs(NaN, 30 * M)).toBe(30 * M);
    expect(clampMaxHoldMs(60 * M, undefined)).toBe(60 * M);
    expect(clampMaxHoldMs(60 * M, 0)).toBe(60 * M);
    expect(clampMaxHoldMs(0, undefined)).toBe(0);
  });

  it("中期・長期だけが対象", () => {
    expect(["scalp", "short", "mid", "long"].map(isHoldLimitedHorizon)).toEqual([false, false, true, true]);
    expect(isHoldLimitedHorizon(undefined)).toBe(false);
  });
});

describe("バックテスト: maxHoldMinutes", () => {
  const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ ts: T0 + i * M, open: 100, high: 100, low: 100, close: 100, volume: 100 }));
  const once = (holdMs: number): Strategy => {
    let fired = false;
    return {
      id: "hold", horizon: "scalp", assetClasses: ["crypto"], regimes: ["range", "trend_up", "trend_down", "high_vol", "low_liquidity"],
      primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: {}, paramBounds: {},
      evaluate(ctx: StrategyContext): Signal | null {
        if (ctx.position || fired) return null;
        fired = true;
        return {
          strategyId: "hold", horizon: "scalp", symbol: "SYN/USDT", direction: "long", confidence: 0.7, expectedEdgeBps: 100, entry: { type: "market" },
          stopLoss: 90, takeProfit: 110, maxHoldMs: holdMs, reason: "t", features: {},
        };
      },
    };
  };
  const inst = syntheticInstrument({ takerFeeRate: 0.001, tickSize: 0, lotSize: 0, minQty: 0 });

  it("シグナルの最大保有をその分数までに縮める (時間切れ)。省略時は従来どおり", () => {
    const base = runBacktest({ strategy: once(60 * M), instrument: inst, candles: flat(120), spreadBps: 0, slippageBps: 0 });
    expect(base.trades).toHaveLength(1);
    expect(base.trades[0].exitTs - base.trades[0].entryTs).toBe(60 * M);
    const r = runBacktest({ strategy: once(60 * M), instrument: inst, candles: flat(120), spreadBps: 0, slippageBps: 0, maxHoldMinutes: 5 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe("time");
    expect(r.trades[0].exitTs - r.trades[0].entryTs).toBe(5 * M);
    // 時間切れなし (0) のシグナルも上限で決済する
    const z = runBacktest({ strategy: once(0), instrument: inst, candles: flat(120), spreadBps: 0, slippageBps: 0, maxHoldMinutes: 7 });
    expect(z.trades[0].exitTs - z.trades[0].entryTs).toBe(7 * M);
    // 0 以下は無効
    const off = runBacktest({ strategy: once(60 * M), instrument: inst, candles: flat(120), spreadBps: 0, slippageBps: 0, maxHoldMinutes: 0 });
    expect(off.trades[0].exitTs - off.trades[0].entryTs).toBe(60 * M);
  });

  it("backtest コマンド: 中期・長期は縮めず、運用では発注しない旨を備考に出す", async () => {
    const rows = await runBacktestCommand({ strategy: "mid_trend_follow", days: 30, source: "synthetic", seed: 1, maxHoldMinutes: 30 });
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain("最大保有 30 分のため運用では発注しない");
    const scalp = await runBacktestCommand({ strategy: "scalp_micro", days: 1, source: "synthetic", seed: 1, maxHoldMinutes: 30 });
    expect(scalp[0].note ?? "").not.toContain("最大保有");
  }, 60_000);
});

describe("テンポの表示", () => {
  it("formatTempoLine: 目標・直近 1 時間・テンポ・上限・探索・最大保有", () => {
    const tc = new TempoController({ targetPerHour: 6, now: T0 });
    tc.recordEntry(T0 + 5 * M);
    const v = tempoStatusView(tc, T0 + 20 * M, true);
    expect(v).toMatchObject({ enabled: true, target: 6, entriesInWindow: 1, capAt: 12, capped: false, exploreAllowed: true });
    expect(formatTempoLine(v, 30)).toBe(
      `テンポ: 目標 6 回/時・直近 1 時間 1 回 (最後のエントリーから 15 分)・テンポ ${v.tempo.toFixed(2)}・上限 12 回・探索 可・最大保有 30 分`,
    );
    for (let k = 0; k < 11; k++) tc.recordEntry(T0 + (6 + k) * M);
    const capped = tempoStatusView(tc, T0 + 20 * M, false);
    expect(capped.capped).toBe(true);
    expect(formatTempoLine(capped, 0)).toContain("上限到達 (12 回)・探索 不可・最大保有 無効");
    expect(formatTempoLine(tempoStatusView(undefined, T0, true), 30)).toBe("テンポ: 無効 (TARGET_ENTRIES_PER_HOUR=0)・最大保有 30 分");
  });

  it("tempoSeedTimestamps: 決済済みは窓の中だけ、保有中は窓より古くても含める (未来・非有限は除く)", () => {
    const now = T0 + 120 * M;
    expect(tempoSeedTimestamps([now - 90 * M, now - 60 * M, now - 59 * M, now + M, NaN], [now - 100 * M, now - 5 * M, now + M], now)).toEqual([
      now - 59 * M, now - 100 * M, now - 5 * M,
    ]);
  });

  it("status の 1 行: この mode の直近 1 時間の取引と保有中のエントリーから数える", () => {
    const store = new MemoryStore();
    const now = T0 + 120 * M;
    store.saveTrade(trade("a", now - 30 * M));
    store.saveTrade(trade("b", now - 20 * M));
    store.saveTrade(trade("c", now - 10 * M, { mode: "live" }));
    store.saveTrade(trade("old", now - 90 * M));
    const cfg = loadConfig({ TARGET_ENTRIES_PER_HOUR: "6", MAX_HOLD_MINUTES: "30" });
    const line = tempoStatusLine(cfg, store, "paper", [now - 5 * M], now);
    expect(line).toMatch(/^テンポ: 目標 6 回\/時・直近 1 時間 3 回 \(最後のエントリーから 5 分\)・テンポ 0\.00・上限 12 回・探索 可・最大保有 30 分$/);
    expect(tempoStatusLine(cfg, store, "live", [], now)).toContain("直近 1 時間 1 回");
    expect(tempoStatusLine(cfg, store, "live", [], now)).toContain("探索 不可");
    expect(tempoStatusLine(loadConfig({ TARGET_ENTRIES_PER_HOUR: "6", TEMPO_ALLOW_LIVE_EXPLORE: "true" }), store, "live", [], now)).toContain("探索 可");
    expect(tempoStatusLine(loadConfig({}), store, "paper", [], now)).toBe("テンポ: 無効 (TARGET_ENTRIES_PER_HOUR=0)・最大保有 無効");
  });

  it("report: 探索 / 通常 (テンポ有効) / 通常 (テンポ無効) に分けて取引数・勝率・純損益を出す", () => {
    const ex1 = trade("e1", T0, { netPnl: -2, features: { tempoLevel: 1, tempoExplore: 1 } });
    const ex2 = trade("e2", T0, { netPnl: 1, features: { tempoLevel: 0.8, tempoExplore: 1 } });
    const nt = trade("n1", T0, { netPnl: 3, features: { tempoLevel: 0 } });
    const old = trade("o1", T0, { netPnl: 5 });
    expect([ex1, ex2, nt, old].map(tempoClassOf)).toEqual(["explore", "explore", "tempo_normal", "no_tempo"]);
    const rows = summarizeByTempo([old, nt, ex1, ex2], () => 1, () => "USDT");
    expect(rows.map((r) => [r.kind, r.trades, r.wins, r.netPnl])).toEqual([
      ["explore", 2, 1, -1],
      ["tempo_normal", 1, 1, 3],
      ["no_tempo", 1, 1, 5],
    ]);
    const txt = renderTempoTable(rows, "JPY");
    expect(txt).toContain("探索 (期待値 ≤ 0、縮小サイズ)");
    expect(txt).toContain("50.0%");
    expect(renderTempoTable(summarizeByTempo([old], () => 1, () => "USDT"), "JPY")).toContain("探索のエントリーはありません");
    // report コマンドにも区分の表が出る
    const store = new MemoryStore();
    for (const t of [ex1, ex2, nt, old]) store.saveTrade(t);
    const text = buildReportText(loadConfig({ DB_PATH: "memory" }), store, T0 + 10 * M);
    expect(text).toContain("■ テンポの探索と通常のエントリー");
    expect(text).toContain("通常 (テンポ有効)");
  });
});

function trade(id: string, entryTs: number, o: { mode?: "paper" | "live"; netPnl?: number; features?: Record<string, number> } = {}): TradeRecord {
  const net = o.netPnl ?? 0.9;
  return {
    id, mode: o.mode ?? "paper", symbol: "BTC/USDT", venue: "paper", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 1,
    entryTs, entryPrice: 100, intendedEntryPrice: 100, exitTs: entryTs + 5 * M, exitPrice: 101, intendedExitPrice: 101, initialStop: 99,
    grossPnl: net + 0.1, fees: 0.1, netPnl: net, returnPct: net / 100, rMultiple: net, mfePct: 0.012, maePct: 0.002, exitReason: "take_profit",
    entryContext: {
      regime: { label: "range", trend: 0, trendStrength: 10, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 },
      confidence: 0.6, expectedEdgeBps: 30, costBps: 10, params: {}, features: o.features ?? {}, riskMultiplier: 1, reason: "test",
    },
  };
}
