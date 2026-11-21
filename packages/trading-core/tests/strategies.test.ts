import { describe, expect, it } from "vitest";
import type {
  Candle,
  Instrument,
  IntelBias,
  OrderBook,
  PositionView,
  RegimeFeatures,
  Signal,
  Strategy,
  StrategyContext,
  Timeframe,
  TradePrint,
} from "../src/core/types";
import { TIMEFRAME_MS } from "../src/core/types";
import { ema } from "../src/indicators/series";
import { scalpMomentumBurst, scalpObi, scalpVwapRevert } from "../src/strategies/scalp";
import { shortBreakout, shortEmaTrend, shortRsiRevert } from "../src/strategies/short";
import { createRng, syntheticInstrument } from "../src/backtest/synthetic";

// ───────────────────────── ヘルパー ─────────────────────────

const T0 = Date.UTC(2024, 0, 1);

function mk(tf: Timeframe, i: number, o: number, h: number, l: number, c: number, v = 100): Candle {
  return { ts: T0 + i * TIMEFRAME_MS[tf], open: o, high: h, low: l, close: c, volume: v };
}

/** 中心 center のノイズ足 (幅 ±range, ノイズ σ) */
function flat(tf: Timeframe, n: number, center = 100, sigma = 0.05, range = 0.1, volume = 100, seed = 3): Candle[] {
  const rng = createRng(seed);
  const out: Candle[] = [];
  let prev = center;
  for (let i = 0; i < n; i++) {
    const c = center + sigma * rng.normal();
    out.push(mk(tf, i, prev, Math.max(prev, c) + range, Math.min(prev, c) - range, c, volume));
    prev = c;
  }
  return out;
}

/** 次の足を追加する */
function push(cs: Candle[], tf: Timeframe, o: number, h: number, l: number, c: number, v = 100): void {
  cs.push(mk(tf, cs.length, o, h, l, c, v));
}

const REGIME_RANGE: RegimeFeatures = { label: "range", trend: 0, trendStrength: 15, volatility: 0.002, volatilityPercentile: 0.5, spreadBps: 1 };

interface CtxOpts {
  strategy: Strategy;
  candles: Partial<Record<Timeframe, Candle[]>>;
  book?: OrderBook;
  prints?: TradePrint[];
  intel?: IntelBias;
  position?: PositionView;
  params?: Record<string, number>;
  regime?: Partial<RegimeFeatures>;
  instrument?: Partial<Instrument>;
}

function makeCtx(o: CtxOpts): StrategyContext {
  const primary = o.candles[o.strategy.primaryTimeframe] ?? [];
  const lastBar = primary[primary.length - 1];
  const now = lastBar ? lastBar.ts + TIMEFRAME_MS[o.strategy.primaryTimeframe] : T0;
  const px = lastBar?.close ?? 100;
  return {
    market: {
      instrument: syntheticInstrument(o.instrument),
      now,
      quote: { ts: now, bid: px * (1 - 1e-4), ask: px * (1 + 1e-4), last: px },
      book: o.book,
      prints: o.prints,
      candles: o.candles,
    },
    regime: { ...REGIME_RANGE, ...o.regime },
    intel: o.intel,
    position: o.position,
    params: { ...o.strategy.defaultParams, ...o.params },
  };
}


const pos = (qty: number, price = 100): PositionView => ({
  symbol: "SYN/USDT",
  qty,
  avgPrice: price,
  openedAt: T0,
  strategyId: "x",
  stopLoss: qty > 0 ? price * 0.95 : price * 1.05,
  highWater: price,
  lowWater: price,
});

/** エントリーシグナルの共通検証 */
function expectEntry(s: Signal | null, strategy: Strategy, dir: "long" | "short", params = strategy.defaultParams): Signal {
  expect(s).not.toBeNull();
  const sig = s!;
  expect(sig.strategyId).toBe(strategy.id);
  expect(sig.horizon).toBe(strategy.horizon);
  expect(sig.direction).toBe(dir);
  expect(sig.confidence).toBeGreaterThan(0);
  expect(sig.confidence).toBeLessThanOrEqual(1);
  expect(sig.expectedEdgeBps).toBeGreaterThan(0);
  expect(sig.maxHoldMs).toBe(Math.round(params.maxHoldBars) * TIMEFRAME_MS[strategy.primaryTimeframe]);
  // 損切り・利確は想定価格の正しい側にあり、損切り幅:利確幅 = stopAtr:tpAtr
  const atr = sig.features.atr;
  const entry = dir === "long" ? sig.stopLoss + params.stopAtr * atr : sig.stopLoss - params.stopAtr * atr;
  if (dir === "long") {
    expect(sig.stopLoss).toBeLessThan(entry);
    expect(sig.takeProfit!).toBeGreaterThan(entry);
  } else {
    expect(sig.stopLoss).toBeGreaterThan(entry);
    expect(sig.takeProfit!).toBeLessThan(entry);
  }
  expect(Math.abs(sig.takeProfit! - entry)).toBeCloseTo(params.tpAtr * atr, 3);
  // expectedEdgeBps ≈ 利確までの距離 (bps) × confidence (インテルのチルトが無い場合)
  if (sig.features.intelAgreement === undefined) {
    expect(sig.expectedEdgeBps).toBeCloseTo(((params.tpAtr * atr) / entry) * 1e4 * sig.confidence, 1);
  }
  for (const v of Object.values(sig.features)) expect(Number.isFinite(v)).toBe(true);
  return sig;
}

/** 純粋関数: 同じ入力で同じ出力・入力を変更しない */
function expectPure(strategy: Strategy, ctx: StrategyContext): void {
  const before = JSON.stringify(ctx);
  const a = strategy.evaluate(ctx);
  const b = strategy.evaluate(ctx);
  expect(a).toEqual(b);
  expect(JSON.stringify(ctx)).toBe(before);
}

// ───────────────────────── scalp_obi ─────────────────────────

describe("scalp_obi", () => {
  const candles = { "1m": flat("1m", 30) };
  const buyBook: OrderBook = {
    ts: 0,
    bids: [
      [99.99, 50],
      [99.98, 40],
      [99.97, 40],
    ],
    asks: [
      [100.01, 5],
      [100.02, 5],
      [100.03, 5],
    ],
  };
  const sellBook: OrderBook = { ts: 0, bids: buyBook.asks.map(([p, s]) => [p - 0.02, s]), asks: buyBook.bids.map(([p, s]) => [p + 0.02, s]) };
  const now = candles["1m"][29].ts + 60_000;
  const buys: TradePrint[] = [1, 2, 3].map((k) => ({ ts: now - k * 1000, price: 100, size: 5, side: "buy" }));
  const sells: TradePrint[] = buys.map((p) => ({ ...p, side: "sell" }));

  it("買い板が厚く買いフローならロング", () => {
    const ctx = makeCtx({ strategy: scalpObi, candles, book: buyBook, prints: buys });
    const s = expectEntry(scalpObi.evaluate(ctx), scalpObi, "long");
    expect(s.stopLoss).toBeLessThan(100.01);
    expect(s.features.obi).toBeGreaterThan(0.5);
    expectPure(scalpObi, ctx);
  });

  it("売り優勢ならショート、allowShort=false なら出さない", () => {
    expectEntry(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: sellBook, prints: sells })), scalpObi, "short");
    expect(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: sellBook, prints: sells, instrument: { allowShort: false } }))).toBeNull();
  });

  it("板が無ければ null (requiresBook)", () => {
    expect(scalpObi.requiresBook).toBe(true);
    expect(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, prints: buys }))).toBeNull();
  });

  it("拮抗していれば null", () => {
    const even: OrderBook = { ts: 0, bids: [[99.99, 10]], asks: [[100.01, 10]] };
    expect(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: even }))).toBeNull();
  });

  it("ロング保有中に売り優勢へ反転したら flat、そうでなければ null", () => {
    const flatSig = scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: sellBook, prints: sells, position: pos(1) }));
    expect(flatSig?.direction).toBe("flat");
    expect(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: buyBook, prints: buys, position: pos(1) }))).toBeNull();
  });

  it("低流動性レジームでは新規エントリーしない", () => {
    expect(scalpObi.evaluate(makeCtx({ strategy: scalpObi, candles, book: buyBook, prints: buys, regime: { label: "low_liquidity" } }))).toBeNull();
  });
});

// ───────────────────────── scalp_vwap_revert ─────────────────────────

describe("scalp_vwap_revert", () => {
  function dropData(sign: 1 | -1): Candle[] {
    const cs = flat("1m", 60, 100, 0.05, 0.05);
    let prev = cs[cs.length - 1].close;
    for (const d of [0.3, 0.4, 0.5]) {
      const c = prev - sign * d;
      push(cs, "1m", prev, Math.max(prev, c) + 0.02, Math.min(prev, c) - 0.02, c, 120);
      prev = c;
    }
    return cs;
  }

  it("VWAP から大きく下方乖離 + RSI7 売られ過ぎでロング", () => {
    const ctx = makeCtx({ strategy: scalpVwapRevert, candles: { "1m": dropData(1) } });
    const s = expectEntry(scalpVwapRevert.evaluate(ctx), scalpVwapRevert, "long");
    expect(s.features.z).toBeLessThan(-2);
    expect(s.features.rsi7).toBeLessThan(25);
    expectPure(scalpVwapRevert, ctx);
  });

  it("上方乖離ならショート", () => {
    expectEntry(scalpVwapRevert.evaluate(makeCtx({ strategy: scalpVwapRevert, candles: { "1m": dropData(-1) } })), scalpVwapRevert, "short");
  });

  it("トレンドが強い (ADX > maxAdx) ときは入らない", () => {
    expect(scalpVwapRevert.evaluate(makeCtx({ strategy: scalpVwapRevert, candles: { "1m": dropData(1) }, regime: { trendStrength: 45 } }))).toBeNull();
  });

  it("乖離が無ければ null", () => {
    expect(scalpVwapRevert.evaluate(makeCtx({ strategy: scalpVwapRevert, candles: { "1m": flat("1m", 60) } }))).toBeNull();
  });

  it("ショート保有中に下方の極値が出たら flat", () => {
    const s = scalpVwapRevert.evaluate(makeCtx({ strategy: scalpVwapRevert, candles: { "1m": dropData(1) }, position: pos(-1) }));
    expect(s?.direction).toBe("flat");
  });
});

// ───────────────────────── scalp_momentum_burst ─────────────────────────

describe("scalp_momentum_burst", () => {
  function burst(volume: number, up = true): Candle[] {
    const cs = flat("1m", 40, 100, 0.03, 0.1);
    const o = cs[cs.length - 1].close;
    const c = up ? 100.6 : 99.4;
    push(cs, "1m", o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, volume);
    return cs;
  }

  it("出来高急増 + 高値ブレイクでロング", () => {
    const ctx = makeCtx({ strategy: scalpMomentumBurst, candles: { "1m": burst(500) } });
    const s = expectEntry(scalpMomentumBurst.evaluate(ctx), scalpMomentumBurst, "long");
    expect(s.features.volRatio).toBeGreaterThan(2.5);
    expect(s.trailingStopPct).toBeGreaterThan(0);
    expectPure(scalpMomentumBurst, ctx);
  });

  it("安値ブレイクはショート", () => {
    expectEntry(scalpMomentumBurst.evaluate(makeCtx({ strategy: scalpMomentumBurst, candles: { "1m": burst(500, false) } })), scalpMomentumBurst, "short");
  });

  it("出来高が伴わなければ null", () => {
    expect(scalpMomentumBurst.evaluate(makeCtx({ strategy: scalpMomentumBurst, candles: { "1m": burst(120) } }))).toBeNull();
  });

  it("ロング保有中の下方ブレイクで flat、上方ブレイクなら null", () => {
    expect(scalpMomentumBurst.evaluate(makeCtx({ strategy: scalpMomentumBurst, candles: { "1m": burst(500, false) }, position: pos(1) }))?.direction).toBe("flat");
    expect(scalpMomentumBurst.evaluate(makeCtx({ strategy: scalpMomentumBurst, candles: { "1m": burst(500) }, position: pos(1) }))).toBeNull();
  });
});

// ───────────────────────── short_ema_trend ─────────────────────────

describe("short_ema_trend", () => {
  /** 上昇トレンド → 押し目 (安値が EMA9 に触れる) → 陽線で反発 */
  function pullback(sign: 1 | -1): Candle[] {
    const cs: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const c = 100 + sign * 0.5 * i;
      push(cs, "15m", c - sign * 0.2, c + 0.3, c - 0.3, c);
    }
    // EMA9 に触れるまで押す
    for (let k = 0; k < 10; k++) {
      const e9 = ema(
        cs.map((x) => x.close),
        9,
      );
      const last = cs[cs.length - 1];
      if (sign > 0 ? last.low <= e9[e9.length - 1] : last.high >= e9[e9.length - 1]) break;
      const c = last.close - sign * 0.8;
      push(cs, "15m", last.close, Math.max(last.close, c) + 0.1, Math.min(last.close, c) - 0.1, c);
    }
    const e9 = ema(
      cs.map((x) => x.close),
      9,
    );
    const last = cs[cs.length - 1];
    const c = sign > 0 ? Math.max(e9[e9.length - 1] + 0.6, last.close + 0.6) : Math.min(e9[e9.length - 1] - 0.6, last.close - 0.6);
    push(cs, "15m", last.close, Math.max(last.close, c) + 0.1, Math.min(last.close, c) - 0.1, c);
    return cs;
  }

  it("上昇トレンドの押し目でロング", () => {
    const ctx = makeCtx({ strategy: shortEmaTrend, candles: { "15m": pullback(1) } });
    const s = expectEntry(shortEmaTrend.evaluate(ctx), shortEmaTrend, "long");
    expect(s.features.adx).toBeGreaterThan(20);
    expectPure(shortEmaTrend, ctx);
  });

  it("下降トレンドの戻りでショート", () => {
    expectEntry(shortEmaTrend.evaluate(makeCtx({ strategy: shortEmaTrend, candles: { "15m": pullback(-1) } })), shortEmaTrend, "short");
  });

  it("方向感が無ければ null", () => {
    expect(shortEmaTrend.evaluate(makeCtx({ strategy: shortEmaTrend, candles: { "15m": flat("15m", 100) } }))).toBeNull();
  });

  it("ロング保有中に EMA9 < EMA21 なら flat", () => {
    expect(shortEmaTrend.evaluate(makeCtx({ strategy: shortEmaTrend, candles: { "15m": pullback(-1) }, position: pos(1) }))?.direction).toBe("flat");
    expect(shortEmaTrend.evaluate(makeCtx({ strategy: shortEmaTrend, candles: { "15m": pullback(1) }, position: pos(1) }))).toBeNull();
  });
});

// ───────────────────────── short_rsi_revert ─────────────────────────

describe("short_rsi_revert", () => {
  function plunge(sign: 1 | -1): Candle[] {
    const cs = flat("15m", 60, 100, 0.3, 0.2);
    let prev = cs[cs.length - 1].close;
    for (const d of [1, 1.2, 1.5]) {
      const c = prev - sign * d;
      push(cs, "15m", prev, Math.max(prev, c) + 0.1, Math.min(prev, c) - 0.1, c);
      prev = c;
    }
    return cs;
  }

  it("下限バンド割れ + RSI 売られ過ぎでロング", () => {
    const ctx = makeCtx({ strategy: shortRsiRevert, candles: { "15m": plunge(1) } });
    const s = expectEntry(shortRsiRevert.evaluate(ctx), shortRsiRevert, "long");
    expect(s.features.rsi14).toBeLessThan(30);
    expectPure(shortRsiRevert, ctx);
  });

  it("上限バンド超え + 買われ過ぎでショート", () => {
    expectEntry(shortRsiRevert.evaluate(makeCtx({ strategy: shortRsiRevert, candles: { "15m": plunge(-1) } })), shortRsiRevert, "short");
  });

  it("トレンドレジーム (ADX 高) や通常時は null", () => {
    expect(shortRsiRevert.evaluate(makeCtx({ strategy: shortRsiRevert, candles: { "15m": plunge(1) }, regime: { trendStrength: 40 } }))).toBeNull();
    expect(shortRsiRevert.evaluate(makeCtx({ strategy: shortRsiRevert, candles: { "15m": flat("15m", 60, 100, 0.3, 0.2) } }))).toBeNull();
  });
});

// ───────────────────────── short_breakout ─────────────────────────

describe("short_breakout", () => {
  function box(lastClose: number, volume: number): Candle[] {
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const c = i % 2 === 0 ? 100.5 : 99.5;
      push(cs, "1h", 100, 101, 99, c, 100);
    }
    push(cs, "1h", 100.5, Math.max(100.5, lastClose) + 0.3, Math.min(100.5, lastClose) - 0.1, lastClose, volume);
    return cs;
  }

  it("チャネル上抜け + 出来高でロング", () => {
    const ctx = makeCtx({ strategy: shortBreakout, candles: { "1h": box(102.5, 300) } });
    const s = expectEntry(shortBreakout.evaluate(ctx), shortBreakout, "long");
    expect(s.features.channelHigh).toBe(101);
    expectPure(shortBreakout, ctx);
  });

  it("下抜けはショート", () => {
    expectEntry(shortBreakout.evaluate(makeCtx({ strategy: shortBreakout, candles: { "1h": box(97.5, 300) } })), shortBreakout, "short");
  });

  it("出来高不足・チャネル内なら null", () => {
    expect(shortBreakout.evaluate(makeCtx({ strategy: shortBreakout, candles: { "1h": box(102.5, 110) } }))).toBeNull();
    expect(shortBreakout.evaluate(makeCtx({ strategy: shortBreakout, candles: { "1h": box(100.2, 300) } }))).toBeNull();
  });

  it("ロング保有中に短期チャネルを割ったら flat", () => {
    expect(shortBreakout.evaluate(makeCtx({ strategy: shortBreakout, candles: { "1h": box(97.5, 100) }, position: pos(1) }))?.direction).toBe("flat");
  });
});

// ───────────────────────── 共通 ─────────────────────────

describe("全戦略共通", () => {
  const all = [scalpObi, scalpVwapRevert, scalpMomentumBurst, shortEmaTrend, shortRsiRevert, shortBreakout];

  it("データが空・不足なら null (例外を出さない)", () => {
    for (const s of all) {
      expect(s.evaluate(makeCtx({ strategy: s, candles: {} }))).toBeNull();
      expect(s.evaluate(makeCtx({ strategy: s, candles: { [s.primaryTimeframe]: flat(s.primaryTimeframe, 5) } }))).toBeNull();
    }
  });

  it("標準パラメータ名と paramBounds が揃い、既定値が範囲内", () => {
    for (const s of all) {
      for (const k of ["stopAtr", "tpAtr", "trailAtr", "entryThreshold", "maxHoldBars"]) {
        expect(s.defaultParams[k], `${s.id}.${k}`).toBeTypeOf("number");
        expect(s.paramBounds[k], `${s.id}.${k}`).toBeDefined();
      }
      for (const [k, v] of Object.entries(s.defaultParams)) {
        const b = s.paramBounds[k];
        expect(b, `${s.id}.${k} の bounds`).toBeDefined();
        expect(v).toBeGreaterThanOrEqual(b[0]);
        expect(v).toBeLessThanOrEqual(b[1]);
      }
      expect(s.timeframes).toContain(s.primaryTimeframe);
      expect(s.warmup).toBeGreaterThan(0);
    }
  });
});
