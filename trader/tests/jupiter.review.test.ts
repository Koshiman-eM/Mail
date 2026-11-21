/** Jupiter の配線のレビュー指摘の修正の試験 (H1・H2・M1・M2・M4・M5・M6・L1・L2・L4・L5) */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import { D } from "../src/core/decimal";
import type { Instrument, Quote, Signal } from "../src/core/types";
import { createFxConverter, fxApproxReason } from "../src/engine/fx";
import { UsdJpyRateSource } from "../src/engine/fxRate";
import { jupiterSettingsFromEnv, jupiterWatchKey, JupiterWatchManager, type PersistedWatch } from "../src/engine/jupiterWatch";
import { syntheticDbSwitchWarning } from "../src/engine/setup";
import { createJupiterFillPricer } from "../src/execution/jupiterFill";
import { fallbackBps, fallbackSettingsFor, JupiterFeed, jupiterInstrument, LIQUIDITY_MAX_AGE_MS } from "../src/market/feeds/jupiter";
import { JupiterClient, TokenBucket } from "../src/market/jupiter/client";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { DEFAULT_FALLBACK_SLIPPAGE, type QuoteProvider, type QuoteRequest, type SwapQuote } from "../src/market/jupiter/quote";
import { RiskManager } from "../src/risk/manager";
import { MemoryStore } from "../src/storage/memory";
import { createMockFetch, fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, MEMEA, MEMEB, SOL, USDC, type MockToken } from "./helpers/jupiterMock";

const DEFAULT_RISK = loadConfig({}).risk;

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const MIN = 60_000;
const H = 3_600_000;

// ───────── H1: 統一シンボルの保存 ─────────

const trumpA: MockToken = { mint: MEMEA, symbol: "TRUMP", decimals: 6, price: 10, liquidity: 5e6 };
const trumpB: MockToken = { mint: MEMEB, symbol: "TRUMP", decimals: 6, price: 0.01, liquidity: 5e6 };

/** 同じ store で「再起動」(新しい feed・manager) できる環境 */
function world(trending: () => MockToken[]) {
  const clock = fakeClock(T0);
  const mock = createJupiterMock({ now: clock.now, trending, tokens: [{ mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7 }] });
  const store = new MemoryStore();
  const held = new Set<string>();
  const settings = jupiterSettingsFromEnv(loadConfig({}).env);
  const boot = () => {
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
    const feed = new JupiterFeed({ client, now: clock.now });
    const fixed = [{ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto" as const, source: "fixed" as const }];
    const w = new JupiterWatchManager({
      client, feed, store, mode: "paper", settings, fixed, now: clock.now,
      onAdd: () => undefined, onRemove: (s) => !held.has(s), keepSymbols: () => [...held],
    });
    return { feed, w };
  };
  return { clock, store, held, boot };
}

describe("H1: 統一シンボルを kv に保存し、再起動で保有中の建玉のシンボル → mint を変えない", () => {
  it("TRUMP が 2 つ: A を保有、B の方が最近合格 → 再起動しても TRUMP/USDC は A のまま", async () => {
    let trending = [trumpA];
    const { clock, store, held, boot } = world(() => trending);
    const r1 = boot();
    r1.w.restore();
    await r1.w.run();
    expect(r1.feed.instrumentOf(MEMEA)?.symbol).toBe("TRUMP/USDC");
    held.add("TRUMP/USDC");
    clock.advance(10 * MIN);
    trending = [trumpB, trumpA];
    await r1.w.run();
    expect(r1.feed.instrumentOf(MEMEB)?.symbol).toBe("TRUMP-Meme/USDC");
    clock.advance(10 * MIN);
    trending = [trumpB];
    await r1.w.run();
    const saved = store.kvGet<PersistedWatch>(jupiterWatchKey("paper"))!.entries;
    expect(saved.find((e) => e.mint === MEMEA)?.instSymbol).toBe("TRUMP/USDC");
    expect(saved.find((e) => e.mint === MEMEB)?.instSymbol).toBe("TRUMP-Meme/USDC");
    // 再起動 (B の lastSeenAt が新しく、一覧では先に並ぶ)
    const r2 = boot();
    r2.w.restore();
    expect(r2.feed.mintOf("TRUMP/USDC")).toBe(MEMEA);
    expect(r2.feed.mintOf("TRUMP-Meme/USDC")).toBe(MEMEB);
  });

  it("B (TRUMP-xxxx/USDC) を保有、A は期限切れで外れた → 再起動しても B は TRUMP-xxxx/USDC (TRUMP/USDC を奪わない)", async () => {
    let trending = [trumpA, trumpB];
    const { clock, store, held, boot } = world(() => trending);
    const r1 = boot();
    r1.w.restore();
    await r1.w.run();
    const bSym = r1.feed.instrumentOf(MEMEB)!.symbol;
    expect(bSym).toBe("TRUMP-Meme/USDC");
    held.add(bSym);
    trending = [trumpB];
    clock.advance(7 * H);
    const rr = await r1.w.run();
    expect(rr?.removed).toEqual(["TRUMP/USDC"]);
    const r2 = boot();
    r2.w.restore();
    expect(r2.feed.mintOf("TRUMP-Meme/USDC")).toBe(MEMEB);
    expect(r2.feed.mintOf("TRUMP/USDC")).toBeUndefined();
    // kv が無くても paper のスナップショットの統一シンボル (extraKeep.instSymbol) で同じシンボルにする
    store.kvSet(jupiterWatchKey("paper"), { updatedAt: 0, entries: [] });
    const r3 = boot();
    r3.w.restore([{ mint: MEMEB, symbol: "TRUMP", decimals: 6, assetClass: "meme", source: "discovered", instSymbol: "TRUMP-Meme/USDC" }]);
    expect(r3.feed.mintOf("TRUMP-Meme/USDC")).toBe(MEMEB);
  });

  it("addToken の強制シンボル: 空いていれば使い、使われていれば通常の規則", () => {
    const client = new JupiterClient({ ratePerSec: 100 });
    const feed = new JupiterFeed({ client });
    expect(feed.addToken({ mint: MEMEB, symbol: "TRUMP", decimals: 6, assetClass: "meme", source: "discovered" }, "TRUMP-Meme/USDC").symbol).toBe("TRUMP-Meme/USDC");
    expect(feed.addToken({ mint: MEMEA, symbol: "TRUMP", decimals: 6, assetClass: "meme", source: "discovered" }, "TRUMP-Meme/USDC").symbol).toBe("TRUMP/USDC");
  });
});

// ───────── M4: 選別に落ちた銘柄の停止の保存 ─────────

describe("M4: 選別に落ちた停止は kv に保存し、再起動・情報なしでも止め続ける。監査は理由の種類が変わったときだけ", () => {
  it("流動性が下がる → 停止 (値が変わっても監査は 1 回)。再起動後も止める。情報が無くても止める。再合格で解除", async () => {
    let a: MockToken = { ...trumpA, liquidity: 5e6 };
    let trending: MockToken[] = [a];
    const { clock, store, held, boot } = world(() => trending);
    const r1 = boot();
    r1.w.restore();
    await r1.w.run();
    held.add("TRUMP/USDC");
    a = { ...trumpA, liquidity: 100_000 };
    trending = [a];
    clock.advance(MIN);
    await r1.w.run();
    a = { ...trumpA, liquidity: 90_000 };
    trending = [a];
    clock.advance(MIN);
    await r1.w.run();
    expect(r1.feed.entryBlock("TRUMP/USDC")).toMatch(/流動性不足/);
    expect(store.listAudit({ type: "jupiter.watch_screen_failed" })).toHaveLength(1);
    expect(store.kvGet<PersistedWatch>(jupiterWatchKey("paper"))!.entries.find((e) => e.mint === MEMEA)?.screenBlock?.codes).toEqual(["liquidity"]);
    // 再起動: トークン情報 (feed.tokenInfo) が無く、上位の一覧にも無い → 前回の判定のまま止める
    trending = [];
    const r2 = boot();
    r2.w.restore();
    expect(r2.feed.entryBlock("TRUMP/USDC")).toMatch(/流動性不足/);
    clock.advance(MIN);
    await r2.w.run();
    expect(r2.feed.entryBlock("TRUMP/USDC")).toMatch(/流動性不足/);
    // 理由の種類が変わる (保有者数も不足) → 監査ログ
    trending = [{ ...trumpA, liquidity: 90_000, holderCount: 10 }];
    clock.advance(MIN);
    await r2.w.run();
    expect(store.listAudit({ type: "jupiter.watch_screen_failed" })).toHaveLength(2);
    trending = [{ ...trumpA }];
    clock.advance(MIN);
    await r2.w.run();
    expect(r2.feed.entryBlock("TRUMP/USDC")).toBeUndefined();
    expect(store.kvGet<PersistedWatch>(jupiterWatchKey("paper"))!.entries.find((e) => e.mint === MEMEA)?.screenBlock).toBeUndefined();
  });
});

// ───────── M5: 流動性の古さ ─────────

describe("M5: 3 時間より古い流動性は不明 (ミームは拒否・気配は流動性不明の bps)", () => {
  it("liquidityUsd と気配のスプレッド", async () => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now });
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100 });
    const feed = new JupiterFeed({ client, now: clock.now, pollMs: 5_000 });
    feed.addToken({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" });
    const fresh = await feed.fetchQuote("BONK/USDC");
    expect(feed.liquidityUsd("BONK/USDC")).toBe(2e6);
    expect((fresh.ask / fresh.last! - 1) * 1e4).toBeCloseTo(fallbackBps("meme", 50, 2e6), 6);
    clock.advance(LIQUIDITY_MAX_AGE_MS + 1);
    const stale = await feed.fetchQuote("BONK/USDC");
    expect(feed.liquidityUsd("BONK/USDC")).toBeUndefined();
    expect((stale.ask / stale.last! - 1) * 1e4).toBeCloseTo(DEFAULT_FALLBACK_SLIPPAGE.baseBps + DEFAULT_FALLBACK_SLIPPAGE.unknownLiquidityBps, 6);
    expect(feed.tokenOf("BONK/USDC")?.liquidityUsd).toBeUndefined();
    // 取り直せば新しくなる
    await feed.refreshTokenInfo();
    expect(feed.liquidityUsd("BONK/USDC")).toBe(2e6);
  });
});

// ───────── M1・M6: GeckoTerminal の再試行とキャッシュ ─────────

describe("M1: GeckoTerminal の失敗は 5 分 → 15 分 → 60 分の後に取り直す (成功するまで取得済みにしない)", () => {
  it("プールの検索と履歴の失敗", async () => {
    const clock = fakeClock(T0);
    let failPools = true;
    let failOhlcv = true;
    const base = createJupiterMock({ now: clock.now });
    const mock = createMockFetch(async (call, i) => {
      if (call.path.endsWith("/pools") && failPools) return { status: 500, body: {} };
      if (call.path.includes("/ohlcv/") && failOhlcv) return { status: 500, body: {} };
      const r = await base.fetchImpl(call.url);
      void i;
      return { status: r.status, text: await r.text() };
    }, clock.now);
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
    const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 600, burst: 100, retries: 0 });
    const feed = new JupiterFeed({ client, gecko, now: clock.now, timeframes: ["1m"] });
    feed.addToken({ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto", source: "fixed" });
    const poolCalls = () => mock.calls.filter((c) => c.path.endsWith("/pools")).length;
    await feed.refresh();
    await feed.idle();
    expect(poolCalls()).toBe(1);
    clock.advance(4 * MIN);
    await feed.refresh(true);
    await feed.idle();
    expect(poolCalls()).toBe(1);
    clock.advance(MIN + 1);
    await feed.refresh(true);
    await feed.idle();
    expect(poolCalls()).toBe(2);
    // 2 回目の失敗の後は 15 分
    clock.advance(14 * MIN);
    await feed.refresh(true);
    await feed.idle();
    expect(poolCalls()).toBe(2);
    failPools = false;
    clock.advance(MIN + 1);
    await feed.refresh(true);
    await feed.idle();
    expect(poolCalls()).toBe(3);
    expect(feed.status().tokens[0].pool).toBeTypeOf("string");
    // 履歴の失敗: 取得済みにしない → 5 分後に取り直す
    expect(feed.status().tokens[0].backfilled).toEqual([]);
    const ohlcvCalls = () => mock.calls.filter((c) => c.path.includes("/ohlcv/")).length;
    const n = ohlcvCalls();
    expect(n).toBe(1);
    failOhlcv = false;
    clock.advance(5 * MIN + 1);
    await feed.refresh(true);
    await feed.idle();
    expect(feed.status().tokens[0].backfilled).toEqual(["1m"]);
  });
});

describe("M6: 監視から外した銘柄の GeckoTerminal のキャッシュを捨て、件数に上限を付ける", () => {
  it("forgetToken と上限", async () => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now, tokens: [{ mint: BONK, symbol: "BONK", decimals: 5, price: 0.00002, liquidity: 2e6 }, { mint: SOL, symbol: "SOL", decimals: 9, price: 150, liquidity: 5e7 }] });
    const gecko = new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 600, burst: 100, maxOhlcvEntries: 2, maxPoolEntries: 1 });
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100 });
    const feed = new JupiterFeed({ client, gecko, now: clock.now, timeframes: ["1m"] });
    feed.addToken({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", source: "fixed" });
    await feed.refresh();
    await feed.idle();
    expect(gecko.cacheSize()).toEqual({ pools: 1, ohlcv: 1 });
    feed.removeToken(BONK);
    expect(gecko.cacheSize()).toEqual({ pools: 0, ohlcv: 0 });
    // 上限: プールの検索 1 件まで
    await gecko.topPools(BONK);
    await gecko.topPools(SOL);
    expect(gecko.cacheSize().pools).toBe(1);
  });
});

// ───────── M2: 実際の代金でのコスト ─────────

describe("M2: RiskManager はサイズを決めた後、実際の代金のコストで期待値を確かめる (Jupiter)", () => {
  const inst = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 300_000, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
  const limits = { ...DEFAULT_RISK, riskPerTrade: 0.01, maxPositionPct: 1, minEdgeToCostRatio: 2, memeMinLiquidityUsd: 1, maxExposureByClass: { crypto: 1, meme: 1 } };
  const q: Quote = { ts: T0, bid: 0.99, ask: 1.01, last: 1 };
  const sig: Signal = {
    strategyId: "s", horizon: "scalp", symbol: inst.symbol, direction: "long", confidence: 1, expectedEdgeBps: 250, entry: { type: "market" },
    stopLoss: 0.95, maxHoldMs: MIN, reason: "", features: {},
  };
  const base = { signal: sig, instrument: inst, quote: q, equity: 100_000, available: 100_000, positions: [], riskMultiplier: 1, now: T0, liquidityUsd: 1e9 };
  const feedCost = (n: number) => 2 * fallbackBps("meme", n, 300_000) + 2 * (0.02 / n) * 1e4;

  it("気配のコストでは通るが、大きな代金では価格影響で落ちる。costBpsAt が無ければ従来どおり", () => {
    const rm = new RiskManager(limits);
    // 気配のコスト (代表的な代金 $50): 2 × 1% + ネットワーク手数料 2 × 4bps = 208bps → 250 ≥ 2 × 208 ではない…ので比率 1.1 にする
    const rm2 = new RiskManager({ ...limits, minEdgeToCostRatio: 1.1 });
    const plain = rm2.evaluateEntry(base);
    expect(plain.ok).toBe(true);
    expect(plain.ok && plain.costBps).toBeUndefined();
    // サイズ (100,000 × 1% / 0.06 ≈ 16,667 単位 ≈ $16,833) のコスト: 価格影響 2 × 2 × 16,833 / 300,000 ≈ 2,244bps → 拒否
    const sized = rm2.evaluateEntry({ ...base, costBpsAt: feedCost });
    expect(sized).toMatchObject({ ok: false, reason: expect.stringContaining("でのコスト") });
    // 小さなサイズ (リスク倍率で縮める) なら通り、実際の代金のコストを返す
    const small = rm2.evaluateEntry({ ...base, riskMultiplier: 0.002, costBpsAt: feedCost });
    expect(small.ok).toBe(true);
    if (small.ok) {
      const n = Number(small.qty) * 1.01;
      expect(small.costBps).toBeCloseTo(feedCost(n), 6);
    }
    void rm;
  });

  it("feed.costBpsAt: 固定手数料の率は 手数料 / 代金、価格影響は代金と (新しい) 流動性", () => {
    const client = new JupiterClient({ ratePerSec: 100 });
    const feed = new JupiterFeed({ client, quoteSizeUsd: 50, networkFeeUsd: 0.02 });
    feed.addToken({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" });
    expect(feed.costBpsAt("BONK/USDC", 500)).toBeCloseTo(2 * (30 + (2 * 500) / 2e6 * 1e4) + 2 * (0.02 / 500) * 1e4, 9);
    expect(feed.costBpsAt("BONK/USDC", 0)).toBeUndefined();
  });
});

// ───────── L1・L2: 見積もりのキャッシュと中止・古い気配 ─────────

class SlowProvider implements QuoteProvider {
  readonly name = "slow";
  calls = 0;
  aborted = 0;
  constructor(private readonly o: { delayMs?: number; ref: () => number }) {}
  getQuote(req: QuoteRequest, opts: { signal?: AbortSignal } = {}): Promise<SwapQuote> {
    this.calls++;
    const px = this.o.ref();
    const buy = req.inputMint === USDC;
    const outAmount = buy ? Math.floor((Number(req.amount) / 1e6 / (px * 1.001)) * 1e5) : Math.floor((Number(req.amount) / 1e5) * px * 0.999 * 1e6);
    const q: SwapQuote = { inputMint: req.inputMint, outputMint: req.outputMint, inAmount: req.amount, outAmount: String(outAmount), routePlan: [], provider: this.name };
    if (!this.o.delayMs) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => res(q), this.o.delayMs);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        this.aborted++;
        rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  }
}

describe("L1・L2: 見積もりのキャッシュ・中止・古い気配", () => {
  const inst: Instrument = jupiterInstrument({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
  const tokenOf = () => ({ mint: BONK, decimals: 5, liquidityUsd: 2e6, fallback: fallbackSettingsFor("meme") });

  it("キャッシュは参照価格が 0.3% 以内のときだけ。使うときは影響 (bps) を今の参照価格に掛ける", async () => {
    let ref = 1;
    let t = T0;
    const p = new SlowProvider({ ref: () => ref });
    const pricer = createJupiterFillPricer({ provider: p, tokenOf, now: () => t });
    const q = (): Quote => ({ ts: t, bid: ref * 0.99, ask: ref * 1.01, last: ref });
    const a = (await pricer(inst, "buy", D(40), q())) as { price: number };
    expect(a.price / ref).toBeCloseTo(1.001, 4);
    ref = 1.002; // 0.2%
    const b = (await pricer(inst, "buy", D(40), q())) as { price: number };
    expect(p.calls).toBe(1);
    // 古い見積もりの絶対価格 (1.001) ではなく、今の参照価格 × (1 + 10bps)
    expect(b.price).toBeCloseTo(1.002 * 1.001, 6);
    ref = 1.005; // 取得時から 0.5%
    await pricer(inst, "buy", D(40), q());
    expect(p.calls).toBe(2);
  });

  it("4 秒で返らない見積もりは中止して代わりのモデル。枠の待ち (待ちの列を含む) が長ければ見積もりを取らない", async () => {
    const p = new SlowProvider({ delayMs: 200, ref: () => 1 });
    const pricer = createJupiterFillPricer({ provider: p, tokenOf, now: () => T0, timeoutMs: 20 });
    const r = (await pricer(inst, "buy", D(40), { ts: T0, bid: 0.99, ask: 1.01, last: 1 })) as { price: number; source: string };
    expect(r.source).toBe("fallback");
    expect(p.aborted).toBe(1);
    expect(pricer.stats.aborted).toBe(1);
    const busy = createJupiterFillPricer({ provider: p, tokenOf, now: () => T0, limiter: { waitMs: () => 10_000 } });
    await busy(inst, "sell", D(40), { ts: T0, bid: 0.99, ask: 1.01, last: 1 });
    expect(p.calls).toBe(1);
    // TokenBucket.waitMs は待ちの列を含む
    const clk = fakeClock(0);
    const tb = new TokenBucket({ ratePerSec: 1, now: clk.now, sleep: () => new Promise(() => undefined) });
    expect(tb.waitMs()).toBe(0);
    void tb.acquire();
    void tb.acquire();
    void tb.acquire();
    await Promise.resolve();
    expect(tb.waitMs()).toBe(3000);
  });

  it("気配が古い (maxQuoteAgeMs 超) ときは代わりのモデルで約定させず拒否する (決済は次のティックで再試行)", async () => {
    const pricer = createJupiterFillPricer({ tokenOf, now: () => T0 + 60_000, maxQuoteAgeMs: 30_000 });
    const r = await pricer(inst, "sell", D(40), { ts: T0, bid: 0.99, ask: 1.01, last: 1 });
    expect(r).toMatchObject({ reject: expect.stringContaining("気配が古い") });
    expect(pricer.stats.staleRejected).toBe(1);
  });

  it("JupiterClient の中止: 枠を待つ間に中止されたら送らない。見積もりの再試行は 1 回まで", async () => {
    const clock = fakeClock(T0);
    let n = 0;
    const mock = createMockFetch(() => {
      n++;
      return { status: 503, body: {} };
    }, clock.now);
    const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 3 });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(client.getJson("/swap/v1/quote", { inputMint: SOL, outputMint: USDC, amount: "1", slippageBps: 50 }, { signal: ctrl.signal })).rejects.toThrow();
    expect(n).toBe(0);
    const { JupiterSwapQuoteProvider } = await import("../src/market/jupiter/quote");
    await expect(new JupiterSwapQuoteProvider(client).getQuote({ inputMint: SOL, outputMint: USDC, amount: "100", slippageBps: 50 })).rejects.toThrow();
    expect(n).toBe(2);
  });
});

// ───────── L4: USD/JPY の気配の時刻 ─────────

describe("L4: 日次のレートの気配の時刻はレートの日付 (live では常に古い。paper の換算は同じ)", () => {
  it("ts = 日付の 00:00 UTC", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 20, 15, 0, 0));
    const mock = createMockFetch(() => ({ body: { date: "2026-11-20", rates: { JPY: 155.5 } } }), clock.now);
    const src = new UsdJpyRateSource({ fetchImpl: mock.fetchImpl, now: clock.now });
    await src.refresh();
    expect(src.quote("USD/JPY")?.ts).toBe(Date.UTC(2026, 10, 20));
    const fx = createFxConverter({ baseCurrency: "JPY", getQuote: (s) => src.quote(s) });
    expect(fx.toAccount("USDC")).toBe(155.5);
    // 取得した直後でも live の判定は古い
    expect(fxApproxReason(fx, "USDC", "JPY", clock.now())).toMatch(/古い/);
  });
});

// ───────── L5・H2: 設定 ─────────

describe("L5・H2: 設定", () => {
  it("JUPITER_POLL_MS は気配の古さの上限 (30 秒) の半分以下", () => {
    expect(loadConfig({ JUPITER_POLL_MS: "15000" }).env.JUPITER_POLL_MS).toBe(15_000);
    expect(() => loadConfig({ JUPITER_POLL_MS: "20000" })).toThrow(/30 秒の半分以下/);
  });

  it("VENUES が未設定で <DB>-synthetic.db があれば、どの DB を使うかと VENUES=synthetic で戻せることを警告 (移さない)", () => {
    const cfg = loadConfig({ DB_PATH: "/var/lib/trader/trader.db" });
    const exists = (p: string) => p === "/var/lib/trader/trader-synthetic.db";
    const w = syntheticDbSwitchWarning(cfg, {}, exists);
    expect(w).toContain("/var/lib/trader/trader.db");
    expect(w).toContain("/var/lib/trader/trader-synthetic.db");
    expect(w).toContain("VENUES=synthetic");
    expect(syntheticDbSwitchWarning(cfg, { VENUES: "jupiter" }, exists)).toBeUndefined();
    expect(syntheticDbSwitchWarning(cfg, {}, () => false)).toBeUndefined();
    expect(syntheticDbSwitchWarning(loadConfig({ DB_PATH: "memory" }), {}, () => true)).toBeUndefined();
  });
});
