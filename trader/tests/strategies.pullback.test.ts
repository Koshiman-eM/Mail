/**
 * pullback_5m (5m の押し・戻り、1h のトレンド) と pullback_15m (15m の押し・戻り、4h のトレンド) の単体テスト。
 * 判定の中身は scalp_pullback と同じ (createPullback) なので、ここでは時間足・保有本数・時間足に依存する既定値・
 * 上位足の取り違えが無いことを中心に確かめる。合成データのみ (オフライン)
 */
import { describe, expect, it } from "vitest";
import type { AssetClass, Candle, Horizon, Instrument, PositionView, RegimeFeatures, Signal, Strategy, StrategyContext, Timeframe } from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { generateCandles, syntheticInstrument } from "../src/backtest/synthetic";
import { runBacktest } from "../src/backtest/engine";
import { DEFAULT_OBSERVE_ONLY_STRATEGIES, DEFAULT_STRUCTURE_STRATEGIES } from "../src/appConfig";
import { TEMPO_COST_MULT_FLOOR } from "../src/engine/tempo";
import { hubTimeframesFor } from "../src/engine/setup";
import { ALL_STRATEGIES, getStrategy } from "../src/strategies/registry";
import {
  createPullback,
  createPullback15m,
  createPullback5m,
  detectPullback,
  PULLBACK_15M_CONFIG,
  PULLBACK_15M_HOLD_BOUNDS,
  PULLBACK_5M_CONFIG,
  PULLBACK_5M_HOLD_BOUNDS,
  PULLBACK_EXEC_MIN_BARS,
  PULLBACK_TREND_WARMUP_BARS,
  pullback15m,
  pullback5m,
  pullbackMinTrendBars,
  pullbackTrend,
  pullbackWarmupBars,
  SCALP_PULLBACK_CONFIG,
  scalpPullback,
} from "../src/strategies/scalpPullback";

/** 資産クラス (と時間軸) に対応する戦略 (登録順) */
const strategiesFor = (assetClass: AssetClass, horizon?: Horizon) =>
  ALL_STRATEGIES.filter((s) => s.assetClasses.includes(assetClass) && (horizon === undefined || s.horizon === horizon));

const T0 = Date.UTC(2024, 0, 1);

const mk = (ts: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ ts, open: o, high: h, low: l, close: c, volume: v });

interface Case {
  name: string;
  strategy: Strategy;
  create: typeof createPullback5m;
  execTf: Timeframe;
  trendTf: Timeframe;
  /** features の上位足の名前 */
  tag: string;
  hold: readonly [number, number];
  maxHoldBars: number;
  minTrendSlopeBps: number;
  pullbackBars: number;
  cooldownBars: number;
  /** 上位足 1 本あたりの値幅 (既定の傾きの下限より小さく、半分より大きい: テンポ 1 なら通る) */
  gentleStep: number;
  /** 取り違えの確認に使う、上位足ではない時間足 (主時間足とも違うもの) */
  otherTf: Timeframe;
}

const CASES: Case[] = [
  {
    name: "pullback_5m", strategy: pullback5m, create: createPullback5m, execTf: "5m", trendTf: "1h", tag: "1h",
    hold: [6, 24], maxHoldBars: 12, minTrendSlopeBps: 6, pullbackBars: 6, cooldownBars: 4, gentleStep: 0.04, otherTf: "15m",
  },
  {
    name: "pullback_15m", strategy: pullback15m, create: createPullback15m, execTf: "15m", trendTf: "4h", tag: "4h",
    hold: [4, 16], maxHoldBars: 8, minTrendSlopeBps: 12, pullbackBars: 8, cooldownBars: 5, gentleStep: 0.08, otherTf: "1h",
  },
];

const REGIME: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.6, spreadBps: 1 };

describe.each(CASES)("$name", (c) => {
  const S = c.strategy;
  const P = S.defaultParams;
  const EX = TIMEFRAME_MS[c.execTf];
  const TR = TIMEFRAME_MS[c.trendTf];

  /**
   * 主時間足: 100 から 1 本 0.01 ずつ dir 方向へ進むトレンド (±0.02 の揺れ、ひげ 0.03) が base 本
   * → 逆方向の押し・戻り pull 本 (1 本 0.06) → 末尾にトレンド方向の引き金の足 (直前の足を抜ける実体、出来高 2 倍)
   */
  function execBars(o: { dir?: 1 | -1; base?: number; pull?: number; trigger?: boolean } = {}): Candle[] {
    const dir = o.dir ?? 1;
    const out: Candle[] = [];
    let prev = 100;
    for (let i = 0; i < (o.base ?? 120); i++) {
      const cl = 100 + dir * 0.01 * i + (i % 2 === 0 ? 0.02 : -0.02);
      out.push(mk(T0 + out.length * EX, prev, Math.max(prev, cl) + 0.03, Math.min(prev, cl) - 0.03, cl, 100));
      prev = cl;
    }
    for (let k = 0; k < (o.pull ?? 4); k++) {
      const cl = prev - dir * 0.06;
      out.push(mk(T0 + out.length * EX, prev, Math.max(prev, cl) + 0.03, Math.min(prev, cl) - 0.03, cl, 100));
      prev = cl;
    }
    if (o.trigger ?? true) {
      const cl = prev + dir * 0.12;
      out.push(mk(T0 + out.length * EX, prev, Math.max(prev, cl) + 0.01, Math.min(prev, cl) - 0.01, cl, 200));
    }
    return out;
  }

  const nowOf = (ce: Candle[]) => ce[ce.length - 1].ts + EX;

  /** 長さ ms の足の確定足 (now までに確定した分)。末尾の終値が end で、1 本 step ずつ dir 方向へ進む (step 0 で横ばい) */
  function upperBars(ms: number, now: number, dir: 1 | -1, end: number, o: { n?: number; step?: number } = {}): Candle[] {
    const n = o.n ?? 50;
    const step = o.step ?? 0.2;
    const lastStart = Math.floor(now / ms) * ms - ms;
    const out: Candle[] = [];
    for (let k = 0; k < n; k++) {
      const close = end - dir * step * (n - 1 - k);
      const open = close - dir * step;
      out.push(mk(lastStart - (n - 1 - k) * ms, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, 1000));
    }
    return out;
  }
  /** ce に合わせた上位足 (trendTf。末尾の終値 = 主時間足の末尾の終値) */
  const trendFor = (ce: Candle[], dir: 1 | -1, o: { n?: number; step?: number } = {}) => upperBars(TR, nowOf(ce), dir, ce[ce.length - 1].close, o);

  interface CtxOpts {
    ce: Candle[];
    /** 上位足 (省略時は trend の向きで作る) */
    ct?: Candle[];
    trend?: 1 | -1;
    /** 上位足の代わりに渡す足の組 (時間足の取り違えの確認用) */
    candles?: Partial<Record<Timeframe, Candle[]>>;
    params?: Record<string, number>;
    instrument?: Partial<Instrument>;
    position?: PositionView;
    tempo?: number;
    mode?: StrategyContext["mode"];
    onFiltered?: (s: Signal, reason: string) => void;
  }

  /** 費用がほぼ無い (手数料 0、スプレッド 0.2bp、滑り 1bp) 環境 */
  function ctxOf(o: CtxOpts): StrategyContext {
    const last = o.ce[o.ce.length - 1];
    const now = nowOf(o.ce);
    return {
      market: {
        instrument: syntheticInstrument({ takerFeeRate: 0, tickSize: 0.0001, ...o.instrument }),
        now,
        quote: { ts: now, bid: last.close * (1 - 1e-5), ask: last.close * (1 + 1e-5), last: last.close },
        candles: o.candles ?? { [c.execTf]: o.ce, [c.trendTf]: o.ct ?? trendFor(o.ce, o.trend ?? 1) },
      },
      regime: REGIME,
      position: o.position,
      params: { ...P, slippageBps: 1, ...o.params },
      mode: "mode" in o ? o.mode : "paper",
      ...(o.tempo !== undefined ? { tempo: o.tempo } : {}),
      ...(o.onFiltered ? { onFiltered: o.onFiltered } : {}),
    };
  }

  describe("定義と既定値", () => {
    it(`short・crypto・${c.execTf} (+${c.trendTf})・売り買い両方のレジーム。registry から引ける`, () => {
      expect(S.id).toBe(c.name);
      expect(S.horizon).toBe("short");
      // meme: Jupiter のミームコインにも掛ける (板・出来高を条件に使わない)
      expect(S.assetClasses).toEqual(["crypto", "meme"]);
      expect(S.primaryTimeframe).toBe(c.execTf);
      expect(S.timeframes).toEqual([c.execTf, c.trendTf]);
      expect(S.regimes).toEqual(["trend_up", "trend_down", "high_vol", "range"]);
      expect(getStrategy(c.name)).toBe(S);
      expect(strategiesFor("crypto", "short").map((s) => s.id)).toContain(c.name);
      expect(strategiesFor("meme").map((s) => s.id)).toContain(c.name);
    });

    it(`既定値は範囲内。保有は ${c.hold[0]}〜${c.hold[1]} 本、時間足に依存する値だけ scalp_pullback と違う`, () => {
      for (const [k, v] of Object.entries(P)) {
        const b = S.paramBounds[k];
        expect(b, k).toBeDefined();
        expect(v, k).toBeGreaterThanOrEqual(b[0]);
        expect(v, k).toBeLessThanOrEqual(b[1]);
      }
      expect(Object.keys(S.paramBounds).sort()).toEqual(Object.keys(scalpPullback.paramBounds).sort());
      expect(S.paramBounds.maxHoldBars).toEqual([...c.hold]);
      expect(S.paramBounds.costMult[0]).toBe(TEMPO_COST_MULT_FLOOR);
      expect(P).toMatchObject({
        maxHoldBars: c.maxHoldBars, minTrendSlopeBps: c.minTrendSlopeBps, pullbackBars: c.pullbackBars, cooldownBars: c.cooldownBars,
      });
      // 傾きの下限は上位足の長さの比の平方根で拡大 (15m の 3bps 基準)。範囲の上限も同じ倍率
      const k = Math.sqrt(TR / TIMEFRAME_MS["15m"]);
      expect(P.minTrendSlopeBps).toBeCloseTo(scalpPullback.defaultParams.minTrendSlopeBps * k, 9);
      expect(S.paramBounds.minTrendSlopeBps[1]).toBeCloseTo(scalpPullback.paramBounds.minTrendSlopeBps[1] * k, 9);
      // 時間足に依存しない値は scalp_pullback と同じ
      for (const key of ["stopAtr", "tpR", "trailAtr", "entryThreshold", "touchAtr", "trendSlopeBars", "volBars", "costMult", "slippageBps", "minStopSpreads"]) {
        expect(P[key], key).toBe(scalpPullback.defaultParams[key]);
        expect(S.paramBounds[key], key).toEqual(scalpPullback.paramBounds[key]);
      }
    });

    it("warmup は上位足 28 本ぶん (バックテスト・検証の前置きで上位足の EMA と傾きが測れる)", () => {
      expect(S.warmup).toBe(pullbackWarmupBars(c.execTf, c.trendTf));
      expect(S.warmup * EX).toBeGreaterThanOrEqual(PULLBACK_TREND_WARMUP_BARS * TR);
      // trendSlopeBars を上限にしても足りる
      const maxSlopeBars = S.paramBounds.trendSlopeBars[1];
      expect(pullbackMinTrendBars({ ...P, trendSlopeBars: maxSlopeBars })).toBeLessThanOrEqual(PULLBACK_TREND_WARMUP_BARS);
      expect(S.warmup).toBeGreaterThanOrEqual(PULLBACK_EXEC_MIN_BARS);
    });

    it(`運用の hub は crypto の銘柄で ${c.execTf}・${c.trendTf} を取得する (strategy.timeframes の和集合)`, () => {
      const tfs = hubTimeframesFor([{ assetClass: "crypto" }], ALL_STRATEGIES);
      expect(tfs).toContain(c.execTf);
      expect(tfs).toContain(c.trendTf);
      expect(hubTimeframesFor([{ assetClass: "crypto" }], [S])).toEqual(["1m", c.execTf, c.trendTf]);
      expect(hubTimeframesFor([{ assetClass: "meme" }], [S])).toEqual(["1m", c.execTf, c.trendTf]);
    });

    it("相場構造のフィルター・観測専用の既定には入れない (自前の上位足のトレンドの条件がある)", () => {
      expect(DEFAULT_STRUCTURE_STRATEGIES.split(",")).not.toContain(c.name);
      expect(DEFAULT_OBSERVE_ONLY_STRATEGIES.split(",")).not.toContain(c.name);
    });
  });

  describe("エントリー", () => {
    it(`${c.trendTf} 上昇中の押し目の後、上抜けた足で買い。損切りは押しの安値の外、利確は 2R、最大保有は ${c.maxHoldBars} 本`, () => {
      const ce = execBars();
      const ctx = ctxOf({ ce });
      const sig = S.evaluate(ctx)!;
      expect(sig).not.toBeNull();
      expect(sig.direction).toBe("long");
      expect(sig.strategyId).toBe(c.name);
      expect(sig.horizon).toBe("short");
      const s = detectPullback(ce, ctx.market.candles[c.trendTf]!, P)!;
      expect(s.direction).toBe("long");
      expect(s.rsiExtreme).toBeLessThanOrEqual(50 - P.entryThreshold);
      const ask = ctx.market.quote.ask;
      expect(sig.stopLoss).toBeLessThan(s.swingLow);
      expect(sig.takeProfit!).toBeGreaterThan(ask);
      expect(sig.takeProfit! - ask).toBeCloseTo(P.tpR * (ask - sig.stopLoss), 3);
      expect(sig.maxHoldMs).toBe(c.maxHoldBars * EX);
      expect(sig.edgeIsNet).toBe(true);
      expect(sig.expectedEdgeBps).toBeGreaterThan(0);
      expect(sig.features[`trendSlope${c.tag}Bps`]).toBeGreaterThan(0);
      expect(Number.isFinite(sig.features[`trendEma${c.tag}`])).toBe(true);
      expect(sig.features.trendSlope15Bps).toBeUndefined();
      expect(sig.reason).toContain(`${c.trendTf} 上昇中の押し目買い`);
    });

    it(`${c.trendTf} 下降中の戻りの後、下抜けた足で売り (allowShort の銘柄)。空売りできなければ null`, () => {
      const ce = execBars({ dir: -1 });
      const ctx = ctxOf({ ce, trend: -1, instrument: { allowShort: true } });
      const sig = S.evaluate(ctx)!;
      expect(sig).not.toBeNull();
      expect(sig.direction).toBe("short");
      const s = detectPullback(ce, ctx.market.candles[c.trendTf]!, P)!;
      expect(s.rsiExtreme).toBeGreaterThanOrEqual(50 + P.entryThreshold);
      const bid = ctx.market.quote.bid;
      expect(sig.stopLoss).toBeGreaterThan(s.swingHigh);
      expect(sig.takeProfit!).toBeLessThan(bid);
      expect(bid - sig.takeProfit!).toBeCloseTo(P.tpR * (sig.stopLoss - bid), 3);
      expect(sig.maxHoldMs).toBe(c.maxHoldBars * EX);
      expect(sig.features[`trendSlope${c.tag}Bps`]).toBeLessThan(0);
      expect(sig.reason).toContain(`${c.trendTf} 下降中の戻り売り`);
      // 空売り不可 (live・バックテストでは allowShort だけ)。paper で空売りを再現する銘柄なら出る
      expect(S.evaluate(ctxOf({ ce, trend: -1, instrument: { allowShort: false } }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce, trend: -1, instrument: { allowShort: false }, mode: undefined }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce, trend: -1, instrument: { allowShort: false, simulatedShort: true } }))?.direction).toBe("short");
    });

    it("トレンドに逆らう向きでは出さない (押し目の形でも上位足が下降・横ばいなら null)", () => {
      const up = execBars();
      expect(S.evaluate(ctxOf({ ce: up, trend: -1 }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce: up, ct: trendFor(up, 1, { step: 0 }) }))).toBeNull();
      const down = execBars({ dir: -1 });
      expect(S.evaluate(ctxOf({ ce: down, trend: 1, instrument: { allowShort: true } }))).toBeNull();
    });

    it(`上位足は ${c.trendTf} で判定する (${c.otherTf} など別の時間足のトレンドは見ない。${c.trendTf} が無ければ出さない)`, () => {
      const ce = execBars();
      const up = trendFor(ce, 1);
      const otherMs = TIMEFRAME_MS[c.otherTf];
      const downOther = upperBars(otherMs, nowOf(ce), -1, ce[ce.length - 1].close);
      const upOther = upperBars(otherMs, nowOf(ce), 1, ce[ce.length - 1].close);
      expect(S.evaluate(ctxOf({ ce, candles: { [c.execTf]: ce, [c.trendTf]: up, [c.otherTf]: downOther } }))?.direction).toBe("long");
      expect(S.evaluate(ctxOf({ ce, candles: { [c.execTf]: ce, [c.otherTf]: upOther } }))).toBeNull();
      // 上位足の本数不足 (EMA20 + 傾きの本数に届かない) も出さない
      expect(S.evaluate(ctxOf({ ce, ct: trendFor(ce, 1, { n: pullbackMinTrendBars(P) - 1 }) }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce, ct: trendFor(ce, 1, { n: pullbackMinTrendBars(P) }) }))?.direction).toBe("long");
    });

    it("傾きの下限は上位足に合わせて大きい (scalp_pullback の 3bps は越えても既定の下限未満なら null)。テンポ 1 で半分まで緩む", () => {
      const ce = execBars();
      const ct = trendFor(ce, 1, { step: c.gentleStep });
      const slope = pullbackTrend(ct, P, 0)!.slopeBps;
      expect(slope).toBeGreaterThan(scalpPullback.defaultParams.minTrendSlopeBps);
      expect(slope).toBeLessThan(P.minTrendSlopeBps);
      expect(slope).toBeGreaterThan(P.minTrendSlopeBps / 2);
      expect(S.evaluate(ctxOf({ ce, ct }))).toBeNull();
      const sig = S.evaluate(ctxOf({ ce, ct, tempo: 1 }))!;
      expect(sig?.direction).toBe("long");
      expect(sig.features.minTrendSlopeBpsEff).toBeCloseTo(P.minTrendSlopeBps / 2, 9);
    });

    it("押しが無い・押しの途中・低流動性なら出さない", () => {
      expect(S.evaluate(ctxOf({ ce: execBars({ pull: 0 }) }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce: execBars({ trigger: false }) }))).toBeNull();
      expect(S.evaluate({ ...ctxOf({ ce: execBars() }), regime: { ...REGIME, label: "low_liquidity" } })).toBeNull();
    });

    it(`主時間足の本数は warmup ではなく ${PULLBACK_EXEC_MIN_BARS} 本から判定する (運用の 300 本で出る)`, () => {
      const ce = execBars();
      expect(S.warmup).toBeGreaterThan(300);
      expect(ce.length).toBeLessThan(300);
      expect(S.evaluate(ctxOf({ ce }))).not.toBeNull();
      // 40 本未満なら出さない
      const short = execBars({ base: PULLBACK_EXEC_MIN_BARS - 6 });
      expect(short.length).toBeLessThan(PULLBACK_EXEC_MIN_BARS);
      expect(S.evaluate(ctxOf({ ce: short }))).toBeNull();
    });

    it(`同じ押し目では続けて出さない (クールダウン ${c.cooldownBars} 本、主時間足)。テンポでも緩めない`, () => {
      const ce = execBars();
      expect(S.evaluate(ctxOf({ ce }))).not.toBeNull();
      const last = ce[ce.length - 1];
      const ce2 = [...ce, mk(last.ts + EX, last.close, last.close + 0.11, last.close - 0.01, last.close + 0.1, 200)];
      expect(detectPullback(ce2, trendFor(ce2, 1), P)).not.toBeNull();
      expect(S.evaluate(ctxOf({ ce: ce2 }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce: ce2, params: { cooldownBars: 1 } }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce: ce2, tempo: 1 }))).toBeNull();
    });

    it("コストの条件 (taker 0.12% で cost を通知) と、勝率の上乗せ 0 での edge は scalp_pullback と同じ", () => {
      const filtered: string[] = [];
      expect(S.evaluate(ctxOf({ ce: execBars(), instrument: { takerFeeRate: 0.0012 }, onFiltered: (_s, r) => void filtered.push(r) }))).toBeNull();
      expect(filtered).toEqual(["cost"]);
      const z: Signal[] = [];
      expect(c.create({ winEdgeMax: 0 }).evaluate(ctxOf({ ce: execBars(), onFiltered: (s) => void z.push(s) }))).toBeNull();
      expect(z).toHaveLength(1);
      expect(z[0].strategyId).toBe(c.name);
      expect(z[0].edgeIsNet).toBe(true);
      expect(c.create({ minNetEdgeBps: 1e6 }).evaluate(ctxOf({ ce: execBars(), tempo: 1 }))).toBeNull();
      expect(c.create({ id: "x" }).id).toBe("x");
    });
  });

  describe("最大保有", () => {
    it(`maxHoldMs は必ず ${c.hold[0]}〜${c.hold[1]} 本 (${c.execTf}) (範囲外のパラメータもクランプ)`, () => {
      const ce = execBars();
      expect(S.evaluate(ctxOf({ ce, params: { maxHoldBars: 999 } }))!.maxHoldMs).toBe(c.hold[1] * EX);
      expect(S.evaluate(ctxOf({ ce, params: { maxHoldBars: 1 } }))!.maxHoldMs).toBe(c.hold[0] * EX);
      const mid = c.hold[0] + 1;
      expect(S.evaluate(ctxOf({ ce, params: { maxHoldBars: mid } }))!.maxHoldMs).toBe(mid * EX);
    });
  });

  describe("保有中", () => {
    const pos = (qty: number): PositionView => ({
      symbol: "SYN/USDT", qty, avgPrice: 100, openedAt: T0, strategyId: c.name, stopLoss: qty > 0 ? 99 : 101, highWater: 100, lowWater: 100,
    });

    it(`${c.trendTf} の終値が EMA20 の反対側に抜けたら flat、トレンドが続いていれば null。新規は出さない`, () => {
      const ce = execBars();
      const up = trendFor(ce, 1);
      expect(S.evaluate(ctxOf({ ce, ct: up, position: pos(1) }))).toBeNull();
      const broken = up.slice();
      const lb = broken[broken.length - 1];
      broken[broken.length - 1] = { ...lb, close: lb.close - 5, low: lb.close - 5.05 };
      const ex = S.evaluate(ctxOf({ ce, ct: broken, position: pos(1) }))!;
      expect(ex.direction).toBe("flat");
      expect(ex.strategyId).toBe(c.name);
      expect(ex.reason).toContain(`${c.trendTf} のトレンドの崩れ`);
      expect(Number.isFinite(ex.features[`trendClose${c.tag}`])).toBe(true);
      expect(Number.isFinite(ex.features[`trendEma${c.tag}`])).toBe(true);
      // 売りの建玉は上位足が EMA より上なら flat、下なら null
      expect(S.evaluate(ctxOf({ ce, ct: up, position: pos(-1) }))?.direction).toBe("flat");
      expect(S.evaluate(ctxOf({ ce, ct: trendFor(ce, -1), position: pos(-1) }))).toBeNull();
    });

    it(`崩れは ${c.trendTf} で判定する (${c.otherTf} だけが崩れても flat にしない。${c.trendTf} が無ければ判定しない)`, () => {
      const ce = execBars();
      const up = trendFor(ce, 1);
      const downOther = upperBars(TIMEFRAME_MS[c.otherTf], nowOf(ce), -1, ce[ce.length - 1].close - 3);
      // (確認用) 同じ足を上位足として渡せば崩れで flat になる
      expect(S.evaluate(ctxOf({ ce, candles: { [c.execTf]: ce, [c.trendTf]: downOther }, position: pos(1) }))?.direction).toBe("flat");
      expect(S.evaluate(ctxOf({ ce, candles: { [c.execTf]: ce, [c.trendTf]: up, [c.otherTf]: downOther }, position: pos(1) }))).toBeNull();
      expect(S.evaluate(ctxOf({ ce, candles: { [c.execTf]: ce, [c.otherTf]: downOther }, position: pos(1) }))).toBeNull();
    });
  });

  describe("確定足だけを使う", () => {
    it(`バックテストで評価時に見えている足はすべて確定済み。保有は ${c.hold[1]} 本以内`, () => {
      const candles = generateCandles({ seed: 11, bars: 2000, timeframe: c.execTf, vol: 0.004, meanSegmentBars: 150 });
      let checked = 0;
      const spy: Strategy = {
        ...S,
        evaluate: (ctx: StrategyContext) => {
          for (const tf of [c.execTf, c.trendTf]) {
            for (const b of ctx.market.candles[tf] ?? []) expect(b.ts + TIMEFRAME_MS[tf]).toBeLessThanOrEqual(ctx.market.now);
          }
          checked++;
          const s = S.evaluate(ctx);
          if (s && s.direction !== "flat") expect(s.maxHoldMs).toBeLessThanOrEqual(c.hold[1] * EX);
          return s;
        },
      };
      const r = runBacktest({ strategy: spy, instrument: syntheticInstrument({ takerFeeRate: 0 }), candles, baseTimeframe: c.execTf, spreadBps: 0, slippageBps: 0 });
      expect(checked).toBeGreaterThan(100);
      for (const t of r.trades) expect(t.exitTs - t.entryTs).toBeLessThanOrEqual(c.hold[1] * EX + EX);
    }, 30_000);
  });
});

describe("createPullback: scalp_pullback の設定は従来と同じ", () => {
  it("scalp_pullback は id・時間軸・時間足・warmup・保有本数・features の名前が従来どおり", () => {
    expect(SCALP_PULLBACK_CONFIG).toMatchObject({ id: "scalp_pullback", horizon: "scalp", execTf: "1m", trendTf: "15m", warmup: 40, featureTag: "15" });
    expect(scalpPullback.warmup).toBe(40);
    expect(scalpPullback.timeframes).toEqual(["1m", "15m"]);
    // 設定から作り直しても同じ定義
    const again = createPullback({ ...SCALP_PULLBACK_CONFIG });
    expect(again.defaultParams).toEqual(scalpPullback.defaultParams);
    expect(again.paramBounds).toEqual(scalpPullback.paramBounds);
  });

  it("pullbackWarmupBars: 上位足 28 本ぶんを主時間足の本数で (切り上げ)。40 本未満にはしない", () => {
    expect(PULLBACK_TREND_WARMUP_BARS).toBe(28);
    expect(pullbackWarmupBars("5m", "1h")).toBe(336);
    expect(pullbackWarmupBars("15m", "4h")).toBe(448);
    expect(pullbackWarmupBars("1m", "15m")).toBe(420);
    expect(pullbackWarmupBars("1m", "1m")).toBe(PULLBACK_EXEC_MIN_BARS);
  });

  it("設定ごとの保有本数・上位足の組 (ダウ理論の MTF: 5m→1h、15m→4h)", () => {
    expect(PULLBACK_5M_CONFIG).toMatchObject({ id: "pullback_5m", horizon: "short", execTf: "5m", trendTf: "1h" });
    expect(PULLBACK_15M_CONFIG).toMatchObject({ id: "pullback_15m", horizon: "short", execTf: "15m", trendTf: "4h" });
    expect(PULLBACK_5M_HOLD_BOUNDS).toEqual([6, 24]);
    expect(PULLBACK_15M_HOLD_BOUNDS).toEqual([4, 16]);
    // 保有時間は 30 分〜2 時間、1〜4 時間
    expect(PULLBACK_5M_HOLD_BOUNDS.map((b) => b * TIMEFRAME_MS["5m"])).toEqual([30 * 60_000, 120 * 60_000]);
    expect(PULLBACK_15M_HOLD_BOUNDS.map((b) => b * TIMEFRAME_MS["15m"])).toEqual([60 * 60_000, 240 * 60_000]);
  });
});
