import { describe, expect, it } from "vitest";
import type { Quote } from "../src/core/types";
import { createFxConverter, FALLBACK_PER_USD, normalizeCurrency, quoteCurrencyOfSymbol } from "../src/engine/fx";

const q = (bid: number, ask: number): Quote => ({ ts: 0, bid, ask });

describe("fx 換算", () => {
  it("口座通貨と同じなら 1、USDT/USDC は USD 扱い", () => {
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: () => undefined });
    expect(fx.toAccount("JPY")).toBe(1);
    expect(normalizeCurrency("usdt")).toBe("USD");
    const usd = createFxConverter({ baseCurrency: "USD", getQuote: () => undefined });
    expect(usd.toAccount("USDT")).toBe(1);
    expect(usd.toAccount("USDC")).toBe(1);
    expect(usd.toAccount("USD")).toBe(1);
  });

  it("監視中の為替ペアの仲値を使う (逆ペアも可)", () => {
    const quotes: Record<string, Quote> = { "USD/JPY": q(155.9, 156.1) };
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: (s) => quotes[s] });
    expect(fx.toAccount("USD")).toBeCloseTo(156, 9);
    expect(fx.toAccount("USDT")).toBeCloseTo(156, 9);
    const usd = createFxConverter({ baseCurrency: "USD", getQuote: (s) => quotes[s] });
    expect(usd.toAccount("JPY")).toBeCloseTo(1 / 156, 12);
    // EUR/USD が無ければ EUR はフォールバック表、JPY は気配
    expect(fx.toAccount("EUR")).toBeCloseTo(156 / FALLBACK_PER_USD.EUR, 9);
  });

  it("気配が無ければフォールバック表 (USD→JPY 150)、未知の通貨は NaN", () => {
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: () => undefined });
    expect(fx.toAccount("USD")).toBe(150);
    expect(fx.toAccount("USDT")).toBe(150);
    expect(fx.toUsd("JPY")).toBeCloseTo(1 / 150, 12);
    expect(Number.isNaN(fx.toAccount("SOL"))).toBe(true);
  });

  it("暗号資産建ては監視中のペアから換算 (BTC/USDT の逆数)", () => {
    const quotes: Record<string, Quote> = { "BTC/USDT": q(59_990, 60_010), "USD/JPY": q(150, 150) };
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: (s) => quotes[s] });
    expect(fx.toUsd("BTC")).toBeCloseTo(60_000, 6);
    expect(fx.toAccount("BTC")).toBeCloseTo(9_000_000, 3);
  });

  it("シンボルからクオート通貨を推定", () => {
    expect(quoteCurrencyOfSymbol("BTC/USDT")).toBe("USDT");
    expect(quoteCurrencyOfSymbol("USD/JPY")).toBe("JPY");
    expect(quoteCurrencyOfSymbol("AAPL")).toBe("USD");
  });
});
