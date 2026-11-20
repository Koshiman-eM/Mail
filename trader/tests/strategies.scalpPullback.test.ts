/** scalp_pullback (15m のトレンド方向に 1m の押し目買い・戻り売り) の単体テスト。合成データのみ (オフライン) */
import { describe, expect, it } from "vitest";
import type { Candle, Instrument, PositionView, RegimeFeatures, Signal, StrategyContext } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { runBacktest } from "../src/backtest/engine";
import { TEMPO_COST_MULT_FLOOR } from "../src/engine/tempo";
import {
  createScalpPullback,
  detectPullback,
  PULLBACK_MAX_STOP_ATR,
  PULLBACK_MIN_STOP_ATR,
  pullbackThresholds,
  SCALP_PULLBACK_HOLD_BOUNDS,
  scalpPullback,
  trend15m,
} from "../src/strategies/scalpPullback";

const T0 = Date.UTC(2024, 0, 1);
const MIN = TIMEFRAME_MS["1m"];
const M15 = TIMEFRAME_MS["15m"];
const P = scalpPullback.defaultParams;

const mk = (ts: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ ts, open: o, high: h, low: l, close: c, volume: v });

interface MinuteOpts {
  /** 1 = 上昇トレンドの押し目 (買い)、-1 = 下降トレンドの戻り (売り) */
  dir?: 1 | -1;
  /** トレンドの足の本数 */
  base?: number;
  /** 押し・戻りの本数 (0 で押し・戻りなし) */
  pull?: number;
  /** 押し・戻りの 1 本あたりの値幅 */
  pullStep?: number;
  /** 引き金の足の値幅 (トレンド方向) */
  trig?: number;
  /** 引き金の足を付けるか */
  trigger?: boolean;
  /** トレンドの足のひげ (既定 0.03) */
  baseWick?: number;
}

/**
 * 1m 足: 100 から 1 本 0.01 ずつ dir 方向へ進むトレンド (±0.02 の揺れ、ひげ baseWick) が base 本
 * → 逆方向の押し・戻り pull 本 (1 本 pullStep) → 末尾にトレンド方向の引き金の足 (直前の足の高値・安値を抜ける実体、出来高 2 倍)
 */
function minute(o: MinuteOpts = {}): Candle[] {
  const dir = o.dir ?? 1;
  const base = o.base ?? 120;
  const pull = o.pull ?? 4;
  const step = o.pullStep ?? 0.06;
  const trig = o.trig ?? 0.12;
  const wick = o.baseWick ?? 0.03;
  const out: Candle[] = [];
  let prev = 100;
  for (let i = 0; i < base; i++) {
    const c = 100 + dir * 0.01 * i + (i % 2 === 0 ? 0.02 : -0.02);
    out.push(mk(T0 + out.length * MIN, prev, Math.max(prev, c) + wick, Math.min(prev, c) - wick, c, 100));
    prev = c;
  }
  for (let k = 0; k < pull; k++) {
    const c = prev - dir * step;
    out.push(mk(T0 + out.length * MIN, prev, Math.max(prev, c) + 0.03, Math.min(prev, c) - 0.03, c, 100));
    prev = c;
  }
  if (o.trigger ?? true) {
    const c = prev + dir * trig;
    out.push(mk(T0 + out.length * MIN, prev, Math.max(prev, c) + 0.01, Math.min(prev, c) - 0.01, c, 200));
  }
  return out;
}

/** 15m の確定足 (now までに確定した分だけ)。末尾の終値が end で、1 本 step ずつ dir 方向へ進む (step 0 で横ばい) */
function fifteen(now: number, dir: 1 | -1, end: number, o: { n?: number; step?: number } = {}): Candle[] {
  const n = o.n ?? 50;
  const step = o.step ?? 0.2;
  const lastStart = Math.floor(now / M15) * M15 - M15;
  const out: Candle[] = [];
  for (let k = 0; k < n; k++) {
    const ts = lastStart - (n - 1 - k) * M15;
    const close = end - dir * step * (n - 1 - k);
    const open = close - dir * step;
    out.push(mk(ts, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, 1000));
  }
  return out;
}

const nowOf = (c1: Candle[]) => c1[c1.length - 1].ts + MIN;
/** c1 に合わせた 15m (末尾の終値 = 1m の末尾の終値) */
const fifteenFor = (c1: Candle[], dir: 1 | -1, o: { n?: number; step?: number } = {}) => fifteen(nowOf(c1), dir, c1[c1.length - 1].close, o);

const REGIME: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.6, spreadBps: 1 };

interface CtxOpts {
  c1: Candle[];
  c15?: Candle[];
  /** 15m の向き (c15 を省略したとき。既定は c1 の向きと同じにするため呼び出し側で指定) */
  trend?: 1 | -1;
  params?: Record<string, number>;
  instrument?: Partial<Instrument>;
  position?: PositionView;
  regime?: Partial<RegimeFeatures>;
  /** 片側のスプレッド (中値比)。既定 0.1bp */
  halfSpread?: number;
  tempo?: number;
  mode?: StrategyContext["mode"];
  onFiltered?: (s: Signal, reason: string) => void;
}

/** 費用がほぼ無い (手数料 0、スプレッド 0.2bp、滑り 1bp) 環境 */
function ctxOf(o: CtxOpts): StrategyContext {
  const last = o.c1[o.c1.length - 1];
  const now = nowOf(o.c1);
  const hs = o.halfSpread ?? 1e-5;
  return {
    market: {
      instrument: syntheticInstrument({ takerFeeRate: 0, tickSize: 0.0001, ...o.instrument }),
      now,
      quote: { ts: now, bid: last.close * (1 - hs), ask: last.close * (1 + hs), last: last.close },
      candles: { "1m": o.c1, "15m": o.c15 ?? fifteenFor(o.c1, o.trend ?? 1) },
    },
    regime: { ...REGIME, ...o.regime },
    position: o.position,
    params: { ...P, slippageBps: 1, ...o.params },
    mode: "mode" in o ? o.mode : "paper",
    ...(o.tempo !== undefined ? { tempo: o.tempo } : {}),
    ...(o.onFiltered ? { onFiltered: o.onFiltered } : {}),
  };
}

const collect = () => {
  const calls: { s: Signal; reason: string }[] = [];
  return { calls, cb: (s: Signal, reason: string) => void calls.push({ s, reason }) };
};

describe("scalp_pullback: 定義と既定値", () => {
  it("scalp・crypto・1m (+15m)・売り買い両方のレジーム", () => {
    expect(scalpPullback.id).toBe("scalp_pullback");
    expect(scalpPullback.horizon).toBe("scalp");
    expect(scalpPullback.assetClasses).toEqual(["crypto"]);
    expect(scalpPullback.primaryTimeframe).toBe("1m");
    expect(scalpPullback.timeframes).toEqual(["1m", "15m"]);
    expect(scalpPullback.regimes).toEqual(["trend_up", "trend_down", "high_vol", "range"]);
  });

  it("既定値は範囲内。保有は 10〜30 本、costMult の下限はテンポの下限 1.5", () => {
    for (const [k, v] of Object.entries(scalpPullback.defaultParams)) {
      const b = scalpPullback.paramBounds[k];
      expect(b, k).toBeDefined();
      expect(v, k).toBeGreaterThanOrEqual(b[0]);
      expect(v, k).toBeLessThanOrEqual(b[1]);
    }
    expect(scalpPullback.paramBounds.maxHoldBars).toEqual([...SCALP_PULLBACK_HOLD_BOUNDS]);
    expect(SCALP_PULLBACK_HOLD_BOUNDS).toEqual([10, 30]);
    expect(scalpPullback.paramBounds.costMult[0]).toBe(TEMPO_COST_MULT_FLOOR);
    expect(P).toMatchObject({
      stopAtr: 0.3, tpR: 2, trailAtr: 0, maxHoldBars: 30, entryThreshold: 12, pullbackBars: 8, touchAtr: 0.25,
      trendSlopeBars: 3, minTrendSlopeBps: 3, volBars: 20, costMult: 2.5, slippageBps: 2, minStopSpreads: 4, cooldownBars: 5,
    });
  });
});

describe("scalp_pullback: 15m のトレンド", () => {
  it("上昇は long、下降は short、横ばい・傾きが小さい・本数不足は null", () => {
    const now = T0 + 200 * MIN;
    expect(trend15m(fifteen(now, 1, 100), P)?.direction).toBe("long");
    expect(trend15m(fifteen(now, -1, 100), P)?.direction).toBe("short");
    expect(trend15m(fifteen(now, 1, 100, { step: 0 }), P)).toBeNull();
    // 傾き ≈ 2bps/本 < 3bps
    const gentle = fifteen(now, 1, 100, { step: 0.02 });
    expect(Math.abs(trend15m(gentle, P, 0)!.slopeBps)).toBeLessThan(P.minTrendSlopeBps);
    expect(trend15m(gentle, P)).toBeNull();
    expect(trend15m(fifteen(now, 1, 100, { n: 10 }), P)).toBeNull();
  });
});

describe("scalp_pullback: エントリー", () => {
  it("15m 上昇中の押し目の後、上抜けた足で買い。損切りは押しの安値の外、利確は 2R、30 分以内", () => {
    const c1 = minute();
    const ctx = ctxOf({ c1 });
    const sig = scalpPullback.evaluate(ctx)!;
    expect(sig).not.toBeNull();
    expect(sig.direction).toBe("long");
    expect(sig.strategyId).toBe("scalp_pullback");
    const s = detectPullback(c1, ctx.market.candles["15m"]!, P)!;
    expect(s.direction).toBe("long");
    expect(s.rsiExtreme).toBeLessThanOrEqual(50 - P.entryThreshold);
    const ask = ctx.market.quote.ask;
    expect(sig.stopLoss).toBeLessThan(s.swingLow);
    expect(sig.takeProfit!).toBeGreaterThan(ask);
    // 利確幅 = tpR × 損切り幅 (刻み 0.0001 の丸め)
    expect(sig.takeProfit! - ask).toBeCloseTo(P.tpR * (ask - sig.stopLoss), 3);
    expect(sig.maxHoldMs).toBe(30 * MIN);
    // 期待値はコスト控除後で正
    expect(sig.edgeIsNet).toBe(true);
    expect(sig.expectedEdgeBps).toBeGreaterThan(0);
    expect(sig.features.netEdgeBps).toBe(sig.expectedEdgeBps);
    expect(sig.features.winProb - sig.features.winProbBase).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(sig.features.tempo).toBe(0);
    for (const k of ["trendSlope15Bps", "rsi7", "rsiExtreme", "devAtr", "volRatio", "swingHigh", "swingLow", "costBps", "tpBps", "slBps", "winProb", "netEdgeBps", "tempo"]) {
      expect(Number.isFinite(sig.features[k]), k).toBe(true);
    }
    expect(sig.features.trendSlope15Bps).toBeGreaterThan(0);
    expect(sig.reason).toContain("押し目買い");
  });

  it("15m 下降中の戻りの後、下抜けた足で売り (allowShort の銘柄)。空売りできなければ null", () => {
    const c1 = minute({ dir: -1 });
    const ctx = ctxOf({ c1, trend: -1, instrument: { allowShort: true } });
    const sig = scalpPullback.evaluate(ctx)!;
    expect(sig).not.toBeNull();
    expect(sig.direction).toBe("short");
    const s = detectPullback(c1, ctx.market.candles["15m"]!, P)!;
    expect(s.rsiExtreme).toBeGreaterThanOrEqual(50 + P.entryThreshold);
    const bid = ctx.market.quote.bid;
    expect(sig.stopLoss).toBeGreaterThan(s.swingHigh);
    expect(sig.takeProfit!).toBeLessThan(bid);
    expect(bid - sig.takeProfit!).toBeCloseTo(P.tpR * (sig.stopLoss - bid), 3);
    expect(sig.edgeIsNet).toBe(true);
    expect(sig.expectedEdgeBps).toBeGreaterThan(0);
    expect(sig.reason).toContain("戻り売り");
    // 空売り不可 (live・バックテストでは allowShort だけ。paper でも再現の印が無ければ不可)
    expect(scalpPullback.evaluate(ctxOf({ c1, trend: -1, instrument: { allowShort: false } }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1, trend: -1, instrument: { allowShort: false }, mode: undefined }))).toBeNull();
    // paper で空売りを再現する銘柄なら出る
    const sim = scalpPullback.evaluate(ctxOf({ c1, trend: -1, instrument: { allowShort: false, simulatedShort: true } }));
    expect(sim?.direction).toBe("short");
  });

  it("トレンドに逆らう向きでは出さない (上昇の押し目の形でも 15m が下降・横ばいなら null)", () => {
    const up = minute();
    expect(scalpPullback.evaluate(ctxOf({ c1: up, trend: -1 }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: up, c15: fifteenFor(up, 1, { step: 0 }) }))).toBeNull();
    const down = minute({ dir: -1 });
    expect(scalpPullback.evaluate(ctxOf({ c1: down, trend: 1 }))).toBeNull();
  });

  it("押し目が無い・浅いときは出さない", () => {
    expect(scalpPullback.evaluate(ctxOf({ c1: minute({ pull: 0 }) }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: minute({ pull: 1 }) }))).toBeNull();
  });

  it("引き金の足が無い (押しの途中) なら出さない。低流動性・15m 不足でも出さない", () => {
    expect(scalpPullback.evaluate(ctxOf({ c1: minute({ trigger: false }) }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: minute(), regime: { label: "low_liquidity" } }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: minute(), c15: [] }))).toBeNull();
  });

  it("同じ押し目では続けて出さない (クールダウン)", () => {
    const c1 = minute();
    expect(scalpPullback.evaluate(ctxOf({ c1 }))).not.toBeNull();
    // 次の足も上抜けの陽線で条件が続く
    const last = c1[c1.length - 1];
    const next = mk(last.ts + MIN, last.close, last.close + 0.11, last.close - 0.01, last.close + 0.1, 200);
    const c2 = [...c1, next];
    expect(detectPullback(c2, fifteenFor(c2, 1), P)).not.toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: c2 }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1: c2, params: { cooldownBars: 1 } }))).toBeNull();
    // テンポを上げてもクールダウンは緩めない
    expect(scalpPullback.evaluate(ctxOf({ c1: c2, tempo: 1 }))).toBeNull();
  });
});

describe("scalp_pullback: 損切り幅", () => {
  it("押しの安値が近すぎるときは 0.8 ATR まで広げる", () => {
    // トレンドの足のひげを長くして ATR を大きくする (押しの安値までの距離は変わらない)
    const c1 = minute({ baseWick: 0.2 });
    const ctx = ctxOf({ c1 });
    const sig = scalpPullback.evaluate(ctx)!;
    expect(sig).not.toBeNull();
    expect(sig.features.stopAtrEff).toBe(PULLBACK_MIN_STOP_ATR);
    const ask = ctx.market.quote.ask;
    expect(ask - sig.stopLoss).toBeCloseTo(PULLBACK_MIN_STOP_ATR * sig.features.atr, 3);
    expect(sig.takeProfit! - ask).toBeCloseTo(P.tpR * PULLBACK_MIN_STOP_ATR * sig.features.atr, 3);
  });

  it("押しの安値が遠すぎる (3.5 ATR 超) なら見送る", () => {
    const c1 = minute();
    // 押しの途中の足に長い下ひげを付ける
    const i = c1.length - 3;
    c1[i] = { ...c1[i], low: c1[i].low - 0.35 };
    const c15 = fifteenFor(c1, 1);
    const s = detectPullback(c1, c15, P)!;
    expect(s).not.toBeNull();
    expect((c1[c1.length - 1].close - s.swingLow) / s.atr + P.stopAtr).toBeGreaterThan(PULLBACK_MAX_STOP_ATR);
    const { calls, cb } = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1, c15, onFiltered: cb }))).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("scalp_pullback: コストの条件", () => {
  it("往復コストが大きい (taker 0.12%) と出さず、onFiltered で cost を通知する", () => {
    const { calls, cb } = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1: minute(), instrument: { takerFeeRate: 0.0012 }, onFiltered: cb }))).toBeNull();
    expect(calls.map((c) => c.reason)).toEqual(["cost"]);
    const s = calls[0].s;
    expect(s.direction).toBe("long");
    expect(s.strategyId).toBe("scalp_pullback");
    expect(s.edgeIsNet).toBe(true);
    expect(s.features.costBps).toBeGreaterThan(24);
    expect(s.features.tpBps).toBeLessThan(P.costMult * s.features.costBps);
  });

  it("損切り幅がスプレッドの minStopSpreads 倍未満なら spread", () => {
    const { calls, cb } = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1: minute(), halfSpread: 0.0004, params: { costMult: 1.5 }, onFiltered: cb }))).toBeNull();
    expect(calls.map((c) => c.reason)).toEqual(["spread"]);
  });

  it("期待値が負 (勝率の上乗せ 0) なら edge。onFiltered が例外を投げても null", () => {
    const { calls, cb } = collect();
    const s0 = createScalpPullback({ winEdgeMax: 0 });
    expect(s0.evaluate(ctxOf({ c1: minute(), onFiltered: cb }))).toBeNull();
    expect(calls.map((c) => c.reason)).toEqual(["edge"]);
    expect(scalpPullback.evaluate(ctxOf({ c1: minute(), instrument: { takerFeeRate: 0.0012 }, onFiltered: () => { throw new Error("x"); } }))).toBeNull();
  });
});

describe("scalp_pullback: テンポ", () => {
  it("実効の閾値: tempo 0 は設定値そのもの、1 で entryThreshold・傾きは半分、touchAtr +0.5、costMult は 1.5 まで", () => {
    expect(pullbackThresholds(P, 0)).toEqual({ tempo: 0, entryThreshold: 12, minTrendSlopeBps: 3, touchAtr: 0.25, costMult: 2.5 });
    expect(pullbackThresholds(P)).toEqual(pullbackThresholds(P, 0));
    expect(pullbackThresholds(P, 1)).toEqual({ tempo: 1, entryThreshold: 6, minTrendSlopeBps: 1.5, touchAtr: 0.75, costMult: 1.5 });
    const half = pullbackThresholds(P, 0.5);
    expect(half.entryThreshold).toBeCloseTo(9, 9);
    expect(half.costMult).toBeCloseTo(2, 9);
    // 範囲外のテンポは 0〜1 に収める。costMult が下限未満の設定なら設定のまま
    expect(pullbackThresholds(P, 5)).toEqual(pullbackThresholds(P, 1));
    expect(pullbackThresholds(P, -1)).toEqual(pullbackThresholds(P, 0));
    expect(pullbackThresholds({ ...P, costMult: 1.2 }, 1).costMult).toBe(1.2);
  });

  it("tempo 未指定と 0 は同じ結果", () => {
    const c1 = minute();
    expect(scalpPullback.evaluate(ctxOf({ c1, tempo: 0 }))).toEqual(scalpPullback.evaluate(ctxOf({ c1 })));
  });

  it("entryThreshold: tempo 0 では押しが浅くて出ない形でも、tempo 1 なら出る", () => {
    const c1 = minute();
    const c15 = fifteenFor(c1, 1);
    const rsiMin = detectPullback(c1, c15, P)!.rsiExtreme;
    // 50 - band < rsiMin < 50 - band / 2 になる band (範囲内)
    const band = 25;
    expect(50 - band).toBeLessThan(rsiMin);
    expect(rsiMin).toBeLessThan(50 - band / 2);
    const params = { entryThreshold: band };
    expect(detectPullback(c1, c15, { ...P, ...params }, 0)).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1, c15, params }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1, c15, params, tempo: 0 }))).toBeNull();
    const sig = scalpPullback.evaluate(ctxOf({ c1, c15, params, tempo: 1 }))!;
    expect(sig).not.toBeNull();
    expect(sig.direction).toBe("long");
    expect(sig.features.tempo).toBe(1);
    expect(sig.features.entryThresholdEff).toBeCloseTo(band / 2, 9);
    expect(sig.reason).toContain("テンポ");
    // confidence の RSI の強さは緩める前の閾値で測る (テンポで期待値を膨らませない)
    const strict = scalpPullback.evaluate(ctxOf({ c1, c15, tempo: 1 }))!;
    expect(sig.confidence).toBeLessThan(strict.confidence);
  });

  it("15m の傾きの下限も緩める (2bps/本 は tempo 0 で null、tempo 1 で 1.5bps まで下がり通る)", () => {
    const c1 = minute();
    const c15 = fifteenFor(c1, 1, { step: 0.02 });
    expect(scalpPullback.evaluate(ctxOf({ c1, c15 }))).toBeNull();
    expect(scalpPullback.evaluate(ctxOf({ c1, c15, tempo: 1 }))?.direction).toBe("long");
  });

  it("コスト控除後の期待値の条件は緩めない: costMult は緩めても期待値が負なら edge で見送る", () => {
    // taker 0.08%: 利確幅 / コスト ≈ 2 (2.5 未満、1.5 以上)
    const c1 = minute();
    const tempo0 = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1, instrument: { takerFeeRate: 0.0008 }, onFiltered: tempo0.cb }))).toBeNull();
    expect(tempo0.calls.map((c) => c.reason)).toEqual(["cost"]);
    const ratio = tempo0.calls[0].s.features.tpBps / tempo0.calls[0].s.features.costBps;
    expect(ratio).toBeGreaterThan(TEMPO_COST_MULT_FLOOR);
    expect(ratio).toBeLessThan(P.costMult);
    const tempo1 = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1, instrument: { takerFeeRate: 0.0008 }, tempo: 1, onFiltered: tempo1.cb }))).toBeNull();
    expect(tempo1.calls.map((c) => c.reason)).toEqual(["edge"]);
    expect(tempo1.calls[0].s.expectedEdgeBps).toBeLessThan(0);
    // 勝率の上乗せ 0 (期待値 = -コスト) も tempo 1 で edge のまま
    const s0 = createScalpPullback({ winEdgeMax: 0 });
    const z = collect();
    expect(s0.evaluate(ctxOf({ c1, tempo: 1, onFiltered: z.cb }))).toBeNull();
    expect(z.calls.map((c) => c.reason)).toEqual(["edge"]);
    // minNetEdgeBps も緩めない
    expect(createScalpPullback({ minNetEdgeBps: 1e6 }).evaluate(ctxOf({ c1, tempo: 1 }))).toBeNull();
  });
});

describe("scalp_pullback: 保有中", () => {
  const pos = (qty: number): PositionView => ({
    symbol: "SYN/USDT", qty, avgPrice: 100, openedAt: T0, strategyId: "scalp_pullback", stopLoss: qty > 0 ? 99 : 101, highWater: 100, lowWater: 100,
  });

  it("15m の終値が EMA20 の反対側に抜けたら flat、トレンドが続いていれば null。新規は出さない", () => {
    const c1 = minute();
    const up = fifteenFor(c1, 1);
    expect(scalpPullback.evaluate(ctxOf({ c1, c15: up, position: pos(1) }))).toBeNull();
    // 最後の 15m 足が大きく下げて EMA20 の下で引けた
    const broken = up.slice();
    const lb = broken[broken.length - 1];
    broken[broken.length - 1] = { ...lb, close: lb.close - 5, low: lb.close - 5.05 };
    const ex = scalpPullback.evaluate(ctxOf({ c1, c15: broken, position: pos(1) }));
    expect(ex?.direction).toBe("flat");
    // 売りの建玉は 15m が上 (EMA より上) なら flat、下なら null
    expect(scalpPullback.evaluate(ctxOf({ c1, c15: up, position: pos(-1) }))?.direction).toBe("flat");
    expect(scalpPullback.evaluate(ctxOf({ c1, c15: fifteenFor(c1, -1), position: pos(-1) }))).toBeNull();
  });
});

describe("scalp_pullback: 最大保有", () => {
  it("maxHoldMs は必ず 10〜30 分 (範囲外のパラメータもクランプ)", () => {
    const c1 = minute();
    expect(scalpPullback.evaluate(ctxOf({ c1, params: { maxHoldBars: 999 } }))!.maxHoldMs).toBe(30 * MIN);
    expect(scalpPullback.evaluate(ctxOf({ c1, params: { maxHoldBars: 3 } }))!.maxHoldMs).toBe(10 * MIN);
    expect(scalpPullback.evaluate(ctxOf({ c1, params: { maxHoldBars: 15 } }))!.maxHoldMs).toBe(15 * MIN);
  });
});

describe("scalp_pullback: 確定足だけを使う", () => {
  it("判定は渡された確定足の末尾で行う (引き金の足が確定する前は出ない)。入力を書き換えない", () => {
    const full = minute();
    const c15 = fifteenFor(full, 1);
    expect(scalpPullback.evaluate(ctxOf({ c1: full.slice(0, -1), c15 }))).toBeNull();
    const ctx = ctxOf({ c1: full, c15 });
    const before = JSON.stringify(ctx.market.candles);
    const a = scalpPullback.evaluate(ctx);
    expect(a).not.toBeNull();
    expect(JSON.stringify(ctx.market.candles)).toBe(before);
    // 同じ入力なら同じ出力 (純粋関数)
    expect(scalpPullback.evaluate(ctx)).toEqual(a);
    for (const b of c15) expect(b.ts + M15).toBeLessThanOrEqual(ctx.market.now);
  });

  it("バックテスト (確定足だけを見せる) で評価時に見えている足はすべて確定済み。保有は 30 分以内", () => {
    const candles = generateCandles({ seed: 11, bars: 3000, timeframe: "1m", vol: 0.002, meanSegmentBars: 150 });
    let checked = 0;
    const spy = {
      ...scalpPullback,
      evaluate: (ctx: StrategyContext) => {
        for (const tf of ["1m", "15m"] as const) {
          for (const c of ctx.market.candles[tf] ?? []) expect(c.ts + TIMEFRAME_MS[tf]).toBeLessThanOrEqual(ctx.market.now);
        }
        checked++;
        const s = scalpPullback.evaluate(ctx);
        if (s && s.direction !== "flat") expect(s.maxHoldMs).toBeLessThanOrEqual(30 * MIN);
        return s;
      },
    };
    runBacktest({ strategy: spy, instrument: syntheticInstrument({ takerFeeRate: 0 }), candles, baseTimeframe: "1m", spreadBps: 0, slippageBps: 0 });
    expect(checked).toBeGreaterThan(100);
    // 長い合成データでバックテストを丸ごと回すため単独でも 4 秒前後かかる。並列実行の負荷で既定の 5 秒を越えないよう余裕を持たせる
  }, 30_000);
});

describe("scalp_pullback: 探索 (ctx.tempoExplore)", () => {
  it("tempoExplore が無い・false、または tempo 0 なら従来と同じ結果", () => {
    const c1 = minute();
    const a = scalpPullback.evaluate(ctxOf({ c1 }));
    expect(a).not.toBeNull();
    expect(scalpPullback.evaluate({ ...ctxOf({ c1 }), tempoExplore: false })).toEqual(a);
    expect(scalpPullback.evaluate({ ...ctxOf({ c1, tempo: 0 }), tempoExplore: true })).toEqual(a);
    expect(scalpPullback.evaluate({ ...ctxOf({ c1, tempo: 1 }), tempoExplore: false })).toEqual(scalpPullback.evaluate(ctxOf({ c1, tempo: 1 })));
  });

  it("期待値の下限を tempo × 往復コストだけ下げる (期待値 0 以下のシグナルを通す)", () => {
    // taker 0.08%: tempo 1 で costMult は通るが期待値が負 (edge)
    const c1 = minute();
    const inst = { takerFeeRate: 0.0008 };
    const z = collect();
    expect(scalpPullback.evaluate(ctxOf({ c1, instrument: inst, tempo: 1, onFiltered: z.cb }))).toBeNull();
    expect(z.calls.map((c) => c.reason)).toEqual(["edge"]);
    const e = z.calls[0].s.expectedEdgeBps;
    const c = z.calls[0].s.features.costBps;
    expect(e).toBeLessThan(0);
    expect(e).toBeGreaterThan(-c);
    const sig = scalpPullback.evaluate({ ...ctxOf({ c1, instrument: inst, tempo: 1 }), tempoExplore: true })!;
    expect(sig).not.toBeNull();
    expect(sig.expectedEdgeBps).toBeCloseTo(e, 9);
    expect(sig.edgeIsNet).toBe(true);
    // tempo 0 なら探索でも下限は下がらない
    expect(scalpPullback.evaluate({ ...ctxOf({ c1, instrument: { takerFeeRate: 0.0008 }, params: { costMult: 1.5 } }), tempo: 0, tempoExplore: true })).toBeNull();
  });
});
