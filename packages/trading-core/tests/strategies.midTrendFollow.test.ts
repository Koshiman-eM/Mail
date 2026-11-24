/**
 * mid_trend_follow (中期・EMA+MACD トレンド 4 時間足) を同じ id で戻した (commit 299e971 で廃止 → 復活)。すべて合成データ (オフライン)。
 * - 判定は廃止前と同一: 廃止前の evaluate をそのまま写した参照の実装 (LEGACY) と、合成の 4 時間足の各時点で同じシグナルを返す
 * - 廃止前の試験 (MACD ヒストの転換で買い / 売り、トレンド継続中は null、保有中の EMA 逆転で flat) を移植
 * - managesOwnExit: 汎用の決済の上乗せ (建値ストップ・転換で決済・読みの管理・MAX_HOLD_MINUTES) を掛けないが、
 *   自前の損切り・利確・標準の ATR トレーリング (trailingStopPct)・決済シグナル・maxHoldBars は効く
 *   (バックテスト・PositionManager・仮想トレード)
 * - 腕のキーは従来どおり `mid_trend_follow|<レジーム>|<資産クラス>`
 */
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/engine";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES } from "../src/core/config";
import {
  TIMEFRAME_MS, type Candle, type EntryContext, type Instrument, type PositionView, type Quote, type RegimeFeatures, type Signal, type Strategy,
  type StrategyContext, type TradeRecord,
} from "../src/core/types";
import { DEFAULT_BREAKEVEN_SETTINGS } from "../src/engine/breakeven";
import { PositionManager } from "../src/engine/positions";
import { DEFAULT_REVERSAL_SETTINGS, type ReversalSettings } from "../src/engine/reversalExit";
import { hubTimeframesFor } from "../src/engine/runtime";
import { isHoldLimitedStrategy } from "../src/engine/tempo";
import { DEFAULT_THESIS_SETTINGS } from "../src/engine/thesis";
import { PaperBroker } from "../src/execution/paper";
import { atr, closesOf, ema, macd } from "../src/indicators/series";
import { armKey } from "../src/learning/allocator";
import { TradeJournal } from "../src/learning/journal";
import { ShadowTracker } from "../src/learning/shadow";
import { MemoryStore } from "../src/storage/memory";
import { DEFAULT_STRUCTURE_TARGETS, structureConfigWarnings } from "../src/structure/settings";
import { DEFAULT_STRUCTURE_FILTER_CONFIG } from "../src/structure/wrap";
import { buildEntrySignal, candlesOf, clamp, entryBlocked, exitSignal, positionSide } from "../src/strategies/common";
import { strategyLabel } from "../src/strategies/labels";
import { midTrendFollow } from "../src/strategies/mid";
import { observeOnlyWarnings } from "../src/strategies/observeOnly";
import { ALL_STRATEGIES, getStrategy, managesOwnExit } from "../src/strategies/registry";
import { RETIRED_STRATEGIES, strategyIdListWarnings } from "../src/strategies/retired";
import { barTs, H, INST as RINST, LONG_PROFIT, M, probe, scenarioBars } from "./helpers/reversalScenario";

const H4 = TIMEFRAME_MS["4h"];
const T0 = Date.UTC(2026, 0, 1);

/**
 * 廃止前 (commit 299e971^ の trader/src/strategies/mid.ts) の判定をそのまま写した参照の実装 (変えないこと)。
 * 違いはメタデータ (資産クラス・managesOwnExit) だけなので、evaluate の結果は同じになるはず
 */
const LEGACY: Strategy = {
  id: "mid_trend_follow",
  horizon: "mid",
  assetClasses: ["crypto", "fx" as never, "stock" as never],
  regimes: ["trend_up", "trend_down"],
  primaryTimeframe: "4h",
  timeframes: ["4h"],
  warmup: 80,
  defaultParams: { stopAtr: 2.5, tpAtr: 6.0, trailAtr: 3.0, entryThreshold: 0.3, maxHoldBars: 60 },
  paramBounds: { stopAtr: [1.5, 5], tpAtr: [3, 12], trailAtr: [0, 6], entryThreshold: [0, 2], maxHoldBars: [12, 180] },
  evaluate(ctx: StrategyContext): Signal | null {
    const c = candlesOf(ctx, "4h", 250);
    const n = c.length;
    if (n < LEGACY.warmup) return null;
    const p = ctx.params;
    const closes = closesOf(c);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const m = macd(closes, 12, 26, 9);
    const a = atr(c, 14)[n - 1];
    const i = n - 1;
    const close = closes[i];
    const sep = a > 0 ? (e20[i] - e50[i]) / a : 0;
    const features = { ema20: e20[i], ema50: e50[i], macdHist: m.hist[i], macd: m.macd[i], sepAtr: sep };
    const side = positionSide(ctx);
    if (side) {
      if (side === "long" && (e20[i] < e50[i] || (m.hist[i] < 0 && close < e50[i])))
        return exitSignal(ctx, LEGACY, 0.6, "EMA20/50 の逆転または MACD 悪化で EMA50 割れ", features);
      if (side === "short" && (e20[i] > e50[i] || (m.hist[i] > 0 && close > e50[i])))
        return exitSignal(ctx, LEGACY, 0.6, "EMA20/50 の逆転または MACD 改善で EMA50 超え", features);
      return null;
    }
    if (entryBlocked(ctx)) return null;
    const histUpCross = m.hist[i] > 0 && m.hist[i - 1] <= 0;
    const histDownCross = m.hist[i] < 0 && m.hist[i - 1] >= 0;
    const emaUpCross = e20[i] > e50[i] && e20[i - 1] <= e50[i - 1];
    const emaDownCross = e20[i] < e50[i] && e20[i - 1] >= e50[i - 1];
    const th = p.entryThreshold;
    let direction: "long" | "short" | null = null;
    if (sep >= th && close > e20[i] && m.hist[i] > 0 && (histUpCross || emaUpCross)) direction = "long";
    else if (-sep >= th && close < e20[i] && m.hist[i] < 0 && (histDownCross || emaDownCross)) direction = "short";
    if (!direction) return null;
    const confidence = 0.5 + 0.5 * clamp((Math.abs(sep) - th) / (th + 1));
    return buildEntrySignal({
      ctx, strategy: LEGACY, direction, confidence, atr: a, lastPrice: close,
      reason: `EMA20/50 ${direction === "long" ? "上昇" : "下降"}配列で MACD 転換 (乖離 ${sep.toFixed(2)} ATR)`, features,
    });
  },
};

const REGIME: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.02, volatilityPercentile: 0.5, spreadBps: 1 };

function ctxOf(c: Candle[], o: { position?: PositionView; params?: Record<string, number>; inst?: Partial<Instrument>; regime?: Partial<RegimeFeatures> } = {}): StrategyContext {
  const last = c[c.length - 1];
  const now = last.ts + H4; // 末尾の足は確定済み
  return {
    market: {
      instrument: syntheticInstrument({ tickSize: 0, ...o.inst }),
      now,
      quote: { ts: now, bid: last.close * (1 - 1e-5), ask: last.close * (1 + 1e-5), last: last.close },
      candles: { "4h": c },
    },
    regime: { ...REGIME, ...o.regime },
    ...(o.position ? { position: o.position } : {}),
    params: { ...midTrendFollow.defaultParams, ...o.params },
    mode: "paper",
  };
}

const pos = (qty: number, price = 100): PositionView => ({
  symbol: "SYN/USDT", qty, avgPrice: price, openedAt: T0, strategyId: "mid_trend_follow", stopLoss: qty > 0 ? price * 0.9 : price * 1.1,
  highWater: price, lowWater: price,
});

/** 4 時間足を 1 本足す (廃止前の試験の push と同じ形) */
function push(cs: Candle[], o: number, h: number, l: number, c: number): void {
  cs.push({ ts: T0 + cs.length * H4, open: o, high: h, low: l, close: c, volume: 1000 });
}

/** 廃止前の試験の resume: 上昇トレンド → 調整 (MACD ヒスト負) → 再上昇でヒストが正へ転換した足で終える */
function resume(sign: 1 | -1): Candle[] {
  const cs: Candle[] = [];
  let price = 100;
  const add = (d: number) => {
    const c = price + d;
    push(cs, price, Math.max(price, c) + 0.3, Math.min(price, c) - 0.3, c);
    price = c;
  };
  for (let i = 0; i < 100; i++) add(sign * 0.6);
  for (let i = 0; i < 8; i++) add(-sign * 0.3);
  for (let i = 0; i < 30; i++) {
    add(sign * 0.9);
    const h = macd(cs.map((x) => x.close)).hist;
    if (sign * h[h.length - 1] > 0 && sign * h[h.length - 2] <= 0) break;
  }
  return cs;
}

describe("mid_trend_follow: 登録と既定値 (廃止前と同じ id・パラメータ)", () => {
  it("中期・crypto だけ・4 時間足・上昇 / 下降トレンド・managesOwnExit。パラメータと範囲は廃止前と同一", () => {
    expect(getStrategy("mid_trend_follow")).toBe(midTrendFollow);
    expect(ALL_STRATEGIES).toHaveLength(13);
    expect(midTrendFollow).toMatchObject({
      id: "mid_trend_follow", horizon: "mid", assetClasses: ["crypto"], regimes: ["trend_up", "trend_down"], primaryTimeframe: "4h", timeframes: ["4h"],
      warmup: 80, managesOwnExit: true,
    });
    expect(midTrendFollow.defaultParams).toEqual(LEGACY.defaultParams);
    expect(midTrendFollow.paramBounds).toEqual(LEGACY.paramBounds);
    expect(managesOwnExit("mid_trend_follow")).toBe(true);
    // MAX_HOLD_MINUTES があっても hold_limit の観測専用にしない
    expect(isHoldLimitedStrategy(midTrendFollow)).toBe(false);
    expect(strategyLabel("mid_trend_follow")).toBe("中期・EMA+MACD トレンド (4 時間足)");
    // 既定では観測専用 (実データの検証で負けたため。仮想トレードで観測は続ける)
    expect(DEFAULT_OBSERVE_ONLY_STRATEGIES.split(",")).toContain("mid_trend_follow");
  });

  it("廃止した戦略の一覧から外した (long_momentum・meme_momentum は廃止のまま)。環境変数の一覧に書いても警告しない", () => {
    expect(Object.keys(RETIRED_STRATEGIES).sort()).toEqual(["long_momentum", "meme_momentum"]);
    const known = ALL_STRATEGIES.map((s) => s.id);
    expect(strategyIdListWarnings("OBSERVE_ONLY_STRATEGIES", ["mid_trend_follow"], known)).toEqual([]);
    expect(observeOnlyWarnings("OBSERVE_ONLY_STRATEGIES", ["mid_trend_follow", "mid_trend_follow:crypto"], known, ["crypto", "meme"])).toEqual([]);
    expect(structureConfigWarnings({ mode: "filter", strategies: ["mid_trend_follow"], config: { ...DEFAULT_STRUCTURE_FILTER_CONFIG } }, known)).toEqual([]);
    expect(strategyIdListWarnings("REVERSAL_EXIT_STRATEGIES", ["mid_trend_follow", "long_momentum"], known)).toEqual([
      "REVERSAL_EXIT_STRATEGIES に廃止した戦略 id があります (無視されます): long_momentum",
    ]);
  });

  it("相場構造のフィルターの既定の対象 (廃止前と同じ)。trend_4h は対象外のまま", () => {
    expect(DEFAULT_STRUCTURE_TARGETS).toContain("mid_trend_follow");
    expect(DEFAULT_STRUCTURE_TARGETS).not.toContain("trend_4h");
  });

  it("腕のキーは従来どおり (学習データを引き継ぐ)", () => {
    expect(armKey("mid_trend_follow", "trend_up", "crypto")).toBe("mid_trend_follow|trend_up|crypto");
    expect(armKey("mid_trend_follow", "trend_down", "crypto", true)).toBe("mid_trend_follow|trend_down|crypto|short");
  });

  it("hub の時間足: 4h を取り、転換で決済の時間足 (1h) は要らない (managesOwnExit)", () => {
    expect(hubTimeframesFor([{ assetClass: "crypto" }], [midTrendFollow], { ...DEFAULT_REVERSAL_SETTINGS })).toEqual(["1m", "4h"]);
  });
});

describe("mid_trend_follow: 判定は廃止前と同一", () => {
  it("合成の 4 時間足の各時点で、廃止前の実装と同じシグナル (建玉なし・買い保有・売り保有、パラメータ違いも)", () => {
    let entries = 0;
    let exits = 0;
    for (const seed of [1, 2, 3, 7]) {
      const c = generateCandles({ seed, bars: 420, timeframe: "4h", startTs: T0, vol: 0.012, meanSegmentBars: 60 });
      for (let k = 60; k <= c.length; k++) {
        const slice = c.slice(0, k);
        for (const position of [undefined, pos(1, slice.at(-1)!.close), pos(-1, slice.at(-1)!.close)]) {
          for (const params of [{}, { entryThreshold: 0 }, { stopAtr: 3, tpAtr: 9, trailAtr: 0 }] as Record<string, number>[]) {
            const ctx = ctxOf(slice, { ...(position ? { position } : {}), params });
            const got = midTrendFollow.evaluate(ctx);
            expect(got).toEqual(LEGACY.evaluate(ctx));
            if (got && got.direction === "flat") exits++;
            else if (got) entries++;
          }
        }
      }
    }
    // 判定が実際に起きた (空の比較ではない)
    expect(entries).toBeGreaterThan(20);
    expect(exits).toBeGreaterThan(100);
  });

  it("EMA20>EMA50 で MACD ヒストが正に転換した足で買い。損切り 2.5 ATR・利確 6 ATR・トレーリング 3 ATR・最大保有 60 本", () => {
    const c = resume(1);
    const ctx = ctxOf(c);
    const s = midTrendFollow.evaluate(ctx)!;
    expect(s.direction).toBe("long");
    expect(s.strategyId).toBe("mid_trend_follow");
    expect(s.horizon).toBe("mid");
    expect(s.features.sepAtr).toBeGreaterThan(0.3);
    const a = atr(c, 14).at(-1)!;
    const price = c.at(-1)!.close * (1 + 1e-5);
    expect(s.stopLoss).toBeCloseTo(price - 2.5 * a, 9);
    expect(s.takeProfit).toBeCloseTo(price + 6 * a, 9);
    // 標準のトレーリング (trend_4h と違い外さない)
    expect(s.trailingStopPct).toBeCloseTo((3 * a) / price, 12);
    expect(s.maxHoldMs).toBe(60 * H4);
    // 期待値 = 利確幅 / 価格 × 確信度 (標準の buildEntrySignal)
    expect(s.expectedEdgeBps).toBeCloseTo(((6 * a) / price) * 1e4 * s.confidence, 6);
    // 純粋: 同じ入力なら同じ出力
    expect(midTrendFollow.evaluate(ctx)).toEqual(s);
  });

  it("下降版は売り。空売りできない銘柄では出さない", () => {
    const c = resume(-1);
    expect(midTrendFollow.evaluate(ctxOf(c))?.direction).toBe("short");
    expect(midTrendFollow.evaluate(ctxOf(c, { inst: { allowShort: false, venue: "jupiter" } }))).toBeNull();
  });

  it("トレンド継続中 (転換なし) は null、保有の買いで EMA 逆転なら flat", () => {
    const up: Candle[] = [];
    for (let i = 0; i < 120; i++) push(up, 100 + i * 0.5, 100 + i * 0.5 + 0.8, 100 + i * 0.5 - 0.3, 100 + i * 0.5 + 0.5);
    expect(midTrendFollow.evaluate(ctxOf(up))).toBeNull();
    const s = midTrendFollow.evaluate(ctxOf(resume(-1), { position: pos(1) }));
    expect(s?.direction).toBe("flat");
    expect(s?.reason).toMatch(/EMA20\/50 の逆転/);
    // 上昇中の買いの保有は決済しない
    expect(midTrendFollow.evaluate(ctxOf(up, { position: pos(1) }))).toBeNull();
  });

  it("足が 80 本未満・低流動性のレジームでは入らない", () => {
    expect(midTrendFollow.evaluate(ctxOf(resume(1).slice(-79)))).toBeNull();
    expect(midTrendFollow.evaluate(ctxOf(resume(1), { regime: { label: "low_liquidity" } }))).toBeNull();
  });

  it("先読みなし: 転換の足が確定する前の足だけでは出さず、バックテストは転換の足の次の足の始値でエントリーする", () => {
    const c = resume(1);
    const n = c.length;
    expect(midTrendFollow.evaluate(ctxOf(c.slice(0, n - 1)))).toBeNull();
    const last = c.at(-1)!.close;
    const tail: Candle[] = Array.from({ length: 5 }, (_, k) => ({ ts: c.at(-1)!.ts + (k + 1) * H4, open: last, high: last + 0.3, low: last - 0.3, close: last, volume: 1000 }));
    const r = runBacktest({ strategy: midTrendFollow, instrument: syntheticInstrument({ tickSize: 0 }), candles: [...c, ...tail], baseTimeframe: "4h", spreadBps: 2, slippageBps: 1 });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0].entryTs).toBe(tail[0].ts);
    expect(r.trades[0].strategyId).toBe("mid_trend_follow");
  });
});

// ───────── managesOwnExit: 標準のトレーリング・利確は効き、上乗せは掛けない ─────────

const REV_ON: ReversalSettings = { ...DEFAULT_REVERSAL_SETTINGS, strategies: [] };
const COSTS = { spreadBps: 2, slippageBps: 1 };
const TAIL = [102.0, 101.5, 101.0, 100.5, 100.0, 99.0, 98.0, 97.5, 96.5, 96.0, 96.0, 96.0, 96.0, 96.0, 96.0];
const OVERLAYS = { reversal: REV_ON, breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, thesis: { ...DEFAULT_THESIS_SETTINGS }, maxHoldMinutes: 5 };

/** probe (1m・1 回だけ買い) に標準のトレーリング (trailingStopPct) と managesOwnExit を足した戦略 */
function ownTrailProbe(o: Parameters<typeof probe>[0] & { trail?: number; own?: boolean } = {}): Strategy {
  const p = probe(o);
  return {
    ...p,
    ...(o.own === false ? {} : { managesOwnExit: true as const }),
    evaluate(ctx) {
      const s = p.evaluate(ctx);
      return s && s.direction !== "flat" && o.trail !== undefined ? { ...s, trailingStopPct: o.trail } : s;
    },
  };
}

describe("managesOwnExit (mid_trend_follow と同じ決済の組み合わせ): バックテスト", () => {
  const candles = scenarioBars(LONG_PROFIT, TAIL);
  const bt = (strategy: Strategy, o: Record<string, unknown>) => runBacktest({ strategy, instrument: RINST, candles, baseTimeframe: "1m", ...COSTS, ...o });

  it("標準のトレーリングは効く: 上乗せを全部渡しても trailing で決済 (建値ストップ・読みの管理の印なし)。何も渡さないときと同じ取引", () => {
    const a = bt(ownTrailProbe({ at: barTs(H), trail: 0.01 }), OVERLAYS);
    expect(a.trades).toHaveLength(1);
    const t = a.trades[0];
    expect(t.exitReason).toBe("trailing");
    expect(t.breakevenStopExit).toBeUndefined();
    expect(t.thesisStopExit).toBeUndefined();
    expect(t.thesisOutcome).toBeUndefined();
    // 高値 (104 台) から 1% 下で決済 = 含み益のまま
    expect(t.exitPrice).toBeGreaterThan(102.5);
    expect(a.stats.reversalExits).toBeUndefined();
    const plain = bt(ownTrailProbe({ at: barTs(H), trail: 0.01 }), {});
    expect({ ...t, id: "" }).toEqual({ ...plain.trades[0], id: "" });
  });

  it("利確は効く: 利確 103 で take_profit (上乗せを渡しても)", () => {
    const a = bt(ownTrailProbe({ at: barTs(H), trail: 0.05, takeProfit: 103 }), OVERLAYS);
    expect(a.trades[0].exitReason).toBe("take_profit");
    expect(a.trades[0].exitPrice).toBeCloseTo(103, 6);
  });

  it("前提の確認: managesOwnExit でない同じ戦略には上乗せ (MAX_HOLD_MINUTES の 5 分) が効く", () => {
    const a = bt(ownTrailProbe({ at: barTs(H), trail: 0.01, own: false }), { maxHoldMinutes: 5 });
    expect(a.trades[0].exitReason).toBe("time");
  });

  it("mid_trend_follow のバックテストに上乗せを渡しても結果は変わらない (取引は起きる)", () => {
    const inst = syntheticInstrument({ tickSize: 0 });
    let total = 0;
    for (const seed of [1, 2, 3]) {
      const c = generateCandles({ seed, bars: 900, timeframe: "4h", startTs: T0, vol: 0.012, meanSegmentBars: 60 });
      const a = runBacktest({ strategy: midTrendFollow, instrument: inst, candles: c, baseTimeframe: "4h", ...COSTS, ...OVERLAYS });
      const b = runBacktest({ strategy: midTrendFollow, instrument: inst, candles: c, baseTimeframe: "4h", ...COSTS });
      expect(a.trades.map((t) => ({ ...t, id: "" }))).toEqual(b.trades.map((t) => ({ ...t, id: "" })));
      expect(a.trades.some((t) => t.exitReason === "reversal" || t.breakevenStopExit || t.thesisOutcome !== undefined)).toBe(false);
      total += a.trades.length;
    }
    expect(total).toBeGreaterThan(0);
  });
});

const SYM = "AAA/USD";
const PINST: Instrument = {
  symbol: SYM, venue: "paper", assetClass: "crypto", baseCurrency: "AAA", quoteCurrency: "USD", tickSize: 0.01, lotSize: 0.001, minQty: 0.001,
  takerFeeRate: 0.001, makerFeeRate: 0.0005, allowShort: true,
};
const ECTX: EntryContext = {
  regime: { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 2 },
  confidence: 0.7, expectedEdgeBps: 50, costBps: 22, params: {}, features: {}, riskMultiplier: 1, reason: "test",
};
const MIN = 60_000;
const q = (mid: number, ts: number, half = 0.01): Quote => ({ ts, bid: mid - half, ask: mid + half });

function pmSetup(strategyId: string) {
  const clock = { t: T0, now() { return this.t; } };
  const store = new MemoryStore();
  const paper = new PaperBroker({ instruments: [PINST], baseCurrency: "USD", initialEquity: 1_000_000, slippageBps: 0, clock });
  const journal = new TradeJournal({ store, mode: "paper" });
  const closed: TradeRecord[] = [];
  const pm = new PositionManager({
    journal, brokerFor: () => paper, onTradeClosed: (t) => closed.push(t), store, instrumentOf: () => PINST,
    breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, thesis: { ...DEFAULT_THESIS_SETTINGS },
    managesOwnExit: (id) => managesOwnExit(id),
  });
  async function open(price: number, stop: number, o: { takeProfit?: number; trailingStopPct?: number; maxHoldMs: number }) {
    paper.onQuote(SYM, q(price, clock.t, 0));
    const r = await paper.placeOrder({ clientId: `o-${clock.t}`, symbol: SYM, side: "buy", type: "market", qty: "1", strategyId });
    const f = r.fills[0];
    return pm.open(
      {
        mode: "paper", symbol: SYM, venue: "paper", assetClass: "crypto", strategyId, horizon: "mid", direction: "long", qty: 1, entryTs: clock.t,
        entryPrice: f.price, intendedEntryPrice: price, initialStop: stop, entryContext: ECTX, entryFees: Number(f.fee),
        ...(o.takeProfit !== undefined ? { takeProfit: o.takeProfit } : {}),
      },
      { maxHoldMs: o.maxHoldMs, ...(o.trailingStopPct !== undefined ? { trailingStopPct: o.trailingStopPct } : {}) },
    );
  }
  async function tickAt(min: number, mid: number) {
    clock.t = T0 + min * MIN;
    const quote = q(mid, clock.t);
    paper.onQuote(SYM, quote);
    return pm.onQuote(SYM, quote, clock.t);
  }
  return { pm, store, closed, open, tickAt };
}

describe("managesOwnExit: PositionManager の mid_trend_follow の建玉 (paper)", () => {
  it("建値ストップ・読みの管理は掛けないが、標準のトレーリング (trailingStopPct) は効く", async () => {
    const s = pmSetup("mid_trend_follow");
    const p = await s.open(100, 90, { trailingStopPct: 0.03, takeProfit: 130, maxHoldMs: 10 * MIN });
    expect(s.pm.ownExit(p)).toBe(true);
    expect(s.pm.thesisView(p, q(100, T0), T0)).toBeUndefined();
    // 0.5R (5) を越えて上げても建値ストップは発動しない
    expect((await s.tickAt(1, 110)).status).toBe("none");
    expect(s.pm.planOf(p.id).breakeven).toBeUndefined();
    expect(s.store.listAudit({ type: "position.breakeven_armed" })).toHaveLength(0);
    // トレーリング = 高値 110 × (1 − 3%) = 106.7
    expect(s.pm.trailingStop({ ...p, highWater: 110 })).toBeCloseTo(106.7, 6);
    expect((await s.tickAt(2, 107)).status).toBe("none");
    const r = await s.tickAt(3, 106.5);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("trailing");
    expect(r.trade!.breakevenStopExit).toBeUndefined();
    expect(r.trade!.thesisStopExit).toBeUndefined();
    expect(r.trade!.thesisOutcome).toBeUndefined();
  });

  it("利確は効く (take_profit)", async () => {
    const s = pmSetup("mid_trend_follow");
    await s.open(100, 90, { trailingStopPct: 0.03, takeProfit: 112, maxHoldMs: 600 * MIN });
    const r = await s.tickAt(1, 112.5);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("take_profit");
  });

  it("読みの期限で読み外れにせず、maxHold で従来の時間切れ (time)。当初の損切りも効く", async () => {
    const s = pmSetup("mid_trend_follow");
    await s.open(100, 98, { maxHoldMs: 10 * MIN });
    const r = await s.tickAt(10, 100.05);
    expect(r.status).toBe("closed");
    expect(r.trade!.exitReason).toBe("time");
    expect(r.trade!.thesisOutcome).toBeUndefined();
    const s2 = pmSetup("mid_trend_follow");
    await s2.open(100, 98, { maxHoldMs: 600 * MIN });
    expect((await s2.tickAt(1, 97.9)).trade!.exitReason).toBe("stop");
  });
});

describe("managesOwnExit: mid_trend_follow の仮想トレード", () => {
  const inst = { symbol: "BTC/USDT", assetClass: "crypto" as const, takerFeeRate: 0.001 };
  const tracker = () =>
    new ShadowTracker({
      store: new MemoryStore(), mode: "paper",
      options: { thesis: { ...DEFAULT_THESIS_SETTINGS }, breakeven: { ...DEFAULT_BREAKEVEN_SETTINGS }, reversal: REV_ON, managesOwnExit: (id) => managesOwnExit(id) },
    });
  const record = (tr: ShadowTracker, takeProfit?: number) =>
    tr.record({
      instrument: inst, quote: { bid: 99.9, ask: 100.1 },
      signal: { strategyId: "mid_trend_follow", direction: "long", confidence: 0.7, expectedEdgeBps: 300, stopLoss: 98.1, maxHoldMs: 30 * MIN, horizon: "mid", ...(takeProfit ? { takeProfit } : {}) },
      regime: "trend_up", reason: "lower_score", now: T0, exitTimeframe: "1h",
    });

  it("読みの期限・転換で決済の時間足・建値ストップなし。利確・損切り・maxHoldMs の時間切れは効く", () => {
    const tr = tracker();
    expect(record(tr, 103)).toBe(true);
    const o = tr.list()[0];
    expect(o.thesisExpectedMs).toBeUndefined();
    expect(o.reversalTf).toBeUndefined();
    expect(tr.update(T0 + 2 * MIN, () => ({ bid: 100.9, ask: 101.1 }))).toEqual([]);
    expect(tr.list()[0].breakevenStop).toBeUndefined();
    const [tp] = tr.update(T0 + 3 * MIN, () => ({ bid: 103.2, ask: 103.4 }));
    expect(tp.exitReason).toBe("take_profit");
    const tr2 = tracker();
    record(tr2);
    const [t] = tr2.update(T0 + 30 * MIN, () => ({ bid: 100.2, ask: 100.4 }));
    expect(t.exitReason).toBe("time");
    expect(t.thesisOutcome).toBeUndefined();
    const tr3 = tracker();
    record(tr3, 103);
    expect(tr3.update(T0 + MIN, () => ({ bid: 98, ask: 98.2 }))[0].exitReason).toBe("stop");
  });
});
