/**
 * Jupiter の価格の取得間隔 (既定 2.5 秒) と API の上限 (キーなし 0.5 回/秒・キーあり 1 回/秒) の整合、
 * status の「板が必要: Jupiter では動きません」の注記 (すべてオフライン)
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/appConfig";
import { strategyStatusLines } from "../src/cli";
import { formatJupiterSettings, jupiterSettingsFromEnv } from "../src/engine/jupiterWatch";
import { JupiterFeed } from "../src/market/feeds/jupiter";
import { JupiterClient } from "../src/market/jupiter/client";
import { effectivePricePollMs, minPricePollMs, PRICE_POLL_RATE_SHARE } from "../src/market/jupiter/price";
import { fakeClock } from "./fixtures/jupiter/mockFetch";
import { BONK, createJupiterMock, SOL } from "./helpers/jupiterMock";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const priceCalls = (calls: { path: string }[]) => calls.filter((c) => c.path === "/price/v3").length;

describe("価格の取得間隔の下限 (API の上限から導く)", () => {
  it("下限 = 50 件ごとの呼び出し数 / (上限 × 0.8)。キーなし 1 回 = 2500、2 回 = 5000、キーあり 1 回 = 1250", () => {
    expect(PRICE_POLL_RATE_SHARE).toBe(0.8);
    expect(minPricePollMs(0.5, 1)).toBe(2500);
    expect(minPricePollMs(0.5, 50)).toBe(2500);
    expect(minPricePollMs(0.5, 51)).toBe(5000);
    expect(minPricePollMs(0.5, 0)).toBe(2500);
    expect(minPricePollMs(1, 1)).toBe(1250);
    expect(minPricePollMs(1, 101)).toBe(3750);
    // 上限が不正なら下限なし (呼び出し側の指定を優先)
    expect(minPricePollMs(0, 1)).toBe(0);
    expect(minPricePollMs(Number.NaN, 1)).toBe(0);
  });

  it("実際の間隔 = max(指定, 下限)", () => {
    expect(effectivePricePollMs(2500, 0.5, 1)).toBe(2500);
    expect(effectivePricePollMs(1000, 0.5, 1)).toBe(2500);
    expect(effectivePricePollMs(15_000, 0.5, 1)).toBe(15_000);
    expect(effectivePricePollMs(2500, 1, 1)).toBe(2500);
    expect(effectivePricePollMs(1000, 1, 1)).toBe(1250);
    expect(effectivePricePollMs(2500, 0.5, 51)).toBe(5000);
  });
});

describe("JupiterFeed の価格の取得間隔", () => {
  const mkFeed = (o: { apiKey?: string; rps?: number; pollMs?: number }) => {
    const clock = fakeClock(T0);
    const mock = createJupiterMock({ now: clock.now });
    const client = new JupiterClient({
      fetchImpl: mock.fetchImpl, now: clock.now, sleep: clock.sleep, retries: 0,
      ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.rps !== undefined ? { ratePerSec: o.rps } : {}),
    });
    const feed = new JupiterFeed({ client, now: clock.now, ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}) });
    feed.addToken({ mint: SOL, symbol: "SOL", decimals: 9, assetClass: "crypto", liquidityUsd: 5e7, source: "fixed" });
    feed.addToken({ mint: BONK, symbol: "BONK", decimals: 5, assetClass: "meme", liquidityUsd: 2e6, source: "fixed" });
    return { clock, mock, feed, client };
  };

  it("既定は 2.5 秒 (環境変数の既定も 2500)", () => {
    expect(loadConfig({}).env.JUPITER_POLL_MS).toBe(2500);
    expect(jupiterSettingsFromEnv(loadConfig({}).env).pollMs).toBe(2500);
    const { feed } = mkFeed({});
    expect(feed.pollMs).toBe(2500);
    expect(feed.effectivePollMs()).toBe(2500);
  });

  it("キーなし (0.5 回/秒): 1 秒と指定しても 2.5 秒より詰めない。51 銘柄以上は 5 秒", () => {
    const { feed, client } = mkFeed({ pollMs: 1000 });
    expect(client.limiter.ratePerSec).toBe(0.5);
    expect(feed.pollMs).toBe(1000);
    expect(feed.effectivePollMs()).toBe(2500);
    for (let i = 0; i < 49; i++) feed.addToken({ mint: `Mint${String(i).padStart(40, "0")}`, symbol: `T${i}`, decimals: 6, assetClass: "meme", source: "discovered" });
    expect(feed.mints()).toHaveLength(51);
    expect(feed.effectivePollMs()).toBe(5000);
  });

  it("キーあり (1 回/秒): 1 秒と指定すれば 1.25 秒まで、JUPITER_RPS で上限を変えればそれに従う", () => {
    expect(mkFeed({ apiKey: "k", pollMs: 1000 }).feed.effectivePollMs()).toBe(1250);
    expect(mkFeed({ apiKey: "k" }).feed.effectivePollMs()).toBe(2500);
    expect(mkFeed({ rps: 0.2, pollMs: 2500 }).feed.effectivePollMs()).toBe(6250);
    expect(mkFeed({ rps: 10, pollMs: 1000 }).feed.effectivePollMs()).toBe(1000);
  });

  it("キーなしで 1 秒指定でも、価格の API は 2.5 秒に 1 回 (0.4 回/秒 <= 0.5 回/秒) を超えない", async () => {
    const { clock, mock, feed } = mkFeed({ pollMs: 1000 });
    await feed.fetchQuote("SOL/USDC");
    expect(priceCalls(mock.calls)).toBe(1);
    clock.advance(1_000);
    await feed.fetchQuote("SOL/USDC");
    clock.advance(1_000);
    await feed.fetchQuote("SOL/USDC");
    expect(priceCalls(mock.calls)).toBe(1);
    clock.advance(500);
    await feed.fetchQuote("SOL/USDC");
    expect(priceCalls(mock.calls)).toBe(2);
  });

  it("既定 (2.5 秒) では 2.5 秒ごとに 1 回だけ取る (50 銘柄まで = 1 回の呼び出し)", async () => {
    const { clock, mock, feed } = mkFeed({});
    await feed.fetchQuote("SOL/USDC");
    clock.advance(2_400);
    await feed.fetchQuote("BONK/USDC");
    expect(priceCalls(mock.calls)).toBe(1);
    clock.advance(100);
    await feed.fetchQuote("BONK/USDC");
    expect(priceCalls(mock.calls)).toBe(2);
  });
});

describe("status / jupiter check の設定の表示", () => {
  it("既定: 2.5 秒ごと (伸ばしの注記なし)。1 秒指定のキーなしは実際の 2.5 秒を併記。キーありの 1 秒指定は 1.25 秒", () => {
    const base = formatJupiterSettings(jupiterSettingsFromEnv(loadConfig({}).env))[0];
    expect(base).toContain("価格の取得 2.5 秒ごと /");
    expect(base).not.toContain("伸ばします");
    const fast = formatJupiterSettings(jupiterSettingsFromEnv(loadConfig({ JUPITER_POLL_MS: "1000" }).env))[0];
    expect(fast).toContain("2.5 秒ごと (指定 1 秒は上限を超えるため伸ばします");
    const keyed = formatJupiterSettings(jupiterSettingsFromEnv(loadConfig({ JUPITER_POLL_MS: "1000", JUPITER_API_KEY: "secret-key-xyz" }).env))[0];
    expect(keyed).toContain("1.25 秒ごと (指定 1 秒は上限を超えるため伸ばします");
    expect(keyed).not.toContain("secret-key-xyz");
  });
});

describe("status の戦略一覧: 板が必要な戦略の注記", () => {
  const NOTE = "板が必要: Jupiter では動きません";
  const lines = (env: Record<string, string>) => strategyStatusLines(loadConfig({ NODE_ENV: "test", DB_PATH: "memory", ...env }));

  it("VENUES が jupiter だけ (既定) なら scalp_obi (requiresBook) にだけ付く", () => {
    for (const l of [lines({}), lines({ VENUES: "jupiter" })]) {
      const noted = l.filter((x) => x.includes(NOTE));
      expect(noted).toHaveLength(1);
      expect(noted[0]).toContain("[scalp_obi]");
    }
  });

  it("ccxt・synthetic を含む VENUES なら付けない", () => {
    expect(lines({ VENUES: "ccxt" }).some((x) => x.includes(NOTE))).toBe(false);
    expect(lines({ VENUES: "jupiter,ccxt" }).some((x) => x.includes(NOTE))).toBe(false);
    expect(lines({ VENUES: "synthetic" }).some((x) => x.includes(NOTE))).toBe(false);
  });
});
