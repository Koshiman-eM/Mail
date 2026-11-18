import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessRugRisk, parseBoostTokens, parseDexPairs, createDexScreenerSource } from "../src/intel/sources/dexscreener";
import { parseCoinGeckoTrending } from "../src/intel/sources/coingecko";
import { createCryptoPanicSource, parseCryptoPanic, votesToSentiment } from "../src/intel/sources/cryptopanic";
import { econEventsToItems, parseEconEvents } from "../src/intel/sources/econCalendar";
import { parseFearGreed } from "../src/intel/sources/fearGreed";
import { createRssSource, parseFeed, resolveFeedUrls, rssSourceId, DEFAULT_RSS_FEEDS } from "../src/intel/sources/rss";

const fx = (n: string) => readFileSync(new URL(`./fixtures/intel/${n}`, import.meta.url), "utf8");
const fj = (n: string) => JSON.parse(fx(n));
const NOW = Date.parse("2025-11-03T13:00:00Z");

describe("rss", () => {
  it("RSS2 をパースし資産を付与、空タイトルは除外", () => {
    const items = parseFeed(fx("rss.xml"), { source: "rss:news.example.com", now: NOW });
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain("Bitcoin surges");
    expect(items[0].assets).toEqual(expect.arrayContaining(["BTC", "ETH", "CRYPTO"]));
    expect(items[0].summary).toBe("BTC rallied & ether followed.");
    expect(items[0].publishedAt).toBe(Date.parse("2025-11-03T10:00:00Z"));
    expect(items[1].assets).toContain("SOL");
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });
  it("Atom をパース", () => {
    const [it] = parseFeed(fx("atom.xml"), { source: "rss:x", now: NOW });
    expect(it.url).toBe("https://news.example.com/b1");
    expect(it.assets).toEqual(expect.arrayContaining(["USD", "JPY", "FX"]));
  });
  it("ID は決定的", () => {
    const a = parseFeed(fx("rss.xml"), { source: "s", now: 1 });
    const b = parseFeed(fx("rss.xml"), { source: "s", now: 2 });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });
  it("source id とフィード解決", () => {
    expect(rssSourceId("https://www.coindesk.com/arc/outboundfeeds/rss/")).toBe("rss:coindesk.com");
    expect(resolveFeedUrls(undefined)).toEqual(DEFAULT_RSS_FEEDS);
    expect(resolveFeedUrls("https://a.example/rss")).toHaveLength(DEFAULT_RSS_FEEDS.length + 1);
    expect(resolveFeedUrls("=https://a.example/rss")).toEqual(["https://a.example/rss"]);
  });
  it("fetch 注入", async () => {
    const src = createRssSource({ url: "https://x.example/feed", fetchText: async () => fx("atom.xml") });
    expect(src.id).toBe("rss:x.example");
    expect(await src.fetch(NOW)).toHaveLength(1);
  });
});

describe("fearGreed", () => {
  it("最新値を metric として返す", () => {
    const [it] = parseFearGreed(fj("fng.json"), NOW);
    expect(it.kind).toBe("metric");
    expect(it.assets).toEqual(["CRYPTO"]);
    expect(it.metrics).toEqual({ fng: 82, fngPrev: 75 });
    expect(it.publishedAt).toBe(1762128000_000);
    expect(parseFearGreed({}, NOW)).toEqual([]);
  });
});

describe("cryptopanic", () => {
  it("votes から sentiment を推定", () => {
    const items = parseCryptoPanic(fj("cryptopanic.json"), NOW);
    expect(items).toHaveLength(2);
    expect(items[0].sentiment!).toBeGreaterThan(0.5);
    expect(items[0].assets).toEqual(expect.arrayContaining(["ETH", "CRYPTO"]));
    expect(items[1].sentiment).toBeUndefined();
    expect(votesToSentiment({ positive: 1, negative: 10 })!).toBeLessThan(0);
  });
  it("トークン無しは無効、エラーからトークンを伏せる", async () => {
    const saved = process.env.CRYPTOPANIC_TOKEN;
    delete process.env.CRYPTOPANIC_TOKEN;
    expect(createCryptoPanicSource()).toBeUndefined();
    if (saved !== undefined) process.env.CRYPTOPANIC_TOKEN = saved;
    const src = createCryptoPanicSource({
      token: "SECRET123",
      fetchJson: async (u) => {
        throw new Error(`fail ${u}`);
      },
    })!;
    await expect(src.fetch(NOW)).rejects.toThrow(/\*\*\*/);
    await expect(src.fetch(NOW)).rejects.not.toThrow(/SECRET123/);
  });
});

describe("dexscreener", () => {
  it("ラグプル危険度の判定", () => {
    expect(assessRugRisk({ liquidityUsd: 5_000_000, ageMs: 30 * 86_400_000, buysH1: 100, sellsH1: 90 })).toBe(0);
    expect(assessRugRisk({ liquidityUsd: 3_000, ageMs: 1000, buysH1: 200, sellsH1: 3 })).toBe(1);
    expect(assessRugRisk({ ageMs: 2 * 3_600_000 })).toBeGreaterThan(0.7);
  });
  it("ペアをパースし、危険銘柄の importance を下げる", () => {
    const tokens = parseBoostTokens(fj("dex_boosts.json"), fj("dex_boosts.json"));
    expect(tokens).toHaveLength(3);
    const items = parseDexPairs(fj("dex_pairs.json"), NOW);
    expect(items).toHaveLength(2); // GOOD の 2 ペアは流動性最大を採用
    const good = items.find((i) => i.assets[0] === "GOOD")!;
    const rug = items.find((i) => i.assets[0] === "RUGGY")!;
    expect(good.metrics!.liquidityUsd).toBe(2_500_000);
    expect(good.assets).toEqual(["GOOD", "MEME"]);
    expect(good.metrics!.rugRisk).toBeLessThan(0.2);
    expect(rug.metrics!.rugRisk).toBeGreaterThanOrEqual(0.8);
    expect(rug.importance!).toBeLessThan(good.importance!);
    expect(rug.sentiment!).toBeLessThan(good.sentiment!);
    expect(good.metrics!.volumeH1).toBe(200000);
  });
  it("fetch フロー (注入)", async () => {
    const urls: string[] = [];
    const src = createDexScreenerSource({
      fetchJson: async (u) => {
        urls.push(u);
        if (u.includes("token-boosts")) return fj("dex_boosts.json");
        return fj("dex_pairs.json");
      },
    });
    const items = await src.fetch(NOW);
    expect(items.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes("/tokens/v1/solana/AddrGood111,AddrRug222"))).toBe(true);
  });
});

describe("coingecko", () => {
  it("トレンドをパース", () => {
    const items = parseCoinGeckoTrending(fj("coingecko.json"), NOW);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("trending");
    expect(items[0].assets).toEqual(expect.arrayContaining(["PLK", "CRYPTO"]));
    expect(items[0].sentiment!).toBeGreaterThan(0);
    expect(items[1].assets).toContain("BTC");
    expect(items[1].sentiment!).toBeLessThan(0);
  });
});

describe("econCalendar", () => {
  it("イベントと IntelItem に変換 (Holiday は除外)", () => {
    const ev = parseEconEvents(fj("calendar.json"));
    expect(ev).toHaveLength(3);
    const nfp = ev.find((e) => e.currency === "USD")!;
    expect(nfp.impact).toBe("high");
    expect(nfp.ts).toBe(Date.parse("2025-11-07T13:30:00Z"));
    expect(ev.find((e) => e.title === "Minor Index")!.currency).toBeUndefined();
    const items = econEventsToItems(ev, NOW);
    expect(items.every((i) => i.kind === "calendar")).toBe(true);
    expect(items.find((i) => i.assets.includes("USD"))!.assets).toEqual(["USD", "FX"]);
  });
});
