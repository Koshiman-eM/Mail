/** 5 秒ループの気配取得だけ再試行を減らす (QUOTE_FETCH_OPTIONS)。足・インスツルメント一覧は既定のまま */
import { describe, expect, it, vi } from "vitest";
import { QUOTE_FETCH_OPTIONS } from "../src/core/http";
import { GmoFeed } from "../src/market/feeds/gmo";
import { GmoClient } from "../src/market/gmo/client";
import { createGmoMock, fakeTime, SYMBOLS_DATA } from "./helpers/gmoMock";

describe("気配取得の FetchOptions", () => {
  it("QUOTE_FETCH_OPTIONS は retries 1 / timeoutMs 4000", () => {
    expect(QUOTE_FETCH_OPTIONS).toEqual({ retries: 1, timeoutMs: 4000 });
  });

  it("GMO: ticker・板・歩み値は retries 1、銘柄一覧は既定", async () => {
    const { fetchImpl } = createGmoMock({
      "GET /v1/symbols": SYMBOLS_DATA,
      "GET /v1/ticker": [{ ask: "10010", bid: "10000", high: "1", last: "10005", low: "1", symbol: "BTC_JPY", timestamp: "2025-01-10T12:00:00.000Z", volume: "3" }],
      "GET /v1/orderbooks": { asks: [{ price: "10010", size: "2" }], bids: [{ price: "10000", size: "3" }], symbol: "BTC_JPY" },
      "GET /v1/trades": { pagination: { currentPage: 1, count: 1 }, list: [{ price: "10005", side: "SELL", size: "0.1", timestamp: "2025-01-10T12:00:02.000Z" }] },
    });
    const t = fakeTime();
    const client = new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep });
    const get = vi.spyOn(client, "publicGet");
    const feed = new GmoFeed({ client, symbols: ["BTC_JPY"], now: t.now });
    await feed.listInstruments();
    await feed.fetchQuote("BTC/JPY");
    await feed.fetchOrderBook("BTC/JPY");
    await feed.fetchPrints("BTC/JPY");
    const retriesOf = (path: string) => get.mock.calls.filter((c) => c[0] === path).map((c) => c[3]);
    expect(retriesOf("/v1/symbols")).toEqual([undefined]);
    expect(retriesOf("/v1/ticker")).toEqual([QUOTE_FETCH_OPTIONS.retries]);
    expect(retriesOf("/v1/orderbooks")).toEqual([QUOTE_FETCH_OPTIONS.retries]);
    expect(retriesOf("/v1/trades")).toEqual([QUOTE_FETCH_OPTIONS.retries]);
  });
});
