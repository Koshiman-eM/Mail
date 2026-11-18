import { describe, expect, it } from "vitest";
import type { Candle, Quote } from "../src/core/types";
import { detectRegime, regimeOptionsFor } from "../src/regime/detect";
import { createRng } from "../src/backtest/synthetic";

const M = 60_000;

/** close_i = 100 × exp(slope% × i) × (1 + ノイズ%)。高値・安値は ±range% (価格比なのでボラは一定) */
function series(n: number, slope: number, noise: number, range = 0.3, seed = 7): Candle[] {
  const rng = createRng(seed);
  const out: Candle[] = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 * Math.exp((slope / 100) * i) * (1 + (noise / 100) * rng.normal());
    const r = (close * range) / 100;
    out.push({ ts: i * M, open: prev, high: Math.max(prev, close) + r, low: Math.min(prev, close) - r, close, volume: 100 });
    prev = close;
  }
  return out;
}

const quote = (c: Candle, spreadBps = 2): Quote => ({ ts: c.ts + M, bid: c.close * (1 - spreadBps / 2e4), ask: c.close * (1 + spreadBps / 2e4) });

describe("detectRegime", () => {
  it("明確な上昇トレンドは trend_up (trend > 0)", () => {
    const c = series(200, 0.4, 0.1);
    const r = detectRegime(c, quote(c[c.length - 1]));
    expect(r.label).toBe("trend_up");
    expect(r.trend).toBeGreaterThan(0.3);
    expect(r.trend).toBeLessThanOrEqual(1);
    expect(r.trendStrength).toBeGreaterThan(25);
  });

  it("明確な下降トレンドは trend_down (trend < 0)", () => {
    const c = series(200, -0.4, 0.1);
    const r = detectRegime(c, quote(c[c.length - 1]));
    expect(r.label).toBe("trend_down");
    expect(r.trend).toBeLessThan(-0.3);
    expect(r.trend).toBeGreaterThanOrEqual(-1);
  });

  it("方向感のない値動きは range", () => {
    const c = series(200, 0, 0.05, 0.3);
    const r = detectRegime(c, quote(c[c.length - 1]));
    expect(r.label).toBe("range");
    expect(r.trendStrength).toBeLessThan(25);
    expect(Math.abs(r.trend)).toBeLessThan(0.5);
  });

  it("スプレッドが閾値超なら low_liquidity (最優先)", () => {
    const c = series(200, 0.4, 0.1);
    const r = detectRegime(c, quote(c[c.length - 1], 80));
    expect(r.label).toBe("low_liquidity");
    expect(r.spreadBps).toBeCloseTo(80, 5);
    // ミームの既定閾値 (150bps) なら低流動性ではない
    expect(detectRegime(c, quote(c[c.length - 1], 80), regimeOptionsFor("meme")).label).not.toBe("low_liquidity");
  });

  it("直近のボラティリティが過去分布の 90% 超なら high_vol", () => {
    const c = series(200, 0, 0.05, 0.3);
    const lastClose = c[c.length - 1].close;
    for (let k = 0; k < 4; k++) {
      const ts = (200 + k) * M;
      const close = lastClose + (k % 2 === 0 ? 3 : -3);
      c.push({ ts, open: lastClose, high: lastClose + 4, low: lastClose - 4, close, volume: 500 });
    }
    const r = detectRegime(c, quote(c[c.length - 1]));
    expect(r.volatilityPercentile).toBeGreaterThan(0.9);
    expect(r.label).toBe("high_vol");
    expect(r.volatility).toBeGreaterThan(0);
  });

  it("データ不足でも例外を出さず中立値を返す", () => {
    const r = detectRegime(series(5, 0.1, 0.01), undefined);
    expect(r.label).toBe("range");
    expect(r.trend).toBe(0);
    expect(r.volatilityPercentile).toBe(0.5);
    expect(r.spreadBps).toBe(0);
    expect(detectRegime([], undefined).label).toBe("range");
  });

  it("入力の長さに依らず末尾の判定は同じ (必要な窓だけを使う)", () => {
    const c = series(600, 0.2, 0.2);
    const a = detectRegime(c, undefined);
    const b = detectRegime(c.slice(300), undefined);
    expect(a).toEqual(b);
  });
});
