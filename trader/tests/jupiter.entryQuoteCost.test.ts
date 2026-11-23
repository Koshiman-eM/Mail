/**
 * Jupiter: 発注前の見積もりのコスト (entryQuoteCost)。RiskManager の承認後に、承認された数量・向きで swap/v1/quote を取り
 * (約定と同じキャッシュ・枠・4 秒の中止)、そのコストで期待値を確かめ直す。モックの API・仮想時計 (オフライン)
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import { D } from "../src/core/decimal";
import type { AssetClass, Quote, Signal, Strategy, StrategyContext } from "../src/core/types";
import { createJupiterFillPricer, ENTRY_QUOTE_UNAVAILABLE_REASON, jupiterEntryQuoteCost } from "../src/execution/jupiterFill";
import { buildRuntime } from "../src/engine/setup";
import { mulberry32 } from "../src/market/feeds/synthetic";
import { fallbackSettingsFor, jupiterInstrument } from "../src/market/feeds/jupiter";
import { JupiterClient } from "../src/market/jupiter/client";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { JupiterSwapQuoteProvider } from "../src/market/jupiter/quote";
import { MemoryStore } from "../src/storage/memory";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, DEFAULT_MOCK_TOKENS, priceAt, SOL, type MockToken } from "./helpers/jupiterMock";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);

describe("createJupiterFillPricer.entryCost / jupiterEntryQuoteCost", () => {
  const opts = { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 };
  const sol = jupiterInstrument({ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto", liquidityUsd: 50_000_000, source: "fixed" }, opts);
  const bonk = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2_000_000, source: "fixed" }, opts);
  const tokenOf = (s: string) =>
    s === "SOL/USDC" ? { mint: SOL, decimals: 9, liquidityUsd: 50_000_000, fallback: fallbackSettingsFor("crypto") }
    : s === "BONK/USDC" ? { mint: BONK, decimals: 5, liquidityUsd: 2_000_000, fallback: fallbackSettingsFor("meme") }
    : undefined;
  const setup = (o: { impact?: number; fail?: boolean; rate?: number } = {}) => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now, quoteImpactBps: () => o.impact ?? 10, failQuoteFor: () => o.fail === true });
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: o.rate ?? 100, burst: o.rate ? 1 : 100, retries: 0 });
    const pricer = createJupiterFillPricer({ provider: new JupiterSwapQuoteProvider(client), limiter: client.limiter, tokenOf, now: clock.now });
    // 気配は仲値 = モックの価格 (T0)
    const quote = (px: number): Quote => ({ ts: clock.now(), bid: px * 0.999, ask: px * 1.001, last: px });
    const calls = () => mock.calls.filter((c) => c.path === "/swap/v1/quote").length;
    return { clock, mock, client, pricer, quote, calls };
  };

  it("往復コスト = 2 × 見積もりの片道の影響 (仲値基準) + 2 × ネットワーク手数料 / 代金。約定は同じ見積もりをキャッシュから使う (API 1 回)", async () => {
    const { pricer, quote, calls } = setup({ impact: 120 });
    // 気配の仲値はモックの見積もりと同じ時刻の価格にする (見積もりの影響がそのまま仲値基準の片道になる)
    const ref = priceAt(DEFAULT_MOCK_TOKENS.find((t) => t.mint === BONK)!, T0);
    const q = quote(ref);
    const c = await pricer.entryCost(bonk, "buy", D(10_000_000), q);
    expect(c?.source).toBe("quote");
    if (c && c.source !== "unavailable") {
      const notional = 10_000_000 * ref;
      expect(c.notionalUsd).toBeCloseTo(notional, 6);
      expect(c.oneWayBps).toBeGreaterThan(110);
      expect(c.oneWayBps).toBeLessThan(130);
      expect(c.costBps).toBeCloseTo(2 * c.oneWayBps + 2 * (0.02 / notional) * 10_000, 6);
    }
    expect(calls()).toBe(1);
    const fill = await pricer(bonk, "buy", D(10_000_000), q);
    expect(fill && "price" in fill && fill.source).toBe("quote");
    expect(calls()).toBe(1);
    expect(pricer.stats).toMatchObject({ quote: 1, cached: 1 });
    // jupiterEntryQuoteCost: 見積もりが取れたら { costBps, source: "quote" } (2 回目もキャッシュ)
    expect(await jupiterEntryQuoteCost(pricer, bonk, "buy", "10000000", q)).toEqual({ costBps: expect.any(Number), source: "quote" });
    expect(calls()).toBe(1);
  });

  it("見積もりが取れない: meme は見送り (fail closed)、crypto は undefined (承認時のモデルのコストのまま)", async () => {
    const { pricer, quote } = setup({ fail: true });
    expect(await jupiterEntryQuoteCost(pricer, bonk, "buy", "10000000", quote(0.00002))).toEqual({ unavailable: ENTRY_QUOTE_UNAVAILABLE_REASON });
    expect(await jupiterEntryQuoteCost(pricer, sol, "buy", "1", quote(150))).toBeUndefined();
    // 例外・不正な数量・対象外の銘柄も同じ扱い
    const boom = { entryCost: async () => { throw new Error("boom"); } };
    expect(await jupiterEntryQuoteCost(boom, bonk, "buy", "1", quote(0.00002))).toEqual({ unavailable: ENTRY_QUOTE_UNAVAILABLE_REASON });
    expect(await jupiterEntryQuoteCost(boom, sol, "buy", "1", quote(150))).toBeUndefined();
    expect(await jupiterEntryQuoteCost(pricer, bonk, "buy", "abc", quote(0.00002))).toMatchObject({ unavailable: expect.stringContaining(ENTRY_QUOTE_UNAVAILABLE_REASON) });
    expect(await jupiterEntryQuoteCost(pricer, { ...bonk, symbol: "NOPE/USDC" }, "buy", "1", quote(0.00002))).toEqual({ unavailable: ENTRY_QUOTE_UNAVAILABLE_REASON });
  });

  it("枠の待ちが 4 秒を超えるなら見積もりを取らない (レート制限を守る)", async () => {
    const { pricer, quote, calls, client } = setup({ rate: 0.01 });
    await client.limiter.acquire(); // 1 個しかない枠を使い切る (次は 100 秒待ち)
    expect(client.limiter.waitMs()).toBeGreaterThan(4_000);
    expect(await jupiterEntryQuoteCost(pricer, bonk, "buy", "10000000", quote(0.00002))).toEqual({ unavailable: ENTRY_QUOTE_UNAVAILABLE_REASON });
    expect(calls()).toBe(0);
  });
});

/** 常に買う (期待値幅 400bps)。保有中は何もしない */
function fixed(id: string, classes: AssetClass[]): Strategy {
  return {
    id, horizon: "scalp", assetClasses: classes, regimes: ["trend_up", "trend_down", "range", "high_vol", "low_liquidity"],
    primaryTimeframe: "1m", timeframes: ["1m"], warmup: 1, defaultParams: { stopAtr: 1 }, paramBounds: { stopAtr: [0.5, 3] },
    evaluate(ctx: StrategyContext): Signal | null {
      if (ctx.position) return null;
      const px = ctx.market.quote.ask;
      return {
        strategyId: id, horizon: "scalp", symbol: ctx.market.instrument.symbol, direction: "long", confidence: 0.8, expectedEdgeBps: 400,
        entry: { type: "market" }, stopLoss: px * 0.97, maxHoldMs: 20 * MIN, reason: `test ${id}`, features: {},
      };
    },
  };
}

async function jupiterRun(o: { impact?: (mint: string) => number; fail?: (mint: string) => boolean; minutes?: number }) {
  const clock = { t: T0, now() { return this.t; } };
  const now = () => clock.t;
  const sol: MockToken = { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7, amp: 0.004, drift: 0.002 };
  const bonk: MockToken = { mint: BONK, symbol: "BONK", decimals: 5, price: 0.00002, liquidity: 2_000_000, amp: 0.02 };
  const mock = createJupiterMock({
    now, tokens: [sol, bonk], usdJpy: 155.5,
    ...(o.impact ? { quoteImpactBps: o.impact } : {}), ...(o.fail ? { failQuoteFor: o.fail } : {}),
  });
  const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now, ratePerSec: 1000, burst: 1000, retries: 0 });
  const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now, callsPerMinute: 60_000, burst: 1000, retries: 0 });
  const config = loadConfig({ NODE_ENV: "test", DB_PATH: "memory", BASE_CURRENCY: "JPY", JUPITER_TOKENS: "SOL,BONK", JUPITER_DISCOVERY: "false", TARGET_ENTRIES_PER_HOUR: "0" });
  const rt = await buildRuntime(config, {
    clock, store: new MemoryStore(), intelSources: [], ai: null, rng: mulberry32(3),
    jupiter: { client, gecko, fetchImpl: mock.fetchImpl }, strategies: [fixed("t_long", ["crypto", "meme"])],
  });
  for (const end = T0 + (o.minutes ?? 30) * MIN; clock.t <= end; clock.t += 15_000) await rt.engine.advance(clock.t);
  await rt.jupiter!.feed.idle();
  const store = rt.store as MemoryStore;
  const entries = store.listAudit({ type: "engine.entry" });
  const buyQuotes = (mint: string) => mock.calls.filter((c) => c.path === "/swap/v1/quote" && c.query.get("outputMint") === mint).length;
  const rejects = store.listAudit({ type: "risk.reject" }).map((a) => ({ symbol: a.data.symbol as string, reason: String(a.data.reason) }));
  const shadows = [...rt.engine.shadow!.list(), ...store.listShadowTrades()];
  const skips: Record<string, number> = {};
  for (const a of store.listAudit({ type: "engine.skip_summary" })) {
    for (const [k, v] of Object.entries((a.data as { reasons: Record<string, { count: number }> }).reasons)) skips[k] = (skips[k] ?? 0) + v.count;
  }
  return { rt, store, entries, buyQuotes, rejects, shadows, skips };
}

describe("エンジン統合: Jupiter の発注前の見積もりのコスト", () => {
  it("見積もりの影響が大きいミームは発注しない (risk.reject・仮想トレード・見送りの集計)。安い SOL は発注する", async () => {
    const r = await jupiterRun({ impact: (m) => (m === BONK ? 400 : 10) });
    expect(r.entries.some((e) => e.data.symbol === "SOL/USDC")).toBe(true);
    expect(r.entries.some((e) => e.data.symbol === "BONK/USDC")).toBe(false);
    const bonkRej = r.rejects.filter((x) => x.symbol === "BONK/USDC" && x.reason.startsWith("実際の見積もりのコスト"));
    expect(bonkRej.length).toBeGreaterThanOrEqual(1);
    // 見送りの診断 (scripts/diagNoTrades.mjs) が読める形
    const m = /([\d.]+)bps < コスト ([\d.]+)bps/.exec(bonkRej[0].reason);
    expect(m && Number(m[2])).toBeGreaterThan(800);
    expect(Object.keys(r.skips).some((k) => k.startsWith("risk: 実際の見積もりのコスト"))).toBe(true);
    expect(r.shadows.some((s) => s.symbol === "BONK/USDC" && s.reason.startsWith("risk: 実際の見積もりのコスト"))).toBe(true);
    r.rt.close();
  }, 60_000);

  it("見積もりが安ければミームも発注し、entryContext.costBps は見積もりのコスト (モデルより小さい)。約定はキャッシュを使い 1 エントリー 1 回", async () => {
    const r = await jupiterRun({});
    const bonk = r.entries.filter((e) => e.data.symbol === "BONK/USDC");
    expect(bonk.length).toBeGreaterThanOrEqual(1);
    const trades = [...r.store.listTrades({ mode: "paper" }), ...r.rt.engine.journal.list()].filter((t) => t.symbol === "BONK/USDC");
    expect(trades.length).toBeGreaterThanOrEqual(1);
    for (const t of trades) {
      // 見積もりの片道 ≈ 10bps → 往復 ≈ 20bps + 手数料。モデル (meme 30bps 片道) の往復 60bps より小さい
      const model = r.rt.jupiter!.feed.costBpsAt("BONK/USDC", t.qty * t.entryPrice)!;
      expect(t.entryContext.costBps).toBeLessThan(model);
      expect(t.entryContext.costBps).toBeGreaterThan(15);
    }
    expect(bonk.every((e) => String((e.data.notes as string[]).join(" ")).includes("実際の見積もり"))).toBe(true);
    // 買いの見積もりはエントリーの数だけ (約定はエントリー前の見積もりをキャッシュから使う)
    expect(r.buyQuotes(BONK)).toBe(bonk.length);
    expect(r.buyQuotes(SOL)).toBe(r.entries.filter((e) => e.data.symbol === "SOL/USDC").length);
    r.rt.close();
  }, 60_000);

  it("見積もりが取れない: ミームは見送り (見積もりが取れないため見送り)、SOL (主要銘柄) はモデルのコストで発注する", async () => {
    const r = await jupiterRun({ fail: () => true });
    expect(r.entries.some((e) => e.data.symbol === "BONK/USDC")).toBe(false);
    expect(r.rejects.some((x) => x.symbol === "BONK/USDC" && x.reason === ENTRY_QUOTE_UNAVAILABLE_REASON)).toBe(true);
    expect(r.skips[`risk: ${ENTRY_QUOTE_UNAVAILABLE_REASON}`]).toBeGreaterThanOrEqual(1);
    const sol = r.entries.filter((e) => e.data.symbol === "SOL/USDC");
    expect(sol.length).toBeGreaterThanOrEqual(1);
    // 承認時のモデルのコスト (実際の代金のコスト) のまま
    for (const e of sol) expect(String((e.data.notes as string[]).join(" "))).not.toContain("実際の見積もり");
    r.rt.close();
  }, 60_000);
});
