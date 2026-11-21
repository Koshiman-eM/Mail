/** scalp_rebound (15m の下降トレンド中の 1m の反発を買う) の単体テスト。合成データのみ (オフライン) */
import { describe, expect, it } from "vitest";
import type { AssetClass, Candle, Horizon, Instrument, PositionView, RegimeFeatures, Signal, StrategyContext } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { runBacktest } from "../src/backtest/engine";
import { ALL_STRATEGIES, getStrategy, resolveParams } from "../src/strategies/registry";
import { createScalpRebound, detectRebound, SCALP_REBOUND_HOLD_BOUNDS, scalpRebound, trendDown15m } from "../src/strategies/scalpRebound";

/** 資産クラス (と時間軸) に対応する戦略 (登録順) */
const strategiesFor = (assetClass: AssetClass, horizon?: Horizon) =>
  ALL_STRATEGIES.filter((s) => s.assetClasses.includes(assetClass) && (horizon === undefined || s.horizon === horizon));

const T0 = Date.UTC(2024, 0, 1);
const MIN = TIMEFRAME_MS["1m"];
const M15 = TIMEFRAME_MS["15m"];

const mk = (ts: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ ts, open: o, high: h, low: l, close: c, volume: v });

/**
 * 1m 足: 100 付近の小さな揺れ (足の幅 ±0.05) が base 本 → 一方向の急落 sell 本 (1 本 -0.15) → 末尾に反転の足 (reversal=true のとき)。
 * 反転の足は始値 = 直前の終値、終値 = 始値 + 0.06 の陽線で、下ひげが長い (始値 - 0.10)。出来高は平常の 3 倍
 */
function oneMinute(o: { base?: number; sell?: number; reversal?: boolean } = {}): Candle[] {
  const base = o.base ?? 140;
  const sell = o.sell ?? 6;
  const out: Candle[] = [];
  let prev = 100;
  for (let i = 0; i < base; i++) {
    const c = 100 + (i % 2 === 0 ? 0.02 : -0.02);
    out.push(mk(T0 + out.length * MIN, prev, Math.max(prev, c) + 0.05, Math.min(prev, c) - 0.05, c, 100));
    prev = c;
  }
  for (let k = 0; k < sell; k++) {
    const c = prev - 0.15;
    out.push(mk(T0 + out.length * MIN, prev, prev + 0.01, c - 0.01, c, 150));
    prev = c;
  }
  if (o.reversal ?? true) {
    const c = prev + 0.06;
    out.push(mk(T0 + out.length * MIN, prev, c + 0.01, prev - 0.1, c, 300));
  }
  return out;
}

/** 15m の確定足 (now までに確定した分だけ)。dir = -1 で毎本 0.2 ずつ下げ、1 で上げる */
function fifteen(now: number, dir: 1 | -1, n = 50): Candle[] {
  const lastStart = Math.floor(now / M15) * M15 - M15; // now までに確定した最後の 15m 足
  const out: Candle[] = [];
  for (let k = 0; k < n; k++) {
    const ts = lastStart - (n - 1 - k) * M15;
    const open = 110 - dir * 10 + dir * 0.2 * k;
    const close = open + dir * 0.2;
    out.push(mk(ts, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, 1000));
  }
  return out;
}

const REGIME: RegimeFeatures = { label: "trend_down", trend: -0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.6, spreadBps: 1 };

interface CtxOpts {
  c1: Candle[];
  c15?: Candle[];
  trend?: 1 | -1;
  params?: Record<string, number>;
  instrument?: Partial<Instrument>;
  position?: PositionView;
  regime?: Partial<RegimeFeatures>;
  /** 片側のスプレッド (中値比)。既定 0.1bp */
  halfSpread?: number;
  onFiltered?: (s: Signal, reason: string) => void;
}

/** 費用がほぼ無い (手数料 0、スプレッド 0.2bp、滑り 1bp) 環境 */
function ctxOf(o: CtxOpts): StrategyContext {
  const last = o.c1[o.c1.length - 1];
  const now = last.ts + MIN; // 末尾の 1m 足は確定済み
  const hs = o.halfSpread ?? 1e-5;
  return {
    market: {
      instrument: syntheticInstrument({ takerFeeRate: 0, tickSize: 0.0001, ...o.instrument }),
      now,
      quote: { ts: now, bid: last.close * (1 - hs), ask: last.close * (1 + hs), last: last.close },
      candles: { "1m": o.c1, "15m": o.c15 ?? fifteen(now, o.trend ?? -1) },
    },
    regime: { ...REGIME, ...o.regime },
    position: o.position,
    params: { ...scalpRebound.defaultParams, slippageBps: 1, ...o.params },
    mode: "paper",
    ...(o.onFiltered ? { onFiltered: o.onFiltered } : {}),
  };
}

describe("scalp_rebound: 登録と既定値", () => {
  it("registry に scalp・crypto・買いの戦略として登録され、戦略数は 11", () => {
    expect(ALL_STRATEGIES).toHaveLength(11);
    expect(getStrategy("scalp_rebound")).toBe(scalpRebound);
    expect(strategiesFor("crypto", "scalp").map((s) => s.id)).toContain("scalp_rebound");
    expect(strategiesFor("meme").map((s) => s.id)).not.toContain("scalp_rebound");
    expect(scalpRebound.horizon).toBe("scalp");
    expect(scalpRebound.assetClasses).toEqual(["crypto"]);
    expect(scalpRebound.primaryTimeframe).toBe("1m");
    expect(scalpRebound.timeframes).toEqual(["1m", "15m"]);
    expect(scalpRebound.regimes).toEqual(["trend_down", "high_vol", "range"]);
  });

  it("標準のパラメータ名を持ち、既定値は範囲内", () => {
    for (const k of ["stopAtr", "tpAtr", "trailAtr", "entryThreshold", "maxHoldBars"]) {
      expect(scalpRebound.defaultParams[k]).toBeTypeOf("number");
      expect(scalpRebound.paramBounds[k]).toBeDefined();
    }
    for (const [k, v] of Object.entries(scalpRebound.defaultParams)) {
      const b = scalpRebound.paramBounds[k];
      expect(b, k).toBeDefined();
      expect(v).toBeGreaterThanOrEqual(b[0]);
      expect(v).toBeLessThanOrEqual(b[1]);
    }
    expect(scalpRebound.paramBounds.maxHoldBars).toEqual([...SCALP_REBOUND_HOLD_BOUNDS]);
    // 学習でコストの条件を緩めすぎない
    expect(scalpRebound.paramBounds.costMult[0]).toBeGreaterThanOrEqual(2);
    expect(resolveParams(scalpRebound, { maxHoldBars: 999 }).maxHoldBars).toBe(SCALP_REBOUND_HOLD_BOUNDS[1]);
  });
});

describe("scalp_rebound: 15m の下降トレンドの判定", () => {
  it("下げ続ける 15m は下降、上げ続ける 15m は下降ではない", () => {
    const now = T0 + 200 * MIN;
    const p = scalpRebound.defaultParams;
    const d = trendDown15m(fifteen(now, -1), p);
    expect(d).not.toBeNull();
    expect(d!.slopeBps).toBeLessThan(0);
    expect(d!.gapBps).toBeLessThan(0);
    expect(trendDown15m(fifteen(now, 1), p)).toBeNull();
    // 本数不足
    expect(trendDown15m(fifteen(now, -1, 10), p)).toBeNull();
  });
});

describe("scalp_rebound: エントリー", () => {
  it("15m が下降で、1m が売られ過ぎから反転した足で買いのシグナルを出す", () => {
    const c1 = oneMinute();
    const sig = scalpRebound.evaluate(ctxOf({ c1 }));
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("long");
    expect(sig!.strategyId).toBe("scalp_rebound");
    const ask = c1[c1.length - 1].close * (1 + 1e-5);
    // 損切りは直近安値より下、利確は短期平均 (EMA20) 以下
    const s = detectRebound(c1, fifteen(c1[c1.length - 1].ts + MIN, -1), scalpRebound.defaultParams)!;
    expect(sig!.stopLoss).toBeLessThan(s.swingLow);
    expect(sig!.takeProfit!).toBeGreaterThan(ask);
    expect(sig!.takeProfit!).toBeLessThanOrEqual(s.mean + 1e-9);
    // 最大保有は 15〜30 分
    expect(sig!.maxHoldMs).toBeGreaterThanOrEqual(SCALP_REBOUND_HOLD_BOUNDS[0] * MIN);
    expect(sig!.maxHoldMs).toBeLessThanOrEqual(SCALP_REBOUND_HOLD_BOUNDS[1] * MIN);
    // 期待値はコスト控除後で正、特徴量に記録
    expect(sig!.expectedEdgeBps).toBeGreaterThan(0);
    expect(sig!.features.netEdgeBps).toBe(sig!.expectedEdgeBps);
    expect(sig!.features.winProb).toBeGreaterThan(sig!.features.winProbBase);
    expect(sig!.features.winProb - sig!.features.winProbBase).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(sig!.features.rsiMin).toBeLessThanOrEqual(scalpRebound.defaultParams.rsiOversold);
    expect(sig!.features.devAtr).toBeGreaterThanOrEqual(scalpRebound.defaultParams.entryThreshold);
    expect(sig!.features.trendSlope15Bps).toBeLessThan(0);
  });

  it("15m が上昇なら出さない", () => {
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute(), trend: 1 }))).toBeNull();
  });

  it("15m の足が足りなければ出さない", () => {
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute(), c15: [] }))).toBeNull();
  });

  it("反転の足が無い (急落の途中) なら出さない。陰線の急落では売りも出さない", () => {
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute({ reversal: false }) }))).toBeNull();
  });

  it("売られ過ぎでない (急落が浅い) なら出さない", () => {
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute({ sell: 1 }) }))).toBeNull();
  });

  it("低流動性では出さない", () => {
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute(), regime: { label: "low_liquidity" } }))).toBeNull();
  });

  it("売りのシグナルは出さない (急騰の後の反落の形を上下反転しても売らない)", () => {
    // 上下を反転した系列 (15m は上昇・1m は買われ過ぎから反落)
    const flip = (c: Candle): Candle => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high });
    const c1 = oneMinute().map(flip);
    const now = c1[c1.length - 1].ts + MIN;
    const c15 = fifteen(now, -1).map(flip);
    const sig = scalpRebound.evaluate(ctxOf({ c1, c15, instrument: { allowShort: true } }));
    expect(sig).toBeNull();
    // 合成データのバックテストでも売りは 1 件も無い
    const candles = generateCandles({ seed: 5, bars: 6000, timeframe: "1m", vol: 0.002, meanSegmentBars: 150 });
    const seen: Signal[] = [];
    const spy = { ...scalpRebound, evaluate: (ctx: StrategyContext) => { const s = scalpRebound.evaluate(ctx); if (s) seen.push(s); return s; } };
    const r = runBacktest({ strategy: spy, instrument: syntheticInstrument({ takerFeeRate: 0, allowShort: true }), candles, baseTimeframe: "1m", spreadBps: 0, slippageBps: 0 });
    expect(r.stats.evaluations).toBeGreaterThan(0);
    expect(seen.every((s) => s.direction !== "short")).toBe(true);
    expect(r.trades.every((t) => t.direction === "long")).toBe(true);
  });

  it("同じ反発では続けて出さない (クールダウン)", () => {
    const c1 = oneMinute();
    expect(scalpRebound.evaluate(ctxOf({ c1 }))).not.toBeNull();
    // 次の足も陽線で同じ条件が続く: 直前の足で成立しているので見送る
    const last = c1[c1.length - 1];
    const next = mk(last.ts + MIN, last.close, last.close + 0.04, last.close - 0.08, last.close + 0.03, 300);
    const c2 = [...c1, next];
    // 条件自体は次の足でも成立している (クールダウンが無ければ出る)
    expect(detectRebound(c2, fifteen(next.ts + MIN, -1), scalpRebound.defaultParams)).not.toBeNull();
    expect(scalpRebound.evaluate(ctxOf({ c1: c2 }))).toBeNull();
    // クールダウン 1 本でも直前の足で成立しているので見送る
    expect(scalpRebound.evaluate(ctxOf({ c1: c2, params: { cooldownBars: 1 } }))).toBeNull();
  });
});

describe("scalp_rebound: 確定足だけを使う", () => {
  it("判定は渡された確定足の末尾で行い、未確定の反転の足 (まだ渡されない) を先取りしない", () => {
    const full = oneMinute();
    // 反転の足が確定する前 (エンジンは確定足だけを渡す) は出ない
    expect(scalpRebound.evaluate(ctxOf({ c1: full.slice(0, -1) }))).toBeNull();
    // 確定後に出る
    expect(scalpRebound.evaluate(ctxOf({ c1: full }))).not.toBeNull();
  });

  it("15m は now までに確定した足だけで判定する (未来の 15m 足を足しても結果が変わらないことは、渡される足が確定足だけであることに依存する)", () => {
    const c1 = oneMinute();
    const now = c1[c1.length - 1].ts + MIN;
    const c15 = fifteen(now, -1);
    for (const b of c15) expect(b.ts + M15).toBeLessThanOrEqual(now);
    const a = scalpRebound.evaluate(ctxOf({ c1, c15 }));
    expect(a).not.toBeNull();
  });

  it("バックテスト (確定足だけを見せる) で評価時に見えている足はすべて確定済み", () => {
    const candles = generateCandles({ seed: 9, bars: 2000, timeframe: "1m", vol: 0.002, meanSegmentBars: 150 });
    let checked = 0;
    const spy = {
      ...scalpRebound,
      evaluate: (ctx: StrategyContext) => {
        for (const tf of ["1m", "15m"] as const) {
          for (const c of ctx.market.candles[tf] ?? []) expect(c.ts + TIMEFRAME_MS[tf]).toBeLessThanOrEqual(ctx.market.now);
        }
        checked++;
        return scalpRebound.evaluate(ctx);
      },
    };
    runBacktest({ strategy: spy, instrument: syntheticInstrument({ takerFeeRate: 0 }), candles, baseTimeframe: "1m" });
    expect(checked).toBeGreaterThan(100);
  });
});

describe("scalp_rebound: コストの条件", () => {
  it("往復コストが大きい (taker 0.12%) と出さず、onFiltered で cost を通知する", () => {
    const filtered: { s: Signal; reason: string }[] = [];
    const sig = scalpRebound.evaluate(ctxOf({ c1: oneMinute(), instrument: { takerFeeRate: 0.0012 }, onFiltered: (s, reason) => filtered.push({ s, reason }) }));
    expect(sig).toBeNull();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].reason).toBe("cost");
    expect(filtered[0].s.direction).toBe("long");
    expect(filtered[0].s.strategyId).toBe("scalp_rebound");
    expect(filtered[0].s.features.costBps).toBeGreaterThan(24);
    expect(filtered[0].s.features.tpBps).toBeLessThan(scalpRebound.defaultParams.costMult * filtered[0].s.features.costBps);
  });

  it("onFiltered が例外を投げても戦略の結果は null のまま", () => {
    const sig = scalpRebound.evaluate(ctxOf({ c1: oneMinute(), instrument: { takerFeeRate: 0.0012 }, onFiltered: () => { throw new Error("x"); } }));
    expect(sig).toBeNull();
  });

  it("期待値が負なら edge で通知する (勝率の上乗せ 0)", () => {
    const filtered: string[] = [];
    const s0 = createScalpRebound({ winEdgeMax: 0 });
    const sig = s0.evaluate(ctxOf({ c1: oneMinute(), onFiltered: (_s, r) => filtered.push(r) }));
    expect(sig).toBeNull();
    expect(filtered).toEqual(["edge"]);
  });
});

describe("scalp_rebound: 保有中", () => {
  it("短期平均へ戻ったら flat、まだなら null。新規の買いは出さない", () => {
    const pos: PositionView = { symbol: "SYN", qty: 1, avgPrice: 99, openedAt: T0, strategyId: "scalp_rebound", stopLoss: 98, highWater: 99, lowWater: 99 } as PositionView;
    expect(scalpRebound.evaluate(ctxOf({ c1: oneMinute(), position: pos }))).toBeNull();
    // 反発して終値が短期平均 (EMA20) を上回ったら flat
    const c1 = oneMinute();
    let px = c1[c1.length - 1].close;
    for (let k = 0; k < 6; k++) {
      c1.push(mk(c1[c1.length - 1].ts + MIN, px, px + 0.16, px - 0.01, px + 0.15, 200));
      px += 0.15;
    }
    const sig = scalpRebound.evaluate(ctxOf({ c1, position: pos }));
    expect(sig).not.toBeNull();
    expect(sig!.direction).toBe("flat");
    // 同じ足でも建玉が無ければ新規の買いは出さない (平均より上)
    expect(scalpRebound.evaluate(ctxOf({ c1 }))).toBeNull();
  });
});

describe("scalp_rebound: テンポ", () => {
  it("シグナルに edgeIsNet: true を付ける。tempo 未指定と 0 は同じ結果", () => {
    const a = scalpRebound.evaluate(ctxOf({ c1: oneMinute() }))!;
    expect(a.edgeIsNet).toBe(true);
    expect(scalpRebound.evaluate({ ...ctxOf({ c1: oneMinute() }), tempo: 0 })).toEqual(a);
  });

  it("緩めるのは costMult だけ (1.5 まで)。期待値の条件は緩めない", () => {
    const c1 = oneMinute();
    const noEv = createScalpRebound({ minNetEdgeBps: -Infinity });
    const ok = noEv.evaluate(ctxOf({ c1 }))!;
    const ratio = ok.features.tpBps / ok.features.costBps;
    expect(ratio).toBeGreaterThan(1.5);
    const params = { costMult: ratio + 0.1 };
    const filtered: string[] = [];
    expect(noEv.evaluate(ctxOf({ c1, params, onFiltered: (_s, r) => filtered.push(r) }))).toBeNull();
    expect(filtered).toEqual(["cost"]);
    expect(noEv.evaluate({ ...ctxOf({ c1, params }), tempo: 1 })?.direction).toBe("long");
    // 期待値が負 (勝率の上乗せ 0) ならテンポ 1 でも edge で見送る
    const edge: string[] = [];
    expect(createScalpRebound({ winEdgeMax: 0 }).evaluate({ ...ctxOf({ c1, onFiltered: (_s, r) => edge.push(r) }), tempo: 1 })).toBeNull();
    expect(edge).toEqual(["edge"]);
  });
});

describe("scalp_rebound: 探索 (ctx.tempoExplore)", () => {
  it("tempoExplore が無い・false、または tempo 0 なら従来と同じ結果", () => {
    const a = scalpRebound.evaluate(ctxOf({ c1: oneMinute() }));
    expect(a).not.toBeNull();
    expect(scalpRebound.evaluate({ ...ctxOf({ c1: oneMinute() }), tempoExplore: false })).toEqual(a);
    expect(scalpRebound.evaluate({ ...ctxOf({ c1: oneMinute() }), tempo: 0, tempoExplore: true })).toEqual(a);
    expect(scalpRebound.evaluate({ ...ctxOf({ c1: oneMinute() }), tempo: 1, tempoExplore: false })).toEqual(
      scalpRebound.evaluate({ ...ctxOf({ c1: oneMinute() }), tempo: 1 }),
    );
  });

  it("期待値の下限を tempo × 往復コストだけ下げる (期待値 0 以下のシグナルを通す)", () => {
    const base = { c1: oneMinute(), params: { costMult: 0 }, instrument: { takerFeeRate: 0.0012 } };
    const edge: Signal[] = [];
    expect(scalpRebound.evaluate({ ...ctxOf({ ...base, onFiltered: (s, r) => void (r === "edge" && edge.push(s)) }), tempo: 1 })).toBeNull();
    expect(edge).toHaveLength(1);
    const e = edge[0].expectedEdgeBps;
    const c = edge[0].features.costBps;
    expect(e).toBeLessThan(0);
    expect(e).toBeGreaterThan(-c);
    const sig = scalpRebound.evaluate({ ...ctxOf(base), tempo: 1, tempoExplore: true })!;
    expect(sig).not.toBeNull();
    expect(sig.expectedEdgeBps).toBeCloseTo(e, 9);
    expect(scalpRebound.evaluate({ ...ctxOf(base), tempo: -e / c / 2, tempoExplore: true })).toBeNull();
  });
});
