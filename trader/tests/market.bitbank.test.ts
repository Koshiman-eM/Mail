import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "../src/core/types";
import { fetchCandlesPaged } from "../src/engine/backtestCommand";
import { BITBANK_MAX_FILES, isBitbankNoDataError } from "../src/market/feeds/bitbankCandles";
import { CcxtFeed, type CcxtLike } from "../src/market/feeds/ccxt";
import { MarketHub } from "../src/market/hub";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const JST = 9 * HOUR;
const YEARLY: Timeframe[] = ["4h", "1d", "1w"];

type Boundary = "utc" | "jst";

/** ccxt が bitbank の「URL does not exist」応答で投げる例外と同じ形のメッセージ */
const notFound = () => new Error('bitbank {"success":0,"data":{"code":10000}}');

/**
 * bitbank 風の偽 exchange。params.yyyymmdd (YYYYMMDD / YYYY) のファイル 1 つ分の足を返す。
 * - ファイルの区間は boundary (UTC / JST) で決まる。現在時刻 now より後の足は無い (現在足は含む)。
 * - 区間の開始が now より後のファイル・上場前のファイルは「存在しない」(code 10000)。
 * - ccxt と同じく since で ts >= since に絞り、since があれば先頭 limit 本に切る。
 */
function fakeBitbank(o: { now: () => number; boundary: Boundary; listedAt?: number; overlap?: boolean }) {
  const calls: { tf: string; key: string }[] = [];
  const price = (ts: number) => 1000 + (ts / HOUR) % 97;
  const fileRange = (tf: string, key: string): [number, number] => {
    const off = o.boundary === "jst" ? JST : 0;
    if (key.length === 4) {
      const y = Number(key);
      return [Date.UTC(y, 0, 1) - off, Date.UTC(y + 1, 0, 1) - off];
    }
    const s = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) - off;
    return [s, s + DAY];
  };
  const ex: CcxtLike & { calls: typeof calls } = {
    id: "bitbank",
    calls,
    has: { fetchOHLCV: true },
    loadMarkets: vi.fn(async () => ({})),
    fetchOHLCV: vi.fn(async (_symbol: string, tf: string, since?: number, limit?: number, params?: Record<string, unknown>) => {
      const key = String(params?.yyyymmdd ?? "");
      calls.push({ tf, key });
      const yearly = YEARLY.includes(tf as Timeframe);
      // 公式仕様: 4hour 以上は YYYY、1hour 以下は YYYYMMDD。違う形式はエラー
      if (yearly ? !/^\d{4}$/.test(key) : !/^\d{8}$/.test(key)) throw notFound();
      const [start, end] = fileRange(tf, key);
      const now = o.now();
      if (start > now || end <= (o.listedAt ?? 0)) throw notFound();
      const ms = TIMEFRAME_MS[tf as Timeframe];
      const rows: number[][] = [];
      // overlap: 前のファイルの最後の足も含める (重複除去の確認用)
      for (let ts = o.overlap ? start - ms : start; ts < end && ts <= now; ts += ms) {
        if (ts < (o.listedAt ?? 0)) continue;
        const p = price(ts);
        rows.push([ts, p, p + 1, p - 1, p + 0.5, 1]);
      }
      let out = rows.filter((r) => since === undefined || r[0] >= since);
      if (since !== undefined && limit !== undefined) out = out.slice(0, limit);
      return out;
    }),
    fetchTicker: vi.fn(async () => ({ timestamp: o.now(), bid: 1000, ask: 1001, last: 1000.5 })),
    fetchOrderBook: vi.fn(async () => ({ timestamp: o.now(), bids: [], asks: [] })),
    fetchTrades: vi.fn(async () => []),
  };
  return ex;
}

/** 隙間なく ms 間隔で並び、重複がないか */
function expectContiguous(c: Candle[], ms: number) {
  for (let i = 1; i < c.length; i++) expect(c[i].ts - c[i - 1].ts).toBe(ms);
}

describe("CcxtFeed (bitbank) の履歴取得", () => {
  for (const boundary of ["utc", "jst"] as const) {
    it(`1h×300 本を日付をまたいで隙間なく取得する (日付境界 ${boundary})`, async () => {
      // 16:30 UTC = JST では翌日 01:30。境界がどちらでも現在足まで取れること
      const now = Date.UTC(2026, 10, 19, 16, 30);
      const ex = fakeBitbank({ now: () => now, boundary });
      const feed = new CcxtFeed(ex, { now: () => now });
      const c = await feed.fetchCandles("BTC/JPY", "1h", 300);
      expect(c).toHaveLength(300);
      expectContiguous(c, HOUR);
      expect(c[c.length - 1].ts).toBe(Date.UTC(2026, 10, 19, 16)); // 現在足
      // 日付ファイルを 1 日ずつさかのぼる (YYYYMMDD 形式・上限以内)
      expect(ex.calls.every((x) => /^\d{8}$/.test(x.key))).toBe(true);
      expect(ex.calls.length).toBeLessThanOrEqual(BITBANK_MAX_FILES.day);
      expect(ex.calls[0].key).toBe("20261120"); // 境界未確定なので JST 日付 (翌日) から
      expect(ex.calls[1].key).toBe("20261119");
    });
  }

  it("1m は当日 (と境界をまたぐ分の前日) だけで 300 本そろう", async () => {
    const now = Date.UTC(2026, 10, 19, 3, 0);
    const ex = fakeBitbank({ now: () => now, boundary: "utc" });
    const c = await new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1m", 300);
    expect(c).toHaveLength(300);
    expectContiguous(c, 60_000);
    // 03:00 UTC は当日分が 181 本しかないので前日も取る
    expect(ex.calls.map((x) => x.key)).toEqual(["20261119", "20261118"]);
  });

  it("年次ファイルの時間足 (4h / 1d) は YYYY で今年と前年を取る", async () => {
    const now = Date.UTC(2026, 0, 10, 12, 0);
    for (const boundary of ["utc", "jst"] as const) {
      const ex = fakeBitbank({ now: () => now, boundary });
      const feed = new CcxtFeed(ex, { now: () => now });
      const h4 = await feed.fetchCandles("BTC/JPY", "4h", 300); // 50 日分 → 前年が必要
      expect(h4).toHaveLength(300);
      expectContiguous(h4, 4 * HOUR);
      expect(ex.calls.map((x) => x.key)).toEqual(["2026", "2025"]);
      ex.calls.length = 0;
      const d1 = await feed.fetchCandles("BTC/JPY", "1d", 5); // 今年の分だけで足りる
      expect(d1).toHaveLength(5);
      expectContiguous(d1, DAY);
      expect(ex.calls.map((x) => x.key)).toEqual(["2026"]);
    }
  });

  it("ファイル間で重複した足は ts で 1 本にまとめる", async () => {
    const now = Date.UTC(2026, 10, 19, 10, 0);
    const ex = fakeBitbank({ now: () => now, boundary: "utc", overlap: true });
    const c = await new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1h", 60);
    expect(c).toHaveLength(60);
    expect(new Set(c.map((x) => x.ts)).size).toBe(60);
    expectContiguous(c, HOUR);
  });

  it("存在しない日付 (未来日・上場前) は 0 本として扱い、全体は失敗させない", async () => {
    const now = Date.UTC(2026, 10, 19, 16, 30);
    const listedAt = Date.UTC(2026, 10, 17, 0, 0); // 2 日半前に上場
    const ex = fakeBitbank({ now: () => now, boundary: "utc", listedAt });
    const c = await new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1h", 300);
    expect(c[0].ts).toBe(listedAt);
    expect(c[c.length - 1].ts).toBe(Date.UTC(2026, 10, 19, 16));
    expect(c).toHaveLength(2 * 24 + 17);
    expectContiguous(c, HOUR);
    // 上限 (1h×300 → 15 ファイル) で止まる
    expect(ex.calls.length).toBeLessThanOrEqual(BITBANK_MAX_FILES.day);
  });

  it("ネットワーク障害などは従来どおり throw する", async () => {
    const now = Date.UTC(2026, 10, 19, 10, 0);
    const ex = fakeBitbank({ now: () => now, boundary: "utc" });
    ex.fetchOHLCV = vi.fn(async () => {
      throw new Error("bitbank GET https://public.bitbank.cc/btc_jpy/candlestick/1hour/20261119 request timed out (10000 ms)");
    });
    await expect(new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1h", 10)).rejects.toThrow(/timed out/);
    expect(isBitbankNoDataError(new Error("GET https://public.bitbank.cc/x 404 Not Found {}"))).toBe(true);
    expect(isBitbankNoDataError(new Error('bitbank {"success":0,"data":{"code":10000}}'))).toBe(true);
    expect(isBitbankNoDataError(new Error("GET https://public.bitbank.cc/x 503 Service Unavailable"))).toBe(false);
    expect(isBitbankNoDataError(new Error("fetch failed ECONNRESET"))).toBe(false);
  });

  it("since 指定では since 以降に必要な日付だけを古い順に取る", async () => {
    const now = Date.UTC(2026, 10, 19, 10, 0);
    const ex = fakeBitbank({ now: () => now, boundary: "utc" });
    const since = Date.UTC(2026, 10, 10, 5, 0);
    const c = await new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1h", 30, since);
    expect(c).toHaveLength(30);
    expect(c[0].ts).toBe(since);
    expectContiguous(c, HOUR);
    expect(ex.calls.map((x) => x.key)).toEqual(["20261110", "20261111"]);
  });

  it("時間足の非対応・fetchOHLCV を持たない取引所はわかりやすいエラー", async () => {
    const now = Date.UTC(2026, 10, 19, 10, 0);
    const ex = fakeBitbank({ now: () => now, boundary: "utc" });
    await expect(new CcxtFeed(ex, { now: () => now }).fetchCandles("BTC/JPY", "1s", 10)).rejects.toThrow(/bitbank は時間足 1s/);
    const bf = { ...fakeBitbank({ now: () => now, boundary: "utc" }), id: "bitflyer", has: { fetchOHLCV: undefined } };
    await expect(new CcxtFeed(bf).fetchCandles("BTC/JPY", "1h", 10)).rejects.toThrow(/bitflyer は ccxt でローソク足 \(fetchOHLCV\) を提供していません/);
    expect(bf.fetchOHLCV).not.toHaveBeenCalled();
  });

  it("バックテストのページング (fetchCandlesPaged) で 30 日分の 1h を隙間なく取得する", async () => {
    const now = Date.UTC(2026, 10, 19, 10, 20);
    const ex = fakeBitbank({ now: () => now, boundary: "jst" });
    const feed = new CcxtFeed(ex, { now: () => now });
    const until = Date.UTC(2026, 10, 19, 10);
    const from = until - 30 * DAY;
    const c = await fetchCandlesPaged(feed, "BTC/JPY", "1h", from, until);
    expect(c).toHaveLength(30 * 24);
    expect(c[0].ts).toBe(from);
    expect(c[c.length - 1].ts).toBe(until - HOUR);
    expectContiguous(c, HOUR);
  });
});

describe("MarketHub の bitbank 毎回更新", () => {
  const inst = {
    symbol: "BTC/JPY", venue: "ccxt:bitbank", assetClass: "crypto" as const, baseCurrency: "BTC", quoteCurrency: "JPY",
    tickSize: 1, lotSize: 0.0001, minQty: 0.0001, takerFeeRate: 0.0012, makerFeeRate: -0.0002, allowShort: false,
  };

  function setup(start: number, boundary: Boundary) {
    let now = start;
    const clock = { now: () => now };
    const ex = fakeBitbank({ now: clock.now, boundary });
    const feed = new CcxtFeed(ex, { now: clock.now });
    const hub = new MarketHub({ feeds: [feed], clock, timeframes: ["1m", "1h", "4h"], historyLimit: 300, withBook: false, minIntervalMs: { "ccxt:bitbank": 0 } });
    hub.watch(inst, feed);
    return { ex, hub, advance: (ms: number) => void (now += ms), now: () => now };
  }

  it("更新は当日 (年次足は今年) のファイルだけを取り、長い時間足は間引く", async () => {
    // 10:00:30 UTC。境界は JST (翌日ファイルは無い時間帯)
    const t = setup(Date.UTC(2026, 10, 19, 10, 0, 30), "jst");
    await t.hub.pollSymbol("BTC/JPY"); // 初回: 履歴取得
    expect(t.hub.lastError("BTC/JPY")).toBeUndefined();
    expect(t.hub.chartCandles("BTC/JPY", "1h", 1000)).toHaveLength(300);
    expect(t.hub.chartCandles("BTC/JPY", "4h", 1000)).toHaveLength(300);
    const afterLoad = t.ex.calls.length;

    // 5 秒後: 1m だけ取り直す (当日ファイル 1 つ)。1h / 4h は間引く
    t.advance(5_000);
    await t.hub.pollSymbol("BTC/JPY");
    expect(t.ex.calls.slice(afterLoad)).toEqual([{ tf: "1m", key: "20261119" }]);

    // 61 秒後: 1h も間隔 (1 分) を過ぎたので当日ファイルを取る。4h (間隔 4 分) はまだ
    const mark = t.ex.calls.length;
    t.advance(61_000);
    await t.hub.pollSymbol("BTC/JPY");
    expect(t.ex.calls.slice(mark)).toEqual([{ tf: "1m", key: "20261119" }, { tf: "1h", key: "20261119" }]);

    // 4 分後: 4h は今年のファイルだけ
    const mark2 = t.ex.calls.length;
    t.advance(4 * 60_000);
    await t.hub.pollSymbol("BTC/JPY");
    expect(t.ex.calls.slice(mark2).find((x) => x.tf === "4h")).toEqual({ tf: "4h", key: "2026" });
    expect(t.ex.calls.slice(mark2).filter((x) => x.tf === "4h")).toHaveLength(1);
  });

  it("足の境界をまたいだら間隔に関係なく取り直し、確定足は取引所の値になる", async () => {
    const t = setup(Date.UTC(2026, 10, 19, 10, 59, 0), "utc");
    await t.hub.pollSymbol("BTC/JPY");
    t.advance(20_000); // 10:59:20 (間隔内 → 1h は取らず、現在足を気配で更新)
    await t.hub.pollSymbol("BTC/JPY");
    const cur = t.hub.chartCandles("BTC/JPY", "1h", 1)![0];
    expect(cur.ts).toBe(Date.UTC(2026, 10, 19, 10));
    expect(cur.close).toBe(1000.5); // 気配の last
    const mark = t.ex.calls.length;
    t.advance(45_000); // 11:00:05 (境界をまたいだ)
    await t.hub.pollSymbol("BTC/JPY");
    expect(t.ex.calls.slice(mark).filter((x) => x.tf === "1h")).toEqual([{ tf: "1h", key: "20261119" }]);
    const view = t.hub.getView("BTC/JPY")!;
    const closed = view.candles["1h"]!;
    expect(closed[closed.length - 1].ts).toBe(Date.UTC(2026, 10, 19, 10));
    const p = 1000 + (Date.UTC(2026, 10, 19, 10) / HOUR) % 97;
    expect(closed[closed.length - 1].close).toBe(p + 0.5); // 取引所の値で上書き
    expect(t.hub.chartCandles("BTC/JPY", "1h", 1)![0].ts).toBe(Date.UTC(2026, 10, 19, 11));
    expectContiguous(t.hub.chartCandles("BTC/JPY", "1h", 1000)!, HOUR);
  });

  it("日付境界が判定できたら翌日ファイルを取りにいかない", async () => {
    // 16:30 UTC (JST では翌日)。UTC 境界なので 20261120 は存在しない
    const t = setup(Date.UTC(2026, 10, 19, 16, 30, 0), "utc");
    await t.hub.pollSymbol("BTC/JPY");
    const mark = t.ex.calls.length;
    t.advance(5_000);
    await t.hub.pollSymbol("BTC/JPY");
    expect(t.ex.calls.slice(mark)).toEqual([{ tf: "1m", key: "20261119" }]);
  });

  it("間引かない取引所は従来どおり毎回直近 5 本 (since なし) を取る", async () => {
    let now = Date.UTC(2026, 10, 19, 10, 0, 30);
    const ex = { ...fakeBitbank({ now: () => now, boundary: "utc" }), id: "mock" };
    const rows = (ts: number) => [[ts, 1, 2, 0.5, 1.5, 1]];
    ex.fetchOHLCV = vi.fn(async () => rows(Math.floor(now / HOUR) * HOUR));
    const feed = new CcxtFeed(ex);
    expect(feed.candleRefreshIntervalMs("1h")).toBe(0);
    const hub = new MarketHub({ feeds: [feed], clock: { now: () => now }, timeframes: ["1h"], withBook: false, minIntervalMs: { "ccxt:mock": 0 } });
    hub.watch({ ...inst, venue: "ccxt:mock" }, feed);
    await hub.pollSymbol("BTC/JPY");
    now += 5_000;
    await hub.pollSymbol("BTC/JPY");
    expect(ex.fetchOHLCV).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ex.fetchOHLCV).mock.calls[0]).toEqual(["BTC/JPY", "1h", undefined, 300]);
    expect(vi.mocked(ex.fetchOHLCV).mock.calls[1]).toEqual(["BTC/JPY", "1h", undefined, 5]);
    expect(vi.mocked(ex.fetchOHLCV).mock.calls[2]).toEqual(["BTC/JPY", "1h", undefined, 5]);
  });
});

describe("実際の ccxt bitbank クラス (HTTP は差し替え・完全オフライン)", () => {
  it("params の yyyymmdd が URL に入り、存在しない日付の 404 応答は 0 本になる", async () => {
    const ccxt = createRequire(import.meta.url)("ccxt") as Record<string, any>;
    const ex = new ccxt.bitbank({ enableRateLimit: false });
    ex.fetchMarkets = async () => [
      {
        id: "btc_jpy", symbol: "BTC/JPY", base: "BTC", quote: "JPY", baseId: "btc", quoteId: "jpy", settle: undefined, settleId: undefined,
        type: "spot", spot: true, margin: false, swap: false, future: false, option: false, active: true, contract: false,
        linear: undefined, inverse: undefined, contractSize: undefined, expiry: undefined, expiryDatetime: undefined, strike: undefined,
        optionType: undefined, taker: 0.0012, maker: -0.0002, precision: { amount: 0.0001, price: 1 }, limits: {}, info: {},
      },
    ];
    const now = Date.UTC(2026, 10, 19, 1, 30);
    const urls: string[] = [];
    ex.fetchImplementation = async (url: string) => {
      urls.push(url);
      const m = /\/btc_jpy\/candlestick\/(\w+)\/(\d+)$/.exec(url);
      if (!m || m[2] !== "20261119" && m[2] !== "20261118") {
        return new Response(JSON.stringify({ success: 0, data: { code: 10000 } }), { status: 404, headers: { "content-type": "application/json" } });
      }
      const start = Date.UTC(Number(m[2].slice(0, 4)), Number(m[2].slice(4, 6)) - 1, Number(m[2].slice(6, 8)));
      const ohlcv: unknown[] = [];
      for (let ts = start; ts < start + DAY && ts <= now; ts += HOUR) ohlcv.push(["100", "110", "90", "105", "1.5", ts]);
      return new Response(JSON.stringify({ success: 1, data: { candlestick: [{ type: m[1], ohlcv }], timestamp: now } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const feed = new CcxtFeed(ex as CcxtLike, { now: () => now });
    const c = await feed.fetchCandles("BTC/JPY", "1h", 30);
    expect(urls[0]).toBe("https://public.bitbank.cc/btc_jpy/candlestick/1hour/20261119");
    expect(urls.every((u) => u.startsWith("https://public.bitbank.cc/btc_jpy/candlestick/1hour/"))).toBe(true);
    expect(c).toHaveLength(24 + 2); // 20261118 の 24 本 + 当日 2 本 (それより前は存在しない日付)
    expectContiguous(c, HOUR);
    expect(c[c.length - 1]).toMatchObject({ ts: Date.UTC(2026, 10, 19, 1), open: 100, high: 110, low: 90, close: 105, volume: 1.5 });

    urls.length = 0;
    // 年次足は YYYY。この fake には 4hour のデータが無い → すべて 0 本 (失敗させない)・上限 3 ファイルで止まる
    expect(await feed.fetchCandles("BTC/JPY", "4h", 5)).toEqual([]);
    expect(urls).toEqual([
      "https://public.bitbank.cc/btc_jpy/candlestick/4hour/2026",
      "https://public.bitbank.cc/btc_jpy/candlestick/4hour/2025",
      "https://public.bitbank.cc/btc_jpy/candlestick/4hour/2024",
    ]);
  });
});
