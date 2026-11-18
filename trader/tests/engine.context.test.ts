import { describe, expect, it } from "vitest";
import type { Candle, Instrument, IntelBias, IntelItem, Quote } from "../src/core/types";
import {
  activeBlackout, intelBiasFor, liquidityUsdFor, normalizeReason, parseDexScreenerUrl, planRegimeTimeframe, selectAutoMemeCandidates, volume24h,
} from "../src/engine/context";

const H = 3_600_000;
const NOW = Date.UTC(2026, 0, 10);

const meme = (venue: string, extra: Partial<Instrument> = {}): Instrument => ({
  symbol: "PEPE/USDT", venue, assetClass: "meme", baseCurrency: "PEPE", quoteCurrency: "USDT", tickSize: 1e-9, lotSize: 1, minQty: 1,
  takerFeeRate: 0.001, makerFeeRate: 0.001, allowShort: false, ...extra,
});
const hourly = (n: number, volume: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - i) * H, open: 1, high: 1, low: 1, close: 1, volume }));
const quote: Quote = { ts: NOW, bid: 0.0000099, ask: 0.0000101 };

describe("ミームの流動性", () => {
  it("CEX: 直近 24 時間の出来高 × 価格を USD 換算した代理指標", () => {
    const view = { now: NOW, quote, candles: { "1h": hourly(48, 1e9) } };
    // 24 本 × 1e9 枚 × 0.00001 USDT × 1 (USDT→USD)
    expect(liquidityUsdFor(meme("ccxt:binance"), view, () => 1)).toBeCloseTo(24 * 1e9 * 0.00001, 3);
    // クオート通貨の USD 換算を掛ける
    expect(liquidityUsdFor(meme("ccxt:binance"), view, () => 0.5)).toBeCloseTo(12 * 1e9 * 0.00001, 3);
  });

  it("CEX: 24 時間に満たない履歴は線形に引き延ばす。1 時間未満・換算不能は不明", () => {
    const six = { now: NOW, quote, candles: { "1h": hourly(6, 1e9) } };
    expect(liquidityUsdFor(meme("ccxt:binance"), six, () => 1)).toBeCloseTo(24 * 1e9 * 0.00001, 3);
    const m1 = Array.from({ length: 30 }, (_, i) => ({ ts: NOW - (30 - i) * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    expect(liquidityUsdFor(meme("ccxt:binance"), { now: NOW, quote, candles: { "1m": m1 } }, () => 1)).toBeUndefined();
    expect(liquidityUsdFor(meme("ccxt:binance"), { now: NOW, quote, candles: {} }, () => 1)).toBeUndefined();
    expect(liquidityUsdFor(meme("ccxt:binance"), six, () => NaN)).toBeUndefined();
  });

  it("DEX: meta.liquidityUsd を使い、無ければ不明 (出来高からは推定しない)", () => {
    const view = { now: NOW, quote, candles: { "1h": hourly(48, 1e9) } };
    expect(liquidityUsdFor(meme("dex:solana", { meta: { liquidityUsd: 750_000 } }), view, () => 1)).toBe(750_000);
    expect(liquidityUsdFor(meme("dex:solana"), view, () => 1)).toBeUndefined();
  });

  it("volume24h は最も長くカバーできる時間足を選ぶ", () => {
    const v = volume24h({ "1h": hourly(3, 10), "1m": Array.from({ length: 300 }, (_, i) => ({ ts: NOW - (300 - i) * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 })) }, NOW);
    expect(v).toEqual({ volume: 300, coveredMs: 300 * 60_000 });
  });
});

describe("情報バイアス", () => {
  const bias = (asset: string, sentiment: number, confidence: number, contrib: Record<string, number>, extra: Partial<IntelBias> = {}): IntelBias => ({
    asset, sentiment, confidence, eventRisk: 0.1, sourceIds: [`id-${asset}`], sourceContrib: contrib, ...extra,
  });
  const btc: Instrument = { ...meme("paper"), symbol: "BTC/USDT", assetClass: "crypto", baseCurrency: "BTC" };

  it("情報の効き具合を掛けてクランプし、情報源の寄与を引き継ぐ", () => {
    const b = intelBiasFor(btc, { BTC: bias("BTC", 0.8, 0.9, { "rss:a": 0.6 }) }, 1.5)!;
    expect(b.sentiment).toBe(1);
    expect(b.confidence).toBe(1);
    expect(b.sourceContrib).toEqual({ "rss:a": 0.6 });
    expect(b.sourceIds).toEqual(["id-BTC"]);
    const half = intelBiasFor(btc, { BTC: bias("BTC", 0.8, 0.6, {}) }, 0.5)!;
    expect(half.sentiment).toBeCloseTo(0.4, 9);
    expect(half.confidence).toBeCloseTo(0.3, 9);
  });

  it("個別が無ければ資産クラスの擬似資産、何も無ければ undefined", () => {
    expect(intelBiasFor(btc, { CRYPTO: bias("CRYPTO", -0.4, 0.5, { fng: -0.3 }) }, 1)?.sentiment).toBeCloseTo(-0.4, 9);
    expect(intelBiasFor(btc, {}, 1)).toBeUndefined();
  });

  it("FX は base − quote。クオート側の寄与は符号を反転し、ブラックアウトを引き継ぐ", () => {
    const fx: Instrument = { ...btc, symbol: "USD/JPY", assetClass: "fx", baseCurrency: "USD", quoteCurrency: "JPY" };
    const b = intelBiasFor(fx, { USD: bias("USD", 0.5, 0.8, { a: 0.5 }), JPY: bias("JPY", -0.2, 0.6, { b: -0.4 }, { blackoutUntil: NOW + H }) }, 1)!;
    expect(b.sentiment).toBeCloseTo(0.7, 9);
    expect(b.sourceContrib).toEqual({ a: 0.5, b: 0.4 });
    expect(b.blackoutUntil).toBe(NOW + H);
  });
});

describe("その他の判定", () => {
  it("ブラックアウト・計画用時間足・見送り理由の正規化", () => {
    const plan = { blackouts: [{ start: NOW - H, end: NOW + H, assetClasses: ["fx" as const], reason: "USD CPI" }] };
    expect(activeBlackout(plan, "fx", NOW)?.reason).toBe("USD CPI");
    expect(activeBlackout(plan, "crypto", NOW)).toBeUndefined();
    expect(activeBlackout(plan, "fx", NOW + 2 * H)).toBeUndefined();
    expect(planRegimeTimeframe(["1m", "5m", "15m", "1h"])).toBe("15m");
    expect(planRegimeTimeframe(["1m", "5m"])).toBe("5m");
    expect(normalizeReason("期待値幅 12.3bps < コスト 4.0bps × 2")).toBe("期待値幅 #bps < コスト #bps × #");
  });

  it("DexScreener の URL とトレンドからの自動監視候補", () => {
    expect(parseDexScreenerUrl("https://dexscreener.com/solana/AbC123")).toEqual({ chainId: "solana", pairAddress: "AbC123" });
    expect(parseDexScreenerUrl("https://example.com/solana/x")).toBeUndefined();
    const item = (id: string, url: string, metrics: Record<string, number>, sym = "WIF"): IntelItem => ({
      id, source: "dexscreener", kind: "trending", title: id, url, publishedAt: NOW, fetchedAt: NOW, assets: [sym, "MEME"], metrics,
    });
    const ok = { liquidityUsd: 900_000, rugRisk: 0.1, pairAgeHours: 100 };
    const items = [
      item("a", "https://dexscreener.com/solana/p1", ok),
      item("b", "https://dexscreener.com/solana/p2", { ...ok, liquidityUsd: 100_000 }), // 流動性不足
      item("c", "https://dexscreener.com/solana/p3", { ...ok, rugRisk: 0.6 }), // ラグ危険
      item("d", "https://dexscreener.com/solana/p4", { ...ok, pairAgeHours: 3 }), // 新しすぎ
      item("e", "https://dexscreener.com/base/p5", { ...ok, liquidityUsd: 2_000_000 }, "BRETT"),
      item("f", "https://dexscreener.com/solana/p6", { liquidityUsd: 900_000, rugRisk: 0.1 }), // 作成時刻不明
      item("g", "https://dexscreener.com/solana/p7", { ...ok, liquidityUsd: 300_000 }, "BONK"),
    ];
    const c = selectAutoMemeCandidates(items, { minLiquidityUsd: 250_000, watchlist: ["BONK"] });
    expect(c.map((x) => x.key)).toEqual(["solana:p7", "base:p5", "solana:p1"]);
    expect(selectAutoMemeCandidates(items, { minLiquidityUsd: 250_000, exclude: new Set(["base:p5"]), max: 1 }).map((x) => x.key)).toEqual(["solana:p1"]);
  });
});
