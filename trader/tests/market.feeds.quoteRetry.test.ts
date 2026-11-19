/** 5 秒ループの気配取得だけ再試行を減らす (retries 1 / timeoutMs 4000)。足・インスツルメント一覧は既定のまま */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/http", async (orig) => {
  const real = await orig<typeof import("../src/core/http")>();
  return { ...real, fetchJson: vi.fn(real.fetchJson) };
});

const { fetchJson, QUOTE_FETCH_OPTIONS } = await import("../src/core/http");
const { OandaFeed } = await import("../src/market/feeds/oanda");
const { AlpacaFeed } = await import("../src/market/feeds/alpaca");
const { DexScreenerFeed } = await import("../src/market/feeds/dexscreener");

const spy = vi.mocked(fetchJson);
const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2025-01-03T00:00:00Z");

/** 呼び出しごとの (パス, retries, timeoutMs) */
const calls = () =>
  spy.mock.calls.map(([url, opts]) => ({ path: new URL(String(url)).pathname, retries: opts?.retries, timeoutMs: opts?.timeoutMs }));

describe("気配取得の FetchOptions", () => {
  it("QUOTE_FETCH_OPTIONS は retries 1 / timeoutMs 4000", () => {
    expect(QUOTE_FETCH_OPTIONS).toEqual({ retries: 1, timeoutMs: 4000 });
  });

  it("OANDA: pricing だけ短く、candles・instruments は既定", async () => {
    spy.mockClear();
    const fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/pricing")) return jsonRes({ prices: [{ instrument: "USD_JPY", time: "1735862400.000000000", bids: [{ price: "150.0" }], asks: [{ price: "150.02" }] }] });
      if (u.includes("/candles")) return jsonRes({ candles: [] });
      return jsonRes({ instruments: [] });
    }) as unknown as typeof fetch;
    const feed = new OandaFeed({ token: "tok", accountId: "101-1", fetchImpl });
    await feed.fetchQuote("USD/JPY");
    await feed.fetchCandles("USD/JPY", "1m", 10);
    await feed.listInstruments();
    const c = calls();
    expect(c.find((x) => x.path.endsWith("/pricing"))).toMatchObject({ retries: 1, timeoutMs: 4000 });
    expect(c.find((x) => x.path.endsWith("/candles"))).toMatchObject({ retries: undefined, timeoutMs: undefined });
    expect(c.find((x) => x.path.endsWith("/instruments"))).toMatchObject({ retries: undefined, timeoutMs: undefined });
    // ヘッダーは上書きされない
    expect(spy.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("Alpaca: quotes/latest だけ短く、bars は既定", async () => {
    spy.mockClear();
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).includes("/quotes/latest")
        ? jsonRes({ quote: { bp: 100, ap: 100.1, bs: 1, as: 1, t: "2025-01-03T00:00:00Z" } })
        : jsonRes({ bars: [] }),
    ) as unknown as typeof fetch;
    const feed = new AlpacaFeed({ keyId: "K", secretKey: "S", symbols: ["AAPL"], fetchImpl, clock: { now: () => NOW } });
    await feed.fetchQuote("AAPL");
    await feed.fetchCandles("AAPL", "1m", 10);
    const c = calls();
    expect(c.find((x) => x.path.endsWith("/quotes/latest"))).toMatchObject({ retries: 1, timeoutMs: 4000 });
    expect(c.find((x) => x.path.endsWith("/bars"))).toMatchObject({ retries: undefined, timeoutMs: undefined });
  });

  it("DexScreener: 気配のペア取得だけ短く、ペア登録・統計は既定", async () => {
    spy.mockClear();
    const pair = { chainId: "solana", pairAddress: "PAIR1", baseToken: { symbol: "AAA", address: "a" }, quoteToken: { symbol: "SOL", address: "q" }, priceNative: "0.01", liquidity: { usd: 100_000 } };
    const fetchImpl = vi.fn(async () => jsonRes({ pairs: [pair] })) as unknown as typeof fetch;
    const feed = new DexScreenerFeed({ fetchImpl, clock: { now: () => NOW } });
    const inst = await feed.trackPair("solana", "PAIR1");
    await feed.fetchQuote(inst.symbol);
    await feed.fetchPairStats(inst.symbol);
    const c = calls();
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ retries: undefined, timeoutMs: undefined }); // trackPair
    expect(c[1]).toMatchObject({ retries: 1, timeoutMs: 4000 }); // fetchQuote
    expect(c[2]).toMatchObject({ retries: undefined, timeoutMs: undefined }); // fetchPairStats
  });
});
