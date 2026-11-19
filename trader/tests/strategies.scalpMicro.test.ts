import { describe, expect, it } from "vitest";
import type { Candle, Instrument, OrderBook, PositionView, RegimeFeatures, StrategyContext } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { createRng, generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { runBacktest } from "../src/backtest/engine";
import {
  createScalpMicro,
  detectBurst,
  getStrategy,
  microExpectedEdge,
  resolveParams,
  roundTripCostBps,
  scalpMicro,
  SCALP_MICRO_HOLD_BOUNDS,
  strategiesFor,
} from "../src/strategies";

// ───────────────────────── ヘルパー ─────────────────────────

const T0 = Date.UTC(2024, 0, 1);
const MIN = TIMEFRAME_MS["1m"];
const BITBANK_TAKER = 0.0012;

const mk = (i: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ ts: T0 + i * MIN, open: o, high: h, low: l, close: c, volume: v });

/**
 * 中心 100 のノイズ足 n 本。range は高値・安値のひげ (ATR ≈ 2 × range)。
 */
function noise(n: number, range: number, seed = 7): Candle[] {
  const rng = createRng(seed);
  const out: Candle[] = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const c = 100 + range * 0.3 * rng.normal();
    out.push(mk(i, prev, Math.max(prev, c) + range, Math.min(prev, c) - range, c, 100 * (0.9 + 0.2 * rng.next())));
    prev = c;
  }
  return out;
}

/** 出来高を伴うバースト足を末尾に追加 (dir = 1 で上、-1 で下)。moveAtr は (終値 - 始値) の目安 */
function burst(cs: Candle[], dir: 1 | -1, range: number, moveAtr = 3, volume = 500): void {
  const prev = cs[cs.length - 1].close;
  const move = dir * moveAtr * 2 * range;
  const close = prev + move;
  const hi = Math.max(prev, close) + 0.05 * range;
  const lo = Math.min(prev, close) - 0.05 * range;
  cs.push(mk(cs.length, prev, hi, lo, close, volume));
}

/** 静かな足を末尾に追加 (直前の終値付近で横ばい) */
function quiet(cs: Candle[], n: number, range: number): void {
  for (let k = 0; k < n; k++) {
    const p = cs[cs.length - 1].close;
    cs.push(mk(cs.length, p, p + range, p - range, p, 100));
  }
}

const REGIME: RegimeFeatures = { label: "high_vol", trend: 0, trendStrength: 25, volatility: 0.01, volatilityPercentile: 0.8, spreadBps: 2 };

interface CtxOpts {
  candles: Candle[];
  params?: Record<string, number>;
  instrument?: Partial<Instrument>;
  book?: OrderBook;
  position?: PositionView;
  regime?: Partial<RegimeFeatures>;
  /** 片側のスプレッド (中値比)。既定 1bp (全幅 2bp) */
  halfSpread?: number;
}

function ctxOf(o: CtxOpts): StrategyContext {
  const last = o.candles[o.candles.length - 1];
  const now = last.ts + MIN;
  const hs = o.halfSpread ?? 1e-4;
  return {
    market: {
      instrument: syntheticInstrument({ tickSize: 0.0001, ...o.instrument }),
      now,
      quote: { ts: now, bid: last.close * (1 - hs), ask: last.close * (1 + hs), last: last.close },
      book: o.book,
      candles: { "1m": o.candles },
    },
    regime: { ...REGIME, ...o.regime },
    position: o.position,
    params: { ...scalpMicro.defaultParams, ...o.params },
  };
}

/** 板 (買い/売りの数量で不均衡を作る) */
const bookOf = (mid: number, bidQty: number, askQty: number): OrderBook => ({
  ts: 0,
  bids: [[mid * 0.9999, bidQty]],
  asks: [[mid * 1.0001, askQty]],
});

// 大きいボラ (ATR ≈ 2% 前後): コストの条件を満たす
const WIDE = 1.0;
// 中くらいのボラ: 手数料 0.05% なら出るが、bitbank (0.12%) では出ない
const MID = 0.32;

// ───────────────────────── 純粋関数 ─────────────────────────

describe("scalp_micro: コストと期待値の計算", () => {
  it("往復コスト = 2 × taker + スプレッド + 2 × スリッページ", () => {
    // bitbank: 0.12% × 2 = 24bp、スプレッド 2bp、スリッページ 2bp × 2
    expect(roundTripCostBps(BITBANK_TAKER, 99.99, 100.01, 2)).toBeCloseTo(24 + 2 + 4, 6);
    expect(roundTripCostBps(0.0005, 100, 100, 0)).toBeCloseTo(10, 6);
    expect(roundTripCostBps(0.001, 0, 100, 1)).toBeUndefined();
    expect(roundTripCostBps(0.001, 101, 100, 1)).toBeUndefined();
  });

  it("期待値 = p × 利確 - (1 - p) × 損切り - コスト。p はランダムウォークの p0 からの上乗せに抑える", () => {
    // 強さ 0 (confidence 0.5) なら p = p0 で、期待値はちょうど -コスト
    const zero = microExpectedEdge({ tpBps: 100, slBps: 60, costBps: 30, confidence: 0.5, winEdgeMax: 0.1 });
    expect(zero.p0).toBeCloseTo(60 / 160, 9);
    expect(zero.p).toBeCloseTo(zero.p0, 9);
    expect(zero.edgeBps).toBeCloseTo(-30, 9);
    // 最大の強さ: p = p0 + 0.1 → 期待値 = 0.1 × (利確 + 損切り) - コスト
    const max = microExpectedEdge({ tpBps: 100, slBps: 60, costBps: 30, confidence: 1, winEdgeMax: 0.1 });
    expect(max.p).toBeCloseTo(0.475, 9);
    expect(max.edgeBps).toBeCloseTo(0.475 * 100 - 0.525 * 60 - 30, 9);
    expect(max.edgeBps).toBeLessThan(0); // 利確+損切り 160bp では 30bp のコストを回収できない
    // 利確・損切りが無効なら -Infinity
    expect(microExpectedEdge({ tpBps: 0, slBps: 60, costBps: 0, confidence: 1, winEdgeMax: 0.1 }).edgeBps).toBe(-Infinity);
  });
});

// ───────────────────────── シグナル ─────────────────────────

describe("scalp_micro: シグナル", () => {
  it("登録と既定: horizon scalp / 1m / crypto のみ / 標準パラメータ名 / 板は任意", () => {
    expect(getStrategy("scalp_micro")).toBe(scalpMicro);
    expect(strategiesFor("crypto", "scalp").map((s) => s.id)).toContain("scalp_micro");
    expect(strategiesFor("fx").map((s) => s.id)).not.toContain("scalp_micro");
    expect(scalpMicro.horizon).toBe("scalp");
    expect(scalpMicro.primaryTimeframe).toBe("1m");
    expect(scalpMicro.requiresBook).toBeFalsy();
    for (const k of ["stopAtr", "tpAtr", "trailAtr", "entryThreshold", "maxHoldBars"]) {
      expect(scalpMicro.defaultParams[k]).toBeDefined();
      expect(scalpMicro.paramBounds[k]).toBeDefined();
    }
    expect(scalpMicro.defaultParams.maxHoldBars).toBe(8);
    expect(scalpMicro.paramBounds.maxHoldBars).toEqual([5, 10]);
    // 既定値は範囲内
    for (const [k, [lo, hi]] of Object.entries(scalpMicro.paramBounds)) {
      expect(scalpMicro.defaultParams[k]).toBeGreaterThanOrEqual(lo);
      expect(scalpMicro.defaultParams[k]).toBeLessThanOrEqual(hi);
    }
  });

  it("上方向のバースト (出来高・勢い・ブレイク) でロング。期待値はコスト控除後の式と一致し、10 分以内に時間切れ", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE);
    const ctx = ctxOf({ candles: cs });
    const s = scalpMicro.evaluate(ctx)!;
    expect(s).not.toBeNull();
    expect(s.direction).toBe("long");
    expect(s.strategyId).toBe("scalp_micro");
    expect(s.entry.type).toBe("market");
    const ask = ctx.market.quote.ask;
    expect(s.stopLoss).toBeLessThan(ask);
    expect(s.takeProfit!).toBeGreaterThan(ask);
    expect(s.maxHoldMs).toBe(8 * MIN);
    expect(s.maxHoldMs).toBeLessThanOrEqual(10 * MIN);
    const f = s.features;
    expect(f.tpBps).toBeGreaterThanOrEqual(scalpMicro.defaultParams.costMult * f.costBps);
    expect(f.winProb).toBeGreaterThan(f.winProbBase);
    expect(f.winProb - f.winProbBase).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(s.expectedEdgeBps).toBeCloseTo(f.winProb * f.tpBps - (1 - f.winProb) * f.slBps - f.costBps, 6);
    expect(s.expectedEdgeBps).toBeGreaterThan(0);
    // 既定の synthetic の手数料 0.05%: 10bp + スプレッド 2bp + スリッページ 4bp
    expect(f.costBps).toBeCloseTo(16, 3);
  });

  it("下方向のバーストでショート。空売り不可の銘柄では null", () => {
    const cs = noise(60, WIDE);
    burst(cs, -1, WIDE);
    const ctx = ctxOf({ candles: cs });
    const s = scalpMicro.evaluate(ctx)!;
    expect(s.direction).toBe("short");
    expect(s.stopLoss).toBeGreaterThan(ctx.market.quote.bid);
    expect(s.takeProfit!).toBeLessThan(ctx.market.quote.bid);
    expect(s.expectedEdgeBps).toBeGreaterThan(0);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, instrument: { allowShort: false } }))).toBeNull();
  });

  it("コストの条件: 手数料 0.05% では出る値動きでも、bitbank の taker 0.12% では出さない", () => {
    const cs = noise(60, MID);
    burst(cs, 1, MID);
    const cheap = scalpMicro.evaluate(ctxOf({ candles: cs, instrument: { takerFeeRate: 0.0005 } }));
    expect(cheap?.direction).toBe("long");
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, instrument: { takerFeeRate: BITBANK_TAKER } }))).toBeNull();
  });

  it("コストの条件: 利確幅が往復コストの costMult 倍未満なら、期待値の条件を外しても出さない", () => {
    const cs = noise(60, MID);
    burst(cs, 1, MID);
    const noEv = createScalpMicro({ minNetEdgeBps: -Infinity });
    const ok = noEv.evaluate(ctxOf({ candles: cs }))!;
    expect(ok.direction).toBe("long");
    const ratio = ok.features.tpBps / ok.features.costBps;
    expect(noEv.evaluate(ctxOf({ candles: cs, params: { costMult: ratio + 0.1 } }))).toBeNull();
    expect(noEv.evaluate(ctxOf({ candles: cs, params: { costMult: ratio - 0.1 } }))).not.toBeNull();
  });

  it("コストの条件: 値幅が小さい (ATR がコストに比べて小さい) ときは出さない", () => {
    const cs = noise(60, 0.05);
    burst(cs, 1, 0.05);
    expect(detectBurst(cs, scalpMicro.defaultParams)?.direction).toBe("long"); // バースト自体は成立
    expect(scalpMicro.evaluate(ctxOf({ candles: cs }))).toBeNull();
    expect(createScalpMicro({ minNetEdgeBps: -Infinity }).evaluate(ctxOf({ candles: cs }))).toBeNull();
  });

  it("損切り幅がスプレッドの minStopSpreads 倍未満なら出さない", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE);
    // スプレッドを広げる (全幅 1.6%): 損切り幅 (1.2 ATR) < スプレッド × 4
    expect(createScalpMicro({ minNetEdgeBps: -Infinity }).evaluate(ctxOf({ candles: cs, halfSpread: 0.008, params: { costMult: 0 } }))).toBeNull();
  });

  it("出来高が伴わない、またはブレイクしていないときは出さない", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE, 3, 120);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs }))).toBeNull();
    const flat = noise(61, WIDE);
    flat[60] = { ...flat[60], volume: 1000 };
    expect(scalpMicro.evaluate(ctxOf({ candles: flat }))).toBeNull();
  });

  it("低流動性のレジームでは出さない", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, regime: { label: "low_liquidity" } }))).toBeNull();
  });

  it("板は任意: 同方向の不均衡は加点、逆方向に強い不均衡は見送り、板なしでも動く", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE, 1.5, 300);
    const px = cs[cs.length - 1].close;
    const none = scalpMicro.evaluate(ctxOf({ candles: cs }))!;
    const aligned = scalpMicro.evaluate(ctxOf({ candles: cs, book: bookOf(px, 90, 10) }))!;
    expect(none).not.toBeNull();
    expect(aligned.confidence).toBeGreaterThan(none.confidence);
    expect(aligned.expectedEdgeBps).toBeGreaterThan(none.expectedEdgeBps);
    expect(aligned.features.obi).toBeCloseTo(0.8, 6);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, book: bookOf(px, 10, 90) }))).toBeNull();
  });

  it("maxHoldMs は必ず 5〜10 分 (範囲外のパラメータもクランプ)", () => {
    const cs = noise(60, WIDE);
    burst(cs, 1, WIDE);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, params: { maxHoldBars: 50 } }))!.maxHoldMs).toBe(10 * MIN);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, params: { maxHoldBars: 1 } }))!.maxHoldMs).toBe(5 * MIN);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, params: { maxHoldBars: 6 } }))!.maxHoldMs).toBe(6 * MIN);
    expect(resolveParams(scalpMicro, { maxHoldBars: 30 }).maxHoldBars).toBe(SCALP_MICRO_HOLD_BOUNDS[1]);
    expect(resolveParams(scalpMicro, { maxHoldBars: 2 }).maxHoldBars).toBe(SCALP_MICRO_HOLD_BOUNDS[0]);
  });

  it("クールダウン: 直前 cooldownBars 本に同方向のバーストがあれば見送る。逆方向・期間後は出す", () => {
    // 2 本連続の上方向バースト → 2 本目は見送り (損切り直後の再エントリー連発を防ぐ)
    const twice = noise(60, WIDE);
    burst(twice, 1, WIDE);
    expect(scalpMicro.evaluate(ctxOf({ candles: twice }))?.direction).toBe("long");
    burst(twice, 1, WIDE, 3, 1500);
    expect(detectBurst(twice, scalpMicro.defaultParams)?.direction).toBe("long");
    expect(scalpMicro.evaluate(ctxOf({ candles: twice }))).toBeNull();

    // cooldownBars (2) より前のバーストなら出す: バースト → 静かな足 2 本 → 再バースト
    const later = noise(60, WIDE);
    burst(later, 1, WIDE);
    quiet(later, 2, WIDE);
    burst(later, 1, WIDE, 3, 600);
    expect(scalpMicro.evaluate(ctxOf({ candles: later }))?.direction).toBe("long");
    // cooldownBars を 3 にすると見送り
    expect(scalpMicro.evaluate(ctxOf({ candles: later, params: { cooldownBars: 3 } }))).toBeNull();

    // 上方向のバースト直後の下方向のバーストは止めない
    const flip = noise(60, WIDE);
    burst(flip, 1, WIDE);
    burst(flip, -1, WIDE, 5, 1500);
    expect(scalpMicro.evaluate(ctxOf({ candles: flip }))?.direction).toBe("short");
  });

  it("保有中: 逆方向のバーストで flat、それ以外は null (利確・損切り・時間切れはエンジン側)", () => {
    const cs = noise(60, WIDE);
    burst(cs, -1, WIDE);
    const pos = (qty: number): PositionView => ({
      symbol: "SYN/USDT",
      qty,
      avgPrice: 100,
      openedAt: T0,
      strategyId: "scalp_micro",
      stopLoss: qty > 0 ? 98 : 102,
      highWater: 100,
      lowWater: 100,
    });
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, position: pos(1) }))?.direction).toBe("flat");
    expect(scalpMicro.evaluate(ctxOf({ candles: cs, position: pos(-1) }))).toBeNull();
  });

  it("ウォームアップ不足では null", () => {
    const cs = noise(20, WIDE);
    burst(cs, 1, WIDE);
    expect(scalpMicro.evaluate(ctxOf({ candles: cs }))).toBeNull();
  });
});

// ───────────────────────── バックテスト ─────────────────────────

describe("scalp_micro: バックテスト (合成データ)", () => {
  const START = Date.UTC(2024, 0, 1);
  const candles = generateCandles({ seed: 2, bars: 3 * 1440, timeframe: "1m", vol: 0.003, startTs: START });

  it("保有はすべて 10 分以内 (最大 maxHoldBars 本)。決済後に繰り返しエントリーし、ロング・ショート両方が出る", () => {
    // 合成データには優位性がないため、期待値の条件だけ外して動き (保有時間・繰り返し) を確かめる
    const s = createScalpMicro({ minNetEdgeBps: -Infinity });
    const r = runBacktest({ strategy: s, instrument: syntheticInstrument({ takerFeeRate: BITBANK_TAKER }), candles, baseTimeframe: "1m" });
    expect(r.trades.length).toBeGreaterThan(20);
    let prevExit = -Infinity;
    for (const t of r.trades) {
      expect(t.exitTs - t.entryTs).toBeLessThanOrEqual(8 * MIN);
      expect(t.entryTs).toBeGreaterThanOrEqual(prevExit);
      prevExit = t.exitTs;
      expect(t.entryContext.costBps).toBeCloseTo(24 + 2 + 2, 6);
    }
    expect(r.trades.some((t) => t.direction === "long")).toBe(true);
    expect(r.trades.some((t) => t.direction === "short")).toBe(true);

    // 損切り・利確を広げると時間切れ (成行) が出て、保有はちょうど maxHoldBars 分
    const wide = runBacktest({
      strategy: s,
      instrument: syntheticInstrument({ takerFeeRate: BITBANK_TAKER }),
      candles,
      baseTimeframe: "1m",
      params: { stopAtr: 3, tpAtr: 5, maxHoldBars: 5 },
    });
    const timed = wide.trades.filter((t) => t.exitReason === "time");
    expect(timed.length).toBeGreaterThan(0);
    for (const t of timed) expect(t.exitTs - t.entryTs).toBe(5 * MIN);
    for (const t of wide.trades) expect(t.exitTs - t.entryTs).toBeLessThanOrEqual(5 * MIN);
  });

  it("既定 (期待値の条件あり) では、優位性のない合成データで bitbank の手数料を払う取引をしない", () => {
    const r = runBacktest({
      strategy: scalpMicro,
      instrument: syntheticInstrument({ takerFeeRate: BITBANK_TAKER }),
      candles,
      baseTimeframe: "1m",
      minEdgeToCostRatio: 2,
    });
    expect(r.stats.evaluations).toBeGreaterThan(1000);
    expect(r.trades.length).toBe(0);
  });
});
