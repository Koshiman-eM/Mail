import { describe, expect, it } from "vitest";
import { JupiterClient } from "../src/market/jupiter/client";
import { JupiterShapeError } from "../src/market/jupiter/parse";
import {
  buildQuoteRequest, estimateFill, estimateFillFallback, JupiterSwapQuoteProvider, JupiterUltraOrderProvider, parseSwapQuote, quoteAndEstimate,
  type FillContext, type QuoteProvider, type SwapQuote,
} from "../src/market/jupiter/quote";
import { createMockFetch, fakeClock, loadFixture } from "./fixtures/jupiter/mockFetch";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111";

const solCtx: FillContext = { baseMint: SOL, baseDecimals: 9, quoteMint: USDC, quoteDecimals: 6, referencePriceUsd: 150.25 };
const memeCtx: FillContext = { baseMint: MEME, baseDecimals: 5, quoteMint: USDC, quoteDecimals: 6, referencePriceUsd: 0.0000248 };

describe("parseSwapQuote (フィクスチャ)", () => {
  it("swap/v1/quote: 数量は文字列・priceImpactPct は数値に・routePlan の swapInfo を読む", () => {
    const q = parseSwapQuote(loadFixture("swap_quote.json"));
    expect(q).toMatchObject({
      inputMint: SOL, outputMint: USDC, inAmount: "100000000", outAmount: "14980000", otherAmountThreshold: "14905100",
      priceImpactPct: 0.0002, slippageBps: 50, swapMode: "ExactIn", contextSlot: 348004023, provider: "swap/v1/quote",
    });
    expect(q.routePlan).toEqual([
      {
        label: "SyntheticAMM", ammKey: "PooLCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333", inputMint: SOL, outputMint: USDC,
        inAmount: "100000000", outAmount: "14980000", feeAmount: "250000", feeMint: SOL, percent: 100,
      },
    ]);
  });

  it("ultra/v1/order: 数値の inAmount も読む", () => {
    const q = parseSwapQuote(loadFixture("ultra_order.json"), "ultra/v1/order");
    expect(q.inAmount).toBe("100000000");
    expect(q.priceImpactPct).toBe(-0.0001);
    expect(q.routePlan[0].feeAmount).toBe("0");
  });

  it("数量が無い・0・小数なら JupiterShapeError (使えない見積もり)", () => {
    const base = loadFixture<Record<string, unknown>>("swap_quote.json");
    expect(() => parseSwapQuote({ ...base, outAmount: undefined })).toThrow(JupiterShapeError);
    expect(() => parseSwapQuote({ ...base, outAmount: "0" })).toThrow(JupiterShapeError);
    expect(() => parseSwapQuote({ ...base, inAmount: "1.5" })).toThrow(JupiterShapeError);
    expect(() => parseSwapQuote({ ...base, inputMint: 5 })).toThrow(JupiterShapeError);
  });

  it("routePlan が配列でない・priceImpactPct が文字でも例外にしない", () => {
    const base = loadFixture<Record<string, unknown>>("swap_quote.json");
    const q = parseSwapQuote({ ...base, routePlan: null, priceImpactPct: "n/a" });
    expect(q.routePlan).toEqual([]);
    expect(q.priceImpactPct).toBeUndefined();
  });
});

describe("estimateFill (decimal)", () => {
  const q = parseSwapQuote(loadFixture("swap_quote.json"));

  it("sell: 実効価格・参照価格に対する影響 (bps)・手数料 (USD と bps)・最悪の価格", () => {
    const e = estimateFill(q, "sell", 15.025, solCtx);
    expect(e.source).toBe("quote");
    expect(e.scaled).toBe(false);
    expect(e.effectivePrice).toBe(149.8);
    expect(e.priceImpactBps).toBe(29.9501); // (1 - 149.8 / 150.25) × 1e4
    expect(e.qty).toBeCloseTo(15.025 / 149.8, 12);
    expect(e.routeFeesUsd).toBe(0.0375625); // 0.00025 SOL × 150.25
    expect(e.routeFeeBps).toBe(25);
    expect(e.worstPrice).toBe(149.051);
    expect(e.slippageBps).toBe(50);
    expect(e.routeLabels).toEqual(["SyntheticAMM"]);
    expect(e.unpricedFeeLegs).toBe(0);
  });

  const buyQuote: SwapQuote = {
    inputMint: USDC, outputMint: MEME, inAmount: "100000000", outAmount: "400000000000", otherAmountThreshold: "396000000000",
    swapMode: "ExactIn", slippageBps: 100, priceImpactPct: 0.008, provider: "test",
    routePlan: [{ label: "A", feeAmount: "250000", feeMint: USDC }, { label: "B", feeAmount: "5", feeMint: "OtherMint" }],
  };

  it("buy: 100 USDC → 4,000,000 MEME (価格 0.000025)、参照価格 0.0000248 より 80.6452bps 不利", () => {
    const e = estimateFill(buyQuote, "buy", 100, memeCtx);
    expect(e.effectivePrice).toBe(0.000025);
    expect(e.priceImpactBps).toBe(80.6452);
    expect(e.qty).toBe(4_000_000);
    expect(e.routeFeesUsd).toBe(0.25);
    expect(e.unpricedFeeLegs).toBe(1);
    expect(e.worstPrice).toBeCloseTo(100 / 3_960_000, 15);
  });

  it("金額が見積もりと違えば影響を比例で伸縮 (2 倍の金額 → 影響 2 倍、価格 = 参照 × (1 + 影響))", () => {
    const e = estimateFill(buyQuote, "buy", 200, memeCtx);
    expect(e.scaled).toBe(true);
    expect(e.effectivePrice).toBe(0.0000252); // 2 × 0.000025 − 0.0000248
    expect(e.priceImpactBps).toBe(161.2903);
    expect(e.worstPrice).toBeUndefined();
    expect(e.routeFeesUsd).toBe(0.5);
  });

  it("参照価格が無ければ priceImpactPct (割合) を使う。percent の指定も可", () => {
    const ctx = { ...memeCtx, referencePriceUsd: undefined };
    const e = estimateFill(buyQuote, "buy", 100, ctx);
    expect(e.priceImpactBps).toBe(80);
    expect(e.effectivePrice).toBe(0.000025);
    expect(e.notes.join()).toContain("priceImpactPct");
    expect(estimateFill(buyQuote, "buy", 100, { ...ctx, priceImpactUnit: "percent" }).priceImpactBps).toBeCloseTo(0.8, 10);
  });

  it("方向が違う・金額が不正なら例外", () => {
    expect(() => estimateFill(q, "buy", 10, solCtx)).toThrow(/方向/);
    expect(() => estimateFill(q, "sell", 0, solCtx)).toThrow();
    expect(() => estimateFill(q, "sell", Number.NaN, solCtx)).toThrow();
  });

  it("quote トークンの USD 価格を掛ける (USDT 以外の quote でも)", () => {
    const e = estimateFill(buyQuote, "buy", 99, { ...memeCtx, quoteUsd: 0.99, referencePriceUsd: undefined, });
    expect(e.effectivePrice).toBe(0.00002475);
  });
});

describe("estimateFillFallback", () => {
  it("固定の bps + 2 × 金額 / 流動性", () => {
    const e = estimateFillFallback("buy", 1000, 2, 200_000);
    expect(e.source).toBe("fallback");
    expect(e.priceImpactBps).toBe(130);
    expect(e.effectivePrice).toBe(2.026);
    expect(estimateFillFallback("sell", 1000, 2, 200_000).effectivePrice).toBe(1.974);
  });

  it("流動性が不明なら固定の影響、上限で打ち切り", () => {
    expect(estimateFillFallback("buy", 1000, 1, undefined).priceImpactBps).toBe(180);
    expect(estimateFillFallback("buy", 1000, 1, Number.NaN).priceImpactBps).toBe(180);
    const capped = estimateFillFallback("sell", 1_000_000, 1, 10_000);
    expect(capped.priceImpactBps).toBe(1500);
    expect(capped.effectivePrice).toBe(0.85);
  });

  it("設定を変えられる", () => {
    const e = estimateFillFallback("buy", 500, 10, 100_000, { baseBps: 10, impactMult: 0.5, unknownLiquidityBps: 0, maxBps: 100 });
    expect(e.priceImpactBps).toBe(60); // 10 + 0.5 × 2 × 500 / 100000 × 1e4
  });
});

describe("buildQuoteRequest / providers / quoteAndEstimate", () => {
  it("buy は quote トークンの最小単位、sell は参照価格で base の最小単位 (切り捨て)", () => {
    expect(buildQuoteRequest("buy", 12.5, memeCtx, 50)).toEqual({ inputMint: USDC, outputMint: MEME, amount: "12500000", slippageBps: 50 });
    expect(buildQuoteRequest("sell", 100, memeCtx, 50).amount).toBe("403225806451");
    expect(() => buildQuoteRequest("sell", 100, { ...memeCtx, referencePriceUsd: undefined }, 50)).toThrow();
  });

  it("swap/v1/quote のパスとクエリ (taker は付けない)", async () => {
    const clk = fakeClock(0);
    const m = createMockFetch(() => ({ body: loadFixture("swap_quote.json") }), clk.now);
    const client = new JupiterClient({ fetchImpl: m.fetchImpl, now: clk.now, sleep: clk.sleep });
    const q = await new JupiterSwapQuoteProvider(client).getQuote({ inputMint: SOL, outputMint: USDC, amount: "100000000", slippageBps: 50 });
    expect(q.outAmount).toBe("14980000");
    expect(m.calls[0].path).toBe("/swap/v1/quote");
    expect(Object.fromEntries(m.calls[0].query)).toEqual({ inputMint: SOL, outputMint: USDC, amount: "100000000", slippageBps: "50" });
    await new JupiterUltraOrderProvider(client).getQuote({ inputMint: SOL, outputMint: USDC, amount: "100000000", slippageBps: 50 });
    expect(m.calls[1].path).toBe("/ultra/v1/order");
    expect(m.calls[1].query.has("taker")).toBe(false);
    await expect(new JupiterSwapQuoteProvider(client).getQuote({ inputMint: SOL, outputMint: USDC, amount: "1.5", slippageBps: 50 })).rejects.toThrow();
    expect(m.calls).toHaveLength(2);
  });

  it("見積もりが取れなければ代わりのモデル (理由を notes に)", async () => {
    const failing: QuoteProvider = { name: "x", getQuote: async () => { throw new Error("down"); } };
    const e = await quoteAndEstimate(failing, "buy", 1000, { ...memeCtx, referencePriceUsd: 2 }, { liquidityUsd: 200_000 });
    expect(e.source).toBe("fallback");
    expect(e.effectivePrice).toBe(2.026);
    expect(e.notes[0]).toContain("見積もりを取れません");
    const none = await quoteAndEstimate(undefined, "sell", 1000, { ...memeCtx, referencePriceUsd: 2 });
    expect(none.priceImpactBps).toBe(180);
    await expect(quoteAndEstimate(undefined, "buy", 10, { ...memeCtx, referencePriceUsd: undefined })).rejects.toThrow();
  });

  it("見積もりが取れればそれを使う", async () => {
    const p: QuoteProvider = { name: "fake", getQuote: async () => ({ ...parseSwapQuote(loadFixture("swap_quote.json")) }) };
    const e = await quoteAndEstimate(p, "sell", 15.025, solCtx);
    expect(e.source).toBe("quote");
    expect(e.effectivePrice).toBe(149.8);
  });
});
