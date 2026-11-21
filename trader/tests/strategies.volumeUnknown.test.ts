import { describe, expect, it } from "vitest";
import type { Candle, Instrument, RegimeFeatures, StrategyContext } from "../src/core/types";
import { volumeUnknown } from "../src/strategies/common";
import { scalpMomentumBurst } from "../src/strategies/scalp";
import { detectBurst } from "../src/strategies/scalpMicro";
import { shortBreakout } from "../src/strategies/short";

const M = 60_000;
const inst: Instrument = {
  symbol: "X/USDC", venue: "jupiter", assetClass: "meme", baseCurrency: "X", quoteCurrency: "USDC", tickSize: 1e-9, lotSize: 1e-6, minQty: 1e-6,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: false,
};
const regime: RegimeFeatures = { label: "trend_up", trend: 0.5, trendStrength: 30, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 5 };

/** 横ばいの後、最後の足で出来高を伴って上抜ける足 */
function breakout(n: number, tfMs: number, known: (i: number) => boolean | undefined): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const px = 100 + (i % 2) * 0.1;
    const c: Candle = last
      ? { ts: i * tfMs, open: 100, high: 103, low: 99.9, close: 102.8, volume: 50 }
      : { ts: i * tfMs, open: px, high: px + 0.2, low: px - 0.2, close: px, volume: 10 };
    const k = known(i);
    if (k !== undefined) c.volumeKnown = k;
    out.push(c);
  }
  return out;
}

const ctxOf = (tf: "1m" | "1h", candles: Candle[], params: Record<string, number>): StrategyContext => ({
  market: { instrument: inst, now: candles.at(-1)!.ts + 3_600_000, quote: { ts: 0, bid: 102.7, ask: 102.9, last: 102.8 }, candles: { [tf]: candles } },
  regime, params,
});

describe("出来高が不明な足 (Jupiter のポーリング) では出来高の条件を満たさない (fail-closed)", () => {
  it("volumeUnknown: volumeKnown === false の足が範囲にあれば true。省略 (ccxt・合成) は分かっている扱い", () => {
    const c = breakout(5, M, (i) => (i === 2 ? false : undefined));
    expect(volumeUnknown(c, 0, 4)).toBe(true);
    expect(volumeUnknown(c, 3, 4)).toBe(false);
    expect(volumeUnknown(breakout(5, M, () => undefined), 0, 4)).toBe(false);
  });

  it("scalp_momentum_burst: 出来高が分かれば入る、窓に不明な足が 1 本でもあれば入らない", () => {
    const p = { ...scalpMomentumBurst.defaultParams };
    expect(scalpMomentumBurst.evaluate(ctxOf("1m", breakout(80, M, () => undefined), p))?.direction).toBe("long");
    expect(scalpMomentumBurst.evaluate(ctxOf("1m", breakout(80, M, () => true), p))?.direction).toBe("long");
    // 不明な足の出来高は 0。平均が下がって倍率が膨らむ (誤ったブレイク) のを防ぐ
    expect(scalpMomentumBurst.evaluate(ctxOf("1m", breakout(80, M, (i) => (i === 75 ? false : true)), p))).toBeNull();
    expect(scalpMomentumBurst.evaluate(ctxOf("1m", breakout(80, M, () => false), p))).toBeNull();
  });

  it("scalp_micro (detectBurst)・short_breakout も同じ", () => {
    const p = { lookbackBars: 10, volBars: 20, volMult: 2, entryThreshold: 0.1 };
    expect(detectBurst(breakout(80, M, () => undefined), p)?.direction).toBe("long");
    expect(detectBurst(breakout(80, M, (i) => (i === 70 ? false : undefined)), p)).toBeNull();
    const sp = { ...shortBreakout.defaultParams };
    const ok = shortBreakout.evaluate(ctxOf("1h", breakout(160, 3_600_000, () => undefined), sp));
    expect(ok?.direction).toBe("long");
    expect(shortBreakout.evaluate(ctxOf("1h", breakout(160, 3_600_000, (i) => (i === 159 ? false : undefined)), sp))).toBeNull();
  });
});
