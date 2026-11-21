/** 相場構造のラッパー withStructure: フィルター・MTF・構造の損切り・決済・設定・off で従来と同一 */
import { describe, expect, it } from "vitest";
import { syntheticInstrument } from "../src/backtest/synthetic";
import { loadConfig } from "../src/core/config";
import type { Candle, Clock, PositionView, RegimeFeatures, Signal, Strategy, StrategyContext } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { buildRuntime } from "../src/engine/setup";
import { resample } from "../src/indicators/resample";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { MemoryStore } from "../src/storage/memory";
import { ALL_STRATEGIES, configuredStrategies, getStrategy } from "../src/strategies/registry";
import { structureAt } from "../src/structure/machine";
import { applyStructure, defaultStructureSettings, structureSettingsFromEnv } from "../src/structure/settings";
import {
  biasNum,
  isStructureWrapped,
  resolveStructureFilterConfig,
  type StructureFilterConfig,
  structureWarmupBars,
  withStructure,
} from "../src/structure/wrap";
import { lineBars, path, T0 } from "./helpers/structureBars";

const M15 = TIMEFRAME_MS["15m"];
const H1 = TIMEFRAME_MS["1h"];
const inst = syntheticInstrument({ tickSize: 0.01 });
const REGIME: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 };

/** 上目線で終わる執行足 (押し安値 107) / 下目線で終わる執行足 (戻り高値 113) */
const UP = path(100, 110, 104, 114, 107, 118, 112);
const DOWN = path(120, 110, 116, 106, 113, 100, 108);
const BASE: Partial<StructureFilterConfig> = { pivotN: 2 };

/** 毎回同じ方向のシグナル (損切り 2、利確 4 = 2R) を出す戦略 */
function fake(dir: Signal["direction"] | null, id = "fake_trend"): Strategy {
  return {
    id, horizon: "short", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down", "range", "high_vol"],
    primaryTimeframe: "15m", timeframes: ["15m"], warmup: 5,
    defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (dir === null) return null;
      const px = ctx.market.quote.ask;
      const sign = dir === "long" ? 1 : -1;
      return {
        strategyId: id, horizon: "short", symbol: ctx.market.instrument.symbol, direction: dir, confidence: 0.8, expectedEdgeBps: 40,
        entry: { type: "market" }, stopLoss: dir === "flat" ? 0 : px - sign * 2, takeProfit: dir === "flat" ? undefined : px + sign * 4,
        maxHoldMs: 10 * M15, reason: "fake", features: { x: 1 },
      };
    },
  };
}

interface Built {
  ctx: StrategyContext;
  filtered: { signal: Signal; reason: string }[];
}

/** 執行足 15m と上位足 1h (now より前に確定した足) から ctx を作る */
function ctxOf(execPrices: number[], upperPrices?: number[], o: { position?: "long" | "short"; quote?: number } = {}): Built {
  const exec = lineBars(execPrices, "15m");
  const now = exec[exec.length - 1].ts + M15;
  const candles: Partial<Record<"15m" | "1h", Candle[]>> = { "15m": exec };
  if (upperPrices) candles["1h"] = lineBars(upperPrices, "1h", now - upperPrices.length * H1);
  const px = o.quote ?? exec[exec.length - 1].close;
  const filtered: Built["filtered"] = [];
  const position: PositionView | undefined = o.position
    ? { symbol: inst.symbol, qty: o.position === "long" ? 1 : -1, avgPrice: px, openedAt: now - M15, strategyId: "fake_trend", stopLoss: 0, highWater: px, lowWater: px }
    : undefined;
  return {
    filtered,
    ctx: {
      market: { instrument: inst, now, quote: { ts: now, bid: px, ask: px, last: px }, candles },
      regime: REGIME,
      params: { stopAtr: 1 },
      ...(position ? { position } : {}),
      onFiltered: (signal, reason) => filtered.push({ signal, reason }),
    },
  };
}

describe("withStructure: 新規エントリーのフィルター", () => {
  it("執行足・上位足とも同じ方向なら通し、構造の状態を features に添える", () => {
    const b = ctxOf(UP, UP);
    const s = withStructure(fake("long"), BASE).evaluate(b.ctx)!;
    expect(s.direction).toBe("long");
    expect(s.stopLoss).toBe(110); // stopMode existing は元のまま
    expect(s.features).toMatchObject({ x: 1, structBias: 1, structMtfBias: 1, structOshiYasune: 107, structModoriTakane: 0, structChoppy: 0 });
    expect(b.filtered).toEqual([]);
  });

  it("目線と逆方向は通さない (structure_bias)", () => {
    const b = ctxOf(UP, UP);
    expect(withStructure(fake("short"), BASE).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_bias"]);
    expect(b.filtered[0].signal.direction).toBe("short");
    expect(b.filtered[0].signal.features.structBias).toBe(1);
    const d = ctxOf(DOWN, DOWN);
    expect(withStructure(fake("long"), BASE).evaluate(d.ctx)).toBeNull();
    expect(d.filtered[0].reason).toBe("structure_bias");
    expect(withStructure(fake("short"), BASE).evaluate(ctxOf(DOWN, DOWN).ctx)?.direction).toBe("short");
  });

  it("上位足の目線が違えば structure_mtf。useMTF=false なら通す", () => {
    const b = ctxOf(UP, DOWN);
    expect(withStructure(fake("long"), BASE).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_mtf"]);
    expect(b.filtered[0].signal.features.structMtfBias).toBe(-1);
    // 上位足が足りない (none) も不一致
    const c = ctxOf(UP, UP.slice(0, 10));
    expect(withStructure(fake("long"), BASE).evaluate(c.ctx)).toBeNull();
    expect(c.filtered[0].reason).toBe("structure_mtf");
    expect(withStructure(fake("long"), { ...BASE, useMTF: false }).evaluate(ctxOf(UP, DOWN).ctx)?.direction).toBe("long");
  });

  it("上位足が view に無ければ執行足から確定分だけ集約する", () => {
    const prices = [...UP, ...UP.map((x) => x + 18)];
    const b = ctxOf(prices);
    const exec = b.ctx.market.candles["15m"]!;
    const upper = resample(exec, "15m", "1h", { now: b.ctx.market.now });
    const expected = biasNum(structureAt(upper, undefined, { pivotN: 2 }).bias);
    const w = withStructure(fake("long"), { ...BASE, stopMode: "existing" });
    const out = w.evaluate(b.ctx) ?? b.filtered[0]?.signal;
    expect(out?.features.structMtfBias).toBe(expected);
    // 明示的に渡した 1h と同じ結果
    const c = ctxOf(prices);
    c.ctx.market.candles["1h"] = upper;
    const out2 = w.evaluate(c.ctx) ?? c.filtered[0]?.signal;
    expect(out2?.features).toEqual(out?.features);
  });

  it("目線が none (足りない) なら structure_none", () => {
    const b = ctxOf(UP.slice(0, 20), UP);
    expect(withStructure(fake("long"), BASE).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_none"]);
    expect(b.filtered[0].signal.features.structBias).toBe(0);
  });

  it("ちゃぶつき中は structure_choppy", () => {
    const chop = path(100, 110, 104, 114, 107, 118, 100, 120, 99, 125, 121);
    const b = ctxOf(chop, chop);
    expect(withStructure(fake("long"), { ...BASE, chopM: 80, chopR: 3 }).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_choppy"]);
    expect(b.filtered[0].signal.features.structChoppy).toBe(1);
  });

  it("conservative の weakening 中は structure_weakening", () => {
    const weak = path(100, 110, 104, 114, 107, 118, 103);
    const b = ctxOf(weak, UP);
    expect(withStructure(fake("long"), { ...BASE, reversalMode: "conservative" }).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_weakening"]);
    // purist では下目線 → 買いは structure_bias
    const p = ctxOf(weak, UP);
    withStructure(fake("long"), BASE).evaluate(p.ctx);
    expect(p.filtered[0].reason).toBe("structure_bias");
  });

  it("method2 / both", () => {
    // UP の最後: 方法 1 は up、方法 2 は SH 118 (HH) と SL 107 (HL) で up
    expect(withStructure(fake("long"), { ...BASE, biasMethod: "method2" }).evaluate(ctxOf(UP, UP).ctx)?.direction).toBe("long");
    // 押し安値割れの直後: 方法 1 は down、方法 2 はまだ up → both は none
    const brk = path(100, 110, 104, 114, 107, 118, 106);
    const b = ctxOf(brk, brk);
    expect(withStructure(fake("long"), { ...BASE, biasMethod: "both" }).evaluate(b.ctx)).toBeNull();
    expect(b.filtered[0].reason).toBe("structure_none");
    expect(withStructure(fake("long"), { ...BASE, biasMethod: "method2", useMTF: false }).evaluate(ctxOf(brk).ctx)?.direction).toBe("long");
  });

  it("usePerfectOrder: MA の並びが逆なら structure_po", () => {
    const b = ctxOf(UP, UP);
    expect(withStructure(fake("long"), { ...BASE, usePerfectOrder: true, perfectOrder: { type: "sma", periods: [3, 5, 8] } }).evaluate(b.ctx)).toBeNull();
    expect(b.filtered[0].reason).toBe("structure_po"); // 終盤は 118 → 112 の下落中で短期 MA が下
  });
});

describe("withStructure: 構造の損切り", () => {
  const cfg: Partial<StructureFilterConfig> = { ...BASE, stopMode: "structure", stopAtrBuffer: 0.3 };

  it("買い: 押し安値 − ATR × 0.3。利確は元の R 倍数 (2R) を保つ", () => {
    const s = withStructure(fake("long"), cfg).evaluate(ctxOf(UP, UP).ctx)!;
    // 線の足なので ATR(14) = 1。押し安値 107 → 106.7。エントリー 112 から 5.3、利確は 2 × 5.3 = 10.6 上
    expect(s.stopLoss).toBeCloseTo(106.7, 8);
    expect(s.takeProfit).toBeCloseTo(122.6, 8);
    expect((s.takeProfit! - 112) / (112 - s.stopLoss)).toBeCloseTo(2, 8);
    expect(s.expectedEdgeBps).toBeCloseTo(40, 6); // 損切りが広がっても期待値は増やさない (min(1, 10.6 / 4))
    expect(s.features.structStopDist).toBeCloseTo(5.3, 8);
  });

  it("売り: 戻り高値 + ATR × 0.3", () => {
    const s = withStructure(fake("short"), cfg).evaluate(ctxOf(DOWN, DOWN).ctx)!;
    expect(s.stopLoss).toBeCloseTo(113.3, 8);
    expect(s.takeProfit).toBeCloseTo(108 - 2 * 5.3, 8);
  });

  it("押し安値がエントリー価格の反対側 (上) にある・押し安値が無いなら structure_stop", () => {
    const b = ctxOf(UP, UP, { quote: 106.5 });
    expect(withStructure(fake("long"), cfg).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_stop"]);
    // 反転直後の上目線で押し安値がまだ確定していない (null)
    const up2 = [...path(120, 110, 116, 106, 113, 100), 114];
    const c = ctxOf(up2, UP);
    expect(withStructure(fake("long"), cfg).evaluate(c.ctx)).toBeNull();
    expect(c.filtered[0].reason).toBe("structure_stop");
  });
});

describe("withStructure: 構造の損切りの妥当性", () => {
  const cfg: Partial<StructureFilterConfig> = { ...BASE, stopMode: "structure", stopAtrBuffer: 0.3 };
  /** 元の損切り幅 stopDist・利確幅 tpDist・features を指定する戦略 (買い。ctx は UP: 価格 112、構造の損切りは 106.7 = 幅 5.3) */
  const custom = (dir: "long" | "short", stopDist: number, tpDist: number | undefined, features: Record<string, number> = {}): Strategy => {
    const base = fake(dir);
    return {
      ...base,
      evaluate(ctx) {
        const sig = base.evaluate(ctx)!;
        const px = ctx.market.quote.ask;
        const sign = dir === "long" ? 1 : -1;
        const out: Signal = { ...sig, stopLoss: px - sign * stopDist, features: { ...sig.features, ...features } };
        if (tpDist === undefined) delete out.takeProfit;
        else out.takeProfit = px + sign * tpDist;
        return out;
      },
    };
  };

  it("損切りが縮むときだけ期待値を比例して縮める (広がるときは増やさない)", () => {
    // 元の損切り 8・利確 16 → 構造の損切り 5.3 (0.66 倍)・利確 10.6。期待値 40 × 0.6625
    const narrow = withStructure(custom("long", 8, 16), cfg).evaluate(ctxOf(UP, UP).ctx)!;
    expect(narrow.stopLoss).toBeCloseTo(106.7, 8);
    expect(narrow.expectedEdgeBps).toBeCloseTo(40 * (10.6 / 16), 6);
    // 元の損切り 4・利確 8 → 構造の損切り 5.3 (1.325 倍)・利確 10.6。期待値は 40 のまま
    const wide = withStructure(custom("long", 4, 8), cfg).evaluate(ctxOf(UP, UP).ctx)!;
    expect(wide.expectedEdgeBps).toBeCloseTo(40, 6);
    // 利確なし (トレーリングなし): 目標 = max(0, 損切り幅) → 広がっても 40 を超えない
    const noTp = withStructure(custom("long", 4, undefined), cfg).evaluate(ctxOf(UP, UP).ctx)!;
    expect(noTp.takeProfit).toBeUndefined();
    expect(noTp.expectedEdgeBps).toBeCloseTo(40, 6);
  });

  it("新しい損切り幅が元の 0.5 倍未満・3 倍超なら structure_stop", () => {
    const tight = ctxOf(UP, UP); // 構造 5.3 < 0.5 × 12
    expect(withStructure(custom("long", 12, 24), cfg).evaluate(tight.ctx)).toBeNull();
    expect(tight.filtered.map((f) => f.reason)).toEqual(["structure_stop"]);
    const wide = ctxOf(UP, UP); // 構造 5.3 > 3 × 1.5
    expect(withStructure(custom("long", 1.5, 3), cfg).evaluate(wide.ctx)).toBeNull();
    expect(wide.filtered.map((f) => f.reason)).toEqual(["structure_stop"]);
    // 境界の内側 (ちょうど 0.5 倍以上・3 倍以下) は通る
    expect(withStructure(custom("long", 10, 20), cfg).evaluate(ctxOf(UP, UP).ctx)).not.toBeNull(); // 0.53 倍
    expect(withStructure(custom("long", 2, 4), cfg).evaluate(ctxOf(UP, UP).ctx)).not.toBeNull(); // 2.65 倍
  });

  it("新しい損切り幅が ATR の 0.5 倍未満なら structure_stop (戦略の features.atr を優先)", () => {
    // 元の損切り 8 なら 0.5〜3 倍の範囲 (4〜24) に入るが、戦略の ATR が 12 → 5.3 < 6 で除外
    const b = ctxOf(UP, UP);
    expect(withStructure(custom("long", 8, 16, { atr: 12 }), cfg).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_stop"]);
    // ATR が 10 なら 5.3 ≥ 5 で通る。features.atr が無ければ執行足の ATR14 (= 1) を使う
    expect(withStructure(custom("long", 8, 16, { atr: 10 }), cfg).evaluate(ctxOf(UP, UP).ctx)).not.toBeNull();
    expect(withStructure(custom("long", 8, 16), cfg).evaluate(ctxOf(UP, UP).ctx)).not.toBeNull();
  });

  it("置き直した利確が 0 以下 (利益側に無い) なら、黙って外さず structure_stop", () => {
    // 売り (価格 108): 元の損切り 2・利確 107 下 (R = 53.5) → 新しい利確 108 − 53.5 × 5.3 < 0
    const b = ctxOf(DOWN, DOWN);
    expect(withStructure(custom("short", 2, 107), cfg).evaluate(b.ctx)).toBeNull();
    expect(b.filtered.map((f) => f.reason)).toEqual(["structure_stop"]);
    // 通常の利確 (2R) は利益側に置き直されて通る
    const ok = withStructure(custom("short", 2, 4), cfg).evaluate(ctxOf(DOWN, DOWN).ctx)!;
    expect(ok.takeProfit!).toBeLessThan(108);
    expect(ok.takeProfit!).toBeGreaterThan(0);
  });
});

describe("withStructure: 保有中の決済", () => {
  it("exitOnReversal: 保有方向と逆の目線なら flat。既定 (false) では何もしない", () => {
    const b = ctxOf(DOWN, DOWN, { position: "long" });
    expect(withStructure(fake(null), BASE).evaluate(b.ctx)).toBeNull();
    const s = withStructure(fake(null), { ...BASE, exitOnReversal: true }).evaluate(b.ctx)!;
    expect(s.direction).toBe("flat");
    expect(s.strategyId).toBe("fake_trend");
    // 同じ方向の目線なら決済しない
    expect(withStructure(fake(null), { ...BASE, exitOnReversal: true }).evaluate(ctxOf(UP, UP, { position: "long" }).ctx)).toBeNull();
    expect(withStructure(fake(null), { ...BASE, exitOnReversal: true }).evaluate(ctxOf(UP, UP, { position: "short" }).ctx)?.direction).toBe("flat");
  });

  it("exitOnWeakening: conservative の weakeningUp で買いを決済", () => {
    const weak = path(100, 110, 104, 114, 107, 118, 103);
    const cfg = { ...BASE, reversalMode: "conservative" as const };
    expect(withStructure(fake(null), cfg).evaluate(ctxOf(weak, UP, { position: "long" }).ctx)).toBeNull();
    expect(withStructure(fake(null), { ...cfg, exitOnWeakening: true }).evaluate(ctxOf(weak, UP, { position: "long" }).ctx)?.direction).toBe("flat");
  });

  it("元の戦略の決済シグナルはそのまま通す (フィルターしない)", () => {
    const s = withStructure(fake("flat"), BASE).evaluate(ctxOf(UP, UP, { position: "long" }).ctx)!;
    expect(s.direction).toBe("flat");
    const opp = withStructure(fake("short"), BASE).evaluate(ctxOf(UP, UP, { position: "long" }).ctx)!;
    expect(opp.direction).toBe("short");
  });
});

describe("withStructure: 戦略の属性", () => {
  it("id・paramBounds・defaultParams は同じ。timeframes に上位足、warmup は構造に必要な本数まで", () => {
    const inner = getStrategy("short_ema_trend")!;
    const w = withStructure(inner, {});
    expect(w.id).toBe(inner.id);
    expect(w.paramBounds).toBe(inner.paramBounds);
    expect(w.defaultParams).toBe(inner.defaultParams);
    expect(w.regimes).toBe(inner.regimes);
    expect(w.timeframes).toEqual(["15m", "1h"]);
    expect(w.warmup).toBe(Math.max(inner.warmup, structureWarmupBars(6) * 4));
    expect(isStructureWrapped(w)).toBe(true);
    // 二重にラップしない
    expect(withStructure(w, { pivotN: 4 }).inner).toBe(inner);
    // useMTF=false なら上位足を加えない
    expect(withStructure(inner, { useMTF: false }).timeframes).toEqual(["15m"]);
    // 1d の上位足 1w は hub に取りに行かず 1d から集約する
    const daily = withStructure({ ...inner, id: "daily_test", primaryTimeframe: "1d", timeframes: ["1d"], warmup: 1 }, {});
    expect(daily.timeframes).toEqual(["1d"]);
    expect(daily.warmup).toBe(structureWarmupBars(6) * 7);
  });
});

describe("設定と一覧への適用", () => {
  it("既定: STRUCTURE_MODE=filter、対象はトレンド・ブレイク系だけ", () => {
    const env = loadConfig({}).env;
    expect(env.STRUCTURE_MODE).toBe("filter");
    expect(env.STRUCTURE_PIVOT_N).toBe(6);
    expect(env.STRUCTURE_STOP_ATR_BUFFER).toBe(0.3);
    const list = configuredStrategies(structureSettingsFromEnv(env));
    const wrapped = list.filter(isStructureWrapped).map((s) => s.id).sort();
    expect(wrapped).toEqual(
      ["scalp_micro", "scalp_momentum_burst", "short_breakout", "short_ema_trend"].sort(),
    );
    for (const id of ["scalp_obi", "scalp_vwap_revert", "short_rsi_revert", "scalp_rebound"]) {
      expect(list.find((s) => s.id === id)).toBe(getStrategy(id));
    }
    expect(list.map((s) => s.id)).toEqual(ALL_STRATEGIES.map((s) => s.id));
  });

  it("環境変数で切り替える。不正な値は起動を止める", () => {
    const env = loadConfig({
      STRUCTURE_MODE: "FILTER", STRUCTURE_STRATEGIES: "short_breakout", STRUCTURE_PIVOT_N: "10", STRUCTURE_BREAK_MODE: "wick",
      STRUCTURE_BIAS_METHOD: "both", STRUCTURE_REVERSAL_MODE: "conservative", STRUCTURE_USE_MTF: "false", STRUCTURE_STOP_MODE: "structure",
      STRUCTURE_STOP_ATR_BUFFER: "0.5", STRUCTURE_EXIT_ON_REVERSAL: "true", STRUCTURE_CHOP_M: "40", STRUCTURE_CHOP_R: "2",
    }).env;
    const st = structureSettingsFromEnv(env);
    expect(st.strategies).toEqual(["short_breakout"]);
    expect(st.config).toMatchObject({
      pivotN: 10, breakMode: "wick", biasMethod: "both", reversalMode: "conservative", useMTF: false, stopMode: "structure",
      stopAtrBuffer: 0.5, exitOnReversal: true, exitOnWeakening: false, chopM: 40, chopR: 2,
    });
    expect(() => loadConfig({ STRUCTURE_MODE: "on" })).toThrow(/STRUCTURE_MODE/);
    expect(() => loadConfig({ STRUCTURE_PIVOT_N: "2" })).toThrow(/STRUCTURE_PIVOT_N/);
    expect(() => loadConfig({ STRUCTURE_PIVOT_N: "6.5" })).toThrow(/STRUCTURE_PIVOT_N/);
    expect(() => loadConfig({ STRUCTURE_STOP_ATR_BUFFER: "3" })).toThrow(/STRUCTURE_STOP_ATR_BUFFER/);
    expect(() => loadConfig({ STRUCTURE_BREAK_MODE: "body" })).toThrow(/STRUCTURE_BREAK_MODE/);
  });

  it("off なら一覧はそのまま (同じ配列・同じオブジェクト)", () => {
    const off = structureSettingsFromEnv(loadConfig({ STRUCTURE_MODE: "off" }).env);
    expect(configuredStrategies(off)).toBe(ALL_STRATEGIES);
    expect(applyStructure(ALL_STRATEGIES, { ...defaultStructureSettings(), strategies: [] })).toBe(ALL_STRATEGIES);
    expect(configuredStrategies()).toBe(ALL_STRATEGIES);
  });
});

describe("組み立て (buildRuntime)", () => {
  const MIN = 60_000;
  const START = Date.UTC(2026, 0, 5);
  const base = { NODE_ENV: "test", VENUES: "synthetic", DB_PATH: "memory", BASE_CURRENCY: "JPY" };

  it("STRUCTURE_MODE=off ならエンジン・検証は従来と同じ戦略オブジェクトを使う", async () => {
    const clock: Clock = { now: () => START };
    const rt = await buildRuntime(loadConfig({ ...base, STRUCTURE_MODE: "off" }), {
      clock, store: new MemoryStore(), intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000,
    });
    expect(rt.engine.strategies).toBe(ALL_STRATEGIES);
    const on = await buildRuntime(loadConfig(base), {
      clock, store: new MemoryStore(), intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000,
    });
    expect(on.engine.strategies.filter(isStructureWrapped).length).toBe(4);
    // hub の時間足は上位足を含む (従来と同じ一覧に収まる)
    expect(on.timeframes).toEqual(rt.timeframes);
  });

  it("フィルターで通さなかったシグナルは strategy_filter:structure_* の仮想トレードとしてだけ記録される", async () => {
    // 買いと売りを交互に出す戦略 (どちらかは目線と逆になる)
    let n = 0;
    const alt: Strategy = {
      ...fake("long", "alt_trend"),
      primaryTimeframe: "1m", timeframes: ["1m"], horizon: "scalp", warmup: 1,
      regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
      evaluate(ctx) {
        if (ctx.position) return null;
        return fake(n++ % 2 === 0 ? "long" : "short", "alt_trend").evaluate(ctx);
      },
    };
    const clock: Clock & { t: number } = { t: START, now() { return this.t; } };
    const store = new MemoryStore();
    const rt = await buildRuntime(loadConfig(base), {
      clock, store, intelSources: [], ai: null, seed: 3, syntheticHistoryMs: 2 * 86_400_000, rng: mulberry32(7),
      strategies: [withStructure(alt, { pivotN: 3 })],
    });
    for (let now = START; now <= START + 30 * MIN; now += 60_000) {
      clock.t = now;
      await rt.engine.tick(now);
    }
    const reasons = new Set(rt.engine.shadow!.list().map((o) => o.reason));
    const structural = [...reasons].filter((r) => r.startsWith("strategy_filter:structure_"));
    expect(structural.length).toBeGreaterThan(0);
  });
});

describe("比較コマンド (--structure-compare) と regime の構造の列", () => {
  it("合成データで A〜G の表が出る (回数不足の表示・除外の理由)", async () => {
    const { runStructureCompare, formatCompareRows, compareFootnotes } = await import("../src/engine/structureCompare");
    const rows = await runStructureCompare({ strategy: "short_ema_trend", days: 20, source: "synthetic", seed: 1, folds: 5 });
    expect(rows.map((r) => r.condition)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    for (const r of rows) {
      expect(r.metrics).toBeDefined();
      expect(r.foldTrades).toHaveLength(5);
      expect(r.insufficient).toBe(r.foldTrades.some((t) => t < 30));
    }
    // A はラップなし (除外なし)、B 以降は structure_* の理由だけを数える
    expect(rows[0].filtered).toEqual({});
    expect(Object.keys(rows[2].filtered).every((k) => k.startsWith("structure_"))).toBe(true);
    // フィルターは取引を増やさない (同じ足・同じ損切り)。C は B に上位足の条件を足しただけ
    expect(rows[1].metrics!.trades).toBeLessThanOrEqual(rows[0].metrics!.trades);
    const text = formatCompareRows(rows);
    for (const h of ["PF", "最大DD", "期待値R", "取引数", "勝率", "平均保有", "区間の取引数"]) expect(text).toContain(h);
    expect(text).toContain("A ラップなし");
    expect(text).toContain("G D の conservative");
    if (rows.some((r) => r.insufficient)) expect(text).toContain("回数不足");
    expect(compareFootnotes({ folds: 5, pivotSweep: true }).join("\n")).toContain("最良の N を選ぶためのものではない");
  }, 120_000);

  it("--pivot-sweep は N = 4 / 6 / 10 の B〜G (A は 1 回)", async () => {
    const { runStructureCompare, formatCompareRows } = await import("../src/engine/structureCompare");
    const rows = await runStructureCompare({ strategy: "short_breakout", days: 20, source: "synthetic", seed: 2, pivotSweep: true });
    expect(rows.filter((r) => r.condition === "A")).toHaveLength(1);
    expect(rows.filter((r) => r.condition === "D").map((r) => r.pivotN)).toEqual([4, 6, 10]);
    expect(rows).toHaveLength(1 + 3 * 6);
    expect(formatCompareRows(rows).split("\n")[0]).toContain("N");
  }, 120_000);

  it("CLI の引数: --structure-compare は --strategy 省略で all。--source ccxt を受け付け、廃止した gmo は拒否する", async () => {
    const { parseBacktestArgs } = await import("../src/cli");
    expect(parseBacktestArgs({ "structure-compare": true })).toMatchObject({ strategy: "all", structureCompare: true, folds: 5 });
    expect(parseBacktestArgs({ "structure-compare": true, "pivot-sweep": true, source: "ccxt" })).toMatchObject({ pivotSweep: true, source: "ccxt" });
    expect(() => parseBacktestArgs({ strategy: "all", "pivot-sweep": true })).toThrow(/--structure-compare/);
    expect(parseBacktestArgs({ strategy: "all", source: "ccxt" }).source).toBe("ccxt");
    expect(() => parseBacktestArgs({ strategy: "all", source: "gmo" })).toThrow(/--source gmo は廃止しました/);
    expect(() => parseBacktestArgs({ strategy: "all", source: "oanda" })).toThrow(/synthetic \/ ccxt/);
  });

  it("ccxt の feed (モック) から足を取って比較できる", async () => {
    const { runStructureCompare } = await import("../src/engine/structureCompare");
    const { generateCandles } = await import("../src/backtest/synthetic");
    const now = Date.UTC(2026, 0, 20);
    const all = generateCandles({ seed: 5, bars: 4000, timeframe: "15m", vol: 0.004, startTs: now - 4000 * M15 });
    const inst = syntheticInstrument({ symbol: "BTC/JPY", venue: "ccxt:bitbank" });
    const feed = {
      listInstruments: async () => [inst],
      fetchCandles: async (_s: string, _tf: string, limit: number, since?: number) => all.filter((c) => c.ts >= (since ?? 0)).slice(0, limit),
      fetchQuote: async () => { throw new Error("unused"); },
    } as unknown as import("../src/core/types").MarketDataFeed;
    const rows = await runStructureCompare({ strategy: "short_ema_trend", symbol: "BTC/JPY", days: 20, source: "ccxt", seed: 1, feed, now });
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.metrics !== undefined)).toBe(true);
  }, 120_000);

  it("regime の表に目線・押し安値/戻り高値・ちゃぶつきの列 (先読みしない)", async () => {
    const { regimeSeries, formatRegimeReport, structureCell } = await import("../src/engine/regimeReport");
    const { regimeOptionsFor } = await import("../src/regime/detect");
    const prices = path(100, 110, 104, 114, 107, 118, 112);
    const c = lineBars(prices, "15m");
    const t = c[c.length - 1].ts + M15;
    const s = regimeSeries(c, "15m", [t, t - 6 * M15], regimeOptionsFor("crypto"), { pivotN: 2 });
    expect(s.cells[0].structure).toMatchObject({ bias: "up", oshiYasune: 107, modoriTakane: null, choppy: false });
    // t - 6 本の時点の構造は、その時点までの足だけで計算した結果と同じ
    expect(s.cells[1].structure).toEqual(structureCell(c.slice(0, c.length - 6), c.length - 6, { pivotN: 2 }));
    const text = formatRegimeReport([s], { symbol: "SYN", from: T0, until: t, stepMs: M15 });
    expect(text).toContain("目線");
    expect(text).toContain("押し 107");
  });
});

describe("設定の警告・上限・比較条件", () => {
  it("structureConfigWarnings: 未登録の id と、purist での exitOnWeakening を警告する", async () => {
    const { structureConfigWarnings } = await import("../src/structure/settings");
    const known = ALL_STRATEGIES.map((x) => x.id);
    const base = structureSettingsFromEnv(loadConfig({}).env);
    expect(structureConfigWarnings(base, known)).toEqual([]);
    const bad = { ...base, strategies: [...base.strategies, "scalp_typo"], config: { ...base.config, exitOnWeakening: true } };
    const w = structureConfigWarnings(bad, known);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("scalp_typo");
    expect(w[1]).toContain("STRUCTURE_EXIT_ON_WEAKENING");
    // conservative なら警告しない / off なら何も言わない
    expect(structureConfigWarnings({ ...base, config: { ...base.config, exitOnWeakening: true, reversalMode: "conservative" } }, known)).toEqual([]);
    expect(structureConfigWarnings({ ...bad, mode: "off" }, known)).toEqual([]);
  });

  it("STRUCTURE_CHOP_M は構造の窓 (300) まで。超えると設定エラー", () => {
    expect(() => loadConfig({ STRUCTURE_CHOP_M: "300" })).not.toThrow();
    expect(() => loadConfig({ STRUCTURE_CHOP_M: "301" })).toThrow(/STRUCTURE_CHOP_M/);
    expect(resolveStructureFilterConfig({ chopM: 900 }).chopM).toBe(300);
  });

  it("比較条件 A〜G は exitOnReversal / exitOnWeakening が常に off", async () => {
    const { compareConditions } = await import("../src/engine/structureCompare");
    const base = { ...defaultStructureSettings().config, exitOnReversal: true, exitOnWeakening: true };
    for (const c of compareConditions(base)) {
      if (c.config) expect([c.id, c.config.exitOnReversal, c.config.exitOnWeakening]).toEqual([c.id, false, false]);
    }
  });
});
