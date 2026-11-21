import { describe, expect, it } from "vitest";
import { JupiterClient } from "../src/market/jupiter/client";
import { GeckoTerminalClient } from "../src/market/jupiter/gecko";
import { fallbackBps, JupiterFeed, jupiterInstrument, JUPITER_VENUE } from "../src/market/feeds/jupiter";
import { MarketHub } from "../src/market/hub";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, DEFAULT_MOCK_TOKENS, MEMEA, priceAt, SOL } from "./helpers/jupiterMock";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);

function setup(o: { gecko?: boolean; failPrices?: () => boolean; omit?: () => string[]; volumeLagMs?: number } = {}) {
  const clock = fakeClock(T0);
  const mock = createJupiterMock({ now: clock.now, ...(o.failPrices ? { failPrices: o.failPrices } : {}), ...(o.omit ? { omitPrices: o.omit } : {}) });
  const client = new JupiterClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, ratePerSec: 100, burst: 100, retries: 0 });
  const gecko = o.gecko
    ? new GeckoTerminalClient({ fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, callsPerMinute: 10, retries: 0 })
    : undefined;
  const warns: string[] = [];
  const feed = new JupiterFeed({
    client, ...(gecko ? { gecko } : {}), now: clock.now, pollMs: 5_000, quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5,
    timeframes: ["1m", "5m", "15m", "1h", "4h"], historyBars: 300, ...(o.volumeLagMs !== undefined ? { volumeLagMs: o.volumeLagMs } : {}),
    onWarn: (m) => warns.push(m),
  });
  feed.addToken({ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto", liquidityUsd: 50_000_000, source: "fixed" });
  feed.addToken({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2_000_000, source: "fixed" });
  return { clock, mock, feed, warns };
}

const priceCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === "/price/v3").length;

describe("jupiterInstrument", () => {
  it("刻み・最小数量は decimals、手数料率 0・ネットワーク手数料は固定額、空売りなし、コストの前提は代わりのモデル", () => {
    const i = jupiterInstrument({ mint: BONK, symbol: "bonk", decimals: 5, assetClass: "meme", liquidityUsd: 1_000_000, source: "fixed" }, { quoteSizeUsd: 50, networkFeeUsd: 0.02, minNotionalUsd: 5 });
    expect(i).toMatchObject({
      symbol: "BONK/USDC", venue: JUPITER_VENUE, assetClass: "meme", baseCurrency: "BONK", quoteCurrency: "USDC",
      lotSize: 1e-5, minQty: 1e-5, tickSize: 1e-11, minNotional: 5, takerFeeRate: 0, makerFeeRate: 0, allowShort: false, fixedFeePerOrder: 0.02,
      meta: { mint: BONK, decimals: 5, source: "fixed" },
    });
    // 30bps + 2 × 50 / 1,000,000 × 1e4 = 31bps (片道) → 全幅 62bps、約定ずれは 0 (スプレッドに含む)
    expect(i.costModel).toEqual({ refNotional: 50, spreadBps: 62, slippageBps: 0 });
    // 主要銘柄 (crypto) は固定の bps が 5
    expect(fallbackBps("crypto", 50, 50_000_000)).toBeCloseTo(5.02, 6);
  });
});

describe("JupiterFeed: 価格のポーリングと気配", () => {
  it("全 mint を 1 回の Price V3 で取り、間隔内は取り直さない。仲値 = 価格、買い・売り気配 = 代わりのモデル", async () => {
    const { clock, mock, feed } = setup();
    const q1 = await feed.fetchQuote("SOL/USDC");
    const q2 = await feed.fetchQuote("BONK/USDC");
    expect(priceCalls(mock.calls)).toBe(1);
    expect(mock.calls[0].query.get("ids")!.split(",").sort()).toEqual([BONK, SOL].sort());
    const p = priceAt(DEFAULT_MOCK_TOKENS[0], T0);
    expect(q1.last).toBeCloseTo(p, 9);
    expect(q1.ask).toBeCloseTo(p * (1 + fallbackBps("crypto", 50, 50_000_000) / 1e4), 9);
    expect(q1.bid).toBeCloseTo(p * (1 - fallbackBps("crypto", 50, 50_000_000) / 1e4), 9);
    expect(q2.ask).toBeGreaterThan(q2.last!);
    clock.advance(4_000);
    await feed.fetchQuote("SOL/USDC");
    expect(priceCalls(mock.calls)).toBe(1);
    clock.advance(1_000);
    await feed.fetchQuote("SOL/USDC");
    expect(priceCalls(mock.calls)).toBe(2);
  });

  it("一部の mint が応答に無い: 例外にせず前の気配 (古い時刻) を返し、status と警告で知らせる。全部失敗は例外", async () => {
    let omit: string[] = [];
    let fail = false;
    const { clock, feed, warns } = setup({ omit: () => omit, failPrices: () => fail });
    const first = await feed.fetchQuote("BONK/USDC");
    omit = [BONK];
    clock.advance(5_000);
    const stale = await feed.fetchQuote("BONK/USDC");
    expect(stale.ts).toBe(first.ts);
    expect((await feed.fetchQuote("SOL/USDC")).ts).toBe(T0 + 5_000);
    expect(feed.status().missing).toEqual([BONK]);
    expect(warns.some((w) => w.includes("一部の銘柄"))).toBe(true);
    fail = true;
    clock.advance(5_000);
    await expect(feed.fetchQuote("SOL/USDC")).rejects.toThrow(/価格の取得に失敗/);
    expect(feed.status().lastPollError).toBeDefined();
  });

  it("1m の足は出来高不明 (volumeKnown: false)。上位足は集約。hub は手元の足を毎回取り直す (空でも組み立てに切り替えない)", async () => {
    const { clock, feed } = setup();
    const hub = new MarketHub({ feeds: [feed], clock: { now: clock.now }, timeframes: ["1m", "5m"], historyLimit: 300 });
    for (const i of await feed.listInstruments()) hub.watch(i, feed);
    for (let k = 0; k < 12 * 11; k++) {
      await hub.poll();
      clock.advance(5_000);
    }
    const v = hub.getView("SOL/USDC", clock.now())!;
    expect(v.candles["1m"]!.length).toBeGreaterThanOrEqual(10);
    expect(v.candles["1m"]!.every((c) => c.volumeKnown === false && c.volume === 0)).toBe(true);
    expect(v.candles["5m"]!.length).toBeGreaterThanOrEqual(1);
    expect(hub.lastError("SOL/USDC")).toBeUndefined();
  });

  it("実行中に銘柄を加える・外す (hub の unwatch と feed の removeToken)", async () => {
    const { feed, mock } = setup();
    const hub = new MarketHub({ feeds: [feed], timeframes: ["1m"] });
    for (const i of await feed.listInstruments()) hub.watch(i, feed);
    const inst = feed.addToken({ mint: MEMEA, symbol: "SOL", decimals: 6, assetClass: "meme", source: "discovered" });
    // シンボルが重なれば mint の先頭 4 文字を付ける
    expect(inst.symbol).toBe("SOL-Meme/USDC");
    hub.watch(inst, feed);
    expect(hub.watched().map((i) => i.symbol)).toContain("SOL-Meme/USDC");
    expect(feed.removeToken(MEMEA)).toBe(true);
    expect(hub.unwatch("SOL-Meme/USDC")).toBe(true);
    expect(hub.watched().map((i) => i.symbol)).not.toContain("SOL-Meme/USDC");
    await hub.poll();
    expect(mock.calls.at(-1)!.query.get("ids")!.split(",")).not.toContain(MEMEA);
  });
});

describe("JupiterFeed: GeckoTerminal の履歴と出来高 (先読みなし)", () => {
  it("裏で backfill: プール → 1m (全銘柄) → 15m / 1h / 4h / 5m。1m の履歴はポーリングの最初の足より前だけ", async () => {
    const { clock, mock, feed } = setup({ gecko: true });
    await feed.fetchQuote("SOL/USDC");
    await feed.idle();
    const gecko = mock.calls.filter((c) => c.url.includes("geckoterminal"));
    const kinds = gecko.map((c) => (c.path.endsWith("/pools") ? "pool" : `${c.path.split("/").pop()}:${c.query.get("aggregate")}`));
    expect(kinds.slice(0, 4)).toEqual(["pool", "pool", "minute:1", "minute:1"]);
    expect(kinds.slice(4, 12)).toEqual(["minute:15", "minute:15", "hour:1", "hour:1", "hour:4", "hour:4", "minute:5", "minute:5"]);
    // その後は出来高の取り込み (1m の新しい側だけ、銘柄を順に)
    expect(kinds.slice(12).every((k) => k === "minute:1")).toBe(true);
    // 1 分あたり 10 回の枠: 12 回の呼び出しで時計が 1 分以上進む (待ちは fake の sleep)
    expect(clock.now() - T0).toBeGreaterThanOrEqual(60_000);
    const c1 = await feed.fetchCandles("SOL/USDC", "1m", 2000);
    expect(c1.length).toBeGreaterThan(900);
    const firstPolled = Math.floor(T0 / MIN) * MIN;
    expect(c1.filter((c) => c.ts < firstPolled).every((c) => c.volumeKnown === true)).toBe(true);
    const h1 = await feed.fetchCandles("SOL/USDC", "1h", 300);
    expect(h1.length).toBe(300);
    const h4 = await feed.fetchCandles("BONK/USDC", "4h", 300);
    expect(h4.length).toBeGreaterThan(250);
    expect(feed.status().geckoCalls).toBe(gecko.length);
  });

  it("出来高は確定から volumeLagMs 以上経った足にだけ入れ、凍結した足の OHLC は変えない (出来高の不明 → 分かったの 1 回だけ)", async () => {
    const { clock, feed } = setup({ gecko: true, volumeLagMs: 3 * MIN });
    // まず 10 分ポーリングしてから backfill (ポーリングの足は出来高不明)
    for (let k = 0; k < 120; k++) {
      await feed.refresh();
      clock.advance(5_000);
    }
    await feed.idle();
    const before = await feed.fetchCandles("SOL/USDC", "1m", 2000);
    const polled = before.filter((c) => c.ts >= Math.floor(T0 / MIN) * MIN);
    expect(polled.length).toBeGreaterThan(0);
    // 時計を進めて出来高の取り込み (1 銘柄 1 回) を回す
    for (let k = 0; k < 60; k++) {
      clock.advance(5_000);
      await feed.refresh();
      await feed.idle();
    }
    const now = clock.now();
    const after = await feed.fetchCandles("SOL/USDC", "1m", 2000);
    const byTs = new Map(after.map((c) => [c.ts, c]));
    for (const c of polled) {
      const a = byTs.get(c.ts)!;
      // OHLC は変わらない (リペイントしない)
      expect([a.open, a.high, a.low, a.close]).toEqual([c.open, c.high, c.low, c.close]);
    }
    const known = after.filter((c) => c.ts >= Math.floor(T0 / MIN) * MIN && c.volumeKnown === true);
    expect(known.length).toBeGreaterThan(0);
    // 出来高が分かったのは確定から 3 分以上経った足だけ。直近の足は不明のまま
    for (const c of known) expect(c.ts + MIN).toBeLessThanOrEqual(now - 3 * MIN);
    expect(after.at(-1)!.volumeKnown).toBe(false);
  });
});
