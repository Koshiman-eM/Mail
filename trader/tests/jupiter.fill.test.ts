import { describe, expect, it } from "vitest";
import { D } from "../src/core/decimal";
import type { Quote } from "../src/core/types";
import { createJupiterFillPricer } from "../src/execution/jupiterFill";
import { PaperBroker } from "../src/execution/paper";
import { fallbackSettingsFor, jupiterInstrument } from "../src/market/feeds/jupiter";
import { JupiterClient } from "../src/market/jupiter/client";
import { estimateFillFallback, JupiterSwapQuoteProvider } from "../src/market/jupiter/quote";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, priceAt, SOL } from "./helpers/jupiterMock";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const opts = { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 };
const sol = jupiterInstrument({ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto", liquidityUsd: 50_000_000, source: "fixed" }, opts);
const bonk = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2_000_000, source: "fixed" }, opts);
const tokenOf = (s: string) =>
  s === "SOL/USDC" ? { mint: SOL, decimals: 9, liquidityUsd: 50_000_000, fallback: fallbackSettingsFor("crypto") }
  : s === "BONK/USDC" ? { mint: BONK, decimals: 5, liquidityUsd: 2_000_000, fallback: fallbackSettingsFor("meme") }
  : undefined;

function setup(o: { failQuote?: boolean } = {}) {
  const clock = fakeClock(T0);
  const mock = createJupiterMock({ now: clock.now, ...(o.failQuote ? { failQuote: true } : {}) });
  const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
  const pricer = createJupiterFillPricer({ provider: new JupiterSwapQuoteProvider(client), limiter: client.limiter, tokenOf, now: clock.now });
  const broker = new PaperBroker({
    instruments: [sol, bonk], baseCurrency: "USD", initialEquity: 10_000, clock: { now: clock.now }, marketPricer: pricer, marketOnlyVenues: ["jupiter"],
  });
  const quote = (px: number): Quote => ({ ts: clock.now(), bid: px * 0.999, ask: px * 1.001, last: px });
  return { clock, mock, pricer, broker, quote };
}

const quoteCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === "/swap/v1/quote").length;

describe("paper の Jupiter の約定 (PaperBroker + 見積もり)", () => {
  it("見積もり (swap/v1/quote) の実効価格で約定し、手数料はネットワーク手数料だけ。15 秒・同じ金額の帯はキャッシュ", async () => {
    const { clock, mock, pricer, broker, quote } = setup();
    const px = priceAt({ mint: SOL, symbol: "SOL", decimals: 9, price: 150, amp: 0.004, drift: 0.001 }, T0);
    broker.onQuote("SOL/USDC", quote(px));
    const r = await broker.placeOrder({ clientId: "a", symbol: "SOL/USDC", side: "buy", type: "market", qty: "0.3", strategyId: "t" });
    expect(r.status).toBe("filled");
    const f = r.fills[0];
    expect(f.qty).toBe("0.3");
    // モックの見積もりは 10bps 不利 (= 実効価格 ≈ 価格 × 1.001)。気配 ± 2bps の従来の約定ではない
    expect(f.price / px).toBeCloseTo(1.001, 4);
    expect(f.fee).toBe("0.02");
    expect(pricer.stats).toMatchObject({ quote: 1, cached: 0, fallback: 0 });
    // 同じ向き・同じ金額の帯 (2 倍以内) は 15 秒キャッシュ
    const r2 = await broker.placeOrder({ clientId: "b", symbol: "SOL/USDC", side: "buy", type: "market", qty: "0.25", strategyId: "t" });
    expect(r2.status).toBe("filled");
    expect(quoteCalls(mock.calls)).toBe(1);
    expect(pricer.stats.cached).toBe(1);
    clock.advance(15_000);
    await broker.placeOrder({ clientId: "c", symbol: "SOL/USDC", side: "sell", type: "market", qty: "0.55", reduceOnly: true, strategyId: "t" });
    expect(quoteCalls(mock.calls)).toBe(2);
    const sell = mock.calls.filter((c) => c.path === "/swap/v1/quote").at(-1)!;
    expect(sell.query.get("inputMint")).toBe(SOL);
    // 損益の会計 (decimal): 現金 = 初期 − 買い代金 − 手数料 + 売り代金 − 手数料
    expect(broker.markToMarket().realized).not.toBe(0);
  });

  it("見積もりが取れなければ代わりのモデル (固定 bps + 金額 / 流動性) で約定する", async () => {
    const { broker, pricer, quote } = setup({ failQuote: true });
    const px = 0.00002;
    broker.onQuote("BONK/USDC", quote(px));
    const r = await broker.placeOrder({ clientId: "a", symbol: "BONK/USDC", side: "buy", type: "market", qty: "2500000", strategyId: "t" });
    expect(r.status).toBe("filled");
    const exp = estimateFillFallback("buy", 2_500_000 * px, px, 2_000_000, fallbackSettingsFor("meme")).effectivePrice;
    expect(r.fills[0].price).toBeCloseTo(exp, 12);
    expect(r.fills[0].fee).toBe("0.02");
    expect(pricer.stats.fallback).toBe(1);
  });

  it("Jupiter の銘柄の指値は拒否する (成行のスワップだけ)。capabilities.marketOnlyVenues", async () => {
    const { broker, quote } = setup();
    broker.onQuote("SOL/USDC", quote(150));
    const r = await broker.placeOrder({ clientId: "l", symbol: "SOL/USDC", side: "buy", type: "limit", qty: "0.1", limitPrice: 149, strategyId: "t" });
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/成行/);
    expect(broker.capabilities.marketOnlyVenues).toEqual(["jupiter"]);
  });

  it("固定の手数料は余力の確認にも含める (decimal)", async () => {
    const { broker, quote } = setup({ failQuote: true });
    broker.onQuote("SOL/USDC", quote(100));
    const bal0 = D((await broker.getBalance()).equity);
    const r = await broker.placeOrder({ clientId: "x", symbol: "SOL/USDC", side: "buy", type: "market", qty: "1", strategyId: "t" });
    expect(r.status).toBe("filled");
    const cashAfter = broker.markToMarket().cash;
    expect(D(cashAfter).toNumber()).toBe(bal0.toNumber() - 0.02);
  });
});
