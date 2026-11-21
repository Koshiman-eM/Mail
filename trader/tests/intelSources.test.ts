import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
