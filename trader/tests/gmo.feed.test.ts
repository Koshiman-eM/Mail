import { describe, expect, it, vi } from "vitest";
import type { Candle } from "../src/core/types";
import { loadConfig } from "../src/core/config";
import { GmoApiError, GmoClient } from "../src/market/gmo/client";
import { fetchGmoKlines, GmoNoKlinesError } from "../src/market/gmo/klines";
import { utcDayKey } from "../src/market/fileCandles";
import { GmoFeed } from "../src/market/feeds/gmo";
import { buildRuntime } from "../src/engine/setup";
import { MemoryStore } from "../src/storage/memory";
import { canShort } from "../src/core/short";
import { createGmoMock, fakeTime, SYMBOLS_DATA } from "./helpers/gmoMock";

const H = 3_600_000;
const DAY = 24 * H;
const M = 60_000;

/** JST 6:00 区切りの日付ファイル (合成データ)。key=YYYYMMDD → [D 06:00 JST, 翌 06:00 JST) = [D-1 21:00 UTC, D 21:00 UTC) */
function dayFileJst6(key: string, stepMs: number): Candle[] {
  const d = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
  const start = d - 3 * H;
  const out: Candle[] = [];
  for (let t = start; t < start + DAY; t += stepMs) out.push({ ts: t, open: 100, high: 101, low: 99, close: 100 + (t % 7), volume: 1 });
  return out;
}

const noData = () => new GmoApiError("/v1/klines", ["ERR-5207"], ["no data"]);

describe("fetchGmoKlines (日付ファイルのさかのぼり)", () => {
  it("since なし: 最新のファイルからさかのぼり、重複を除いて末尾 limit 本 (未来の足は捨てる)", async () => {
    const now = Date.UTC(2025, 0, 10, 12, 0); // 2025-01-10 21:00 JST
    const calls: string[] = [];
    const fetchFile = vi.fn(async (_s: string, interval: string, date: string) => {
      calls.push(date);
      expect(interval).toBe("1hour");
      return dayFileJst6(date, H);
    });
    const c = await fetchGmoKlines(fetchFile, "BTC_JPY", "1h", 48, now);
    expect(c).toHaveLength(48);
    expect(c[c.length - 1].ts).toBeLessThanOrEqual(now);
    expect(new Set(c.map((x) => x.ts)).size).toBe(48);
    for (let i = 1; i < c.length; i++) expect(c[i].ts - c[i - 1].ts).toBe(H);
    // 最初は JST 日付 (now + 9h) のファイル
    expect(calls[0]).toBe("20250110");
    expect(calls).toContain("20250109");
  });

  it("日付ファイルの境界をまたいでも抜けが無い (JST 0:00 = UTC 15:00 の前後)", async () => {
    const now = Date.UTC(2025, 0, 10, 16, 0); // 2025-01-11 01:00 JST (JST 日付は 11 日、JST 6:00 区切りではまだ 10 日のファイル)
    const fetchFile = async (_s: string, _i: string, date: string) => {
      if (date === "20250111") throw noData(); // まだ存在しない日付
      return dayFileJst6(date, 15 * M);
    };
    const c = await fetchGmoKlines(fetchFile, "BTC_JPY", "15m", 200, now);
    expect(c).toHaveLength(200);
    for (let i = 1; i < c.length; i++) expect(c[i].ts - c[i - 1].ts).toBe(15 * M);
    expect(c[c.length - 1].ts).toBe(now);
  });

  it("since あり: since を含みうるファイルから順に取り、ts >= since の先頭 limit 本", async () => {
    const now = Date.UTC(2025, 0, 20, 0, 0);
    const since = Date.UTC(2025, 0, 12, 20, 0); // JST 6:00 の境界 (21:00 UTC) の直前
    const calls: string[] = [];
    const fetchFile = async (_s: string, _i: string, date: string) => {
      calls.push(date);
      return dayFileJst6(date, M);
    };
    const c = await fetchGmoKlines(fetchFile, "BTC_JPY", "1m", 180, now, since);
    expect(c).toHaveLength(180);
    expect(c[0].ts).toBe(since);
    expect(c[c.length - 1].ts).toBe(since + 179 * M);
    expect(calls[0]).toBe("20250112"); // since の UTC 日付から
  });

  it("4hour 以上は YYYY の年ファイル", async () => {
    const now = Date.UTC(2025, 0, 3, 0, 0);
    const dates: string[] = [];
    const fetchFile = async (_s: string, interval: string, date: string) => {
      dates.push(date);
      expect(interval).toBe("4hour");
      const y = Number(date);
      const out: Candle[] = [];
      for (let t = Date.UTC(y, 0, 1) - 3 * H; t < Date.UTC(y + 1, 0, 1) - 3 * H; t += 4 * H) out.push({ ts: t, open: 1, high: 1, low: 1, close: 1, volume: 0 });
      return out;
    };
    const c = await fetchGmoKlines(fetchFile, "BTC_JPY", "4h", 50, now);
    expect(c).toHaveLength(50);
    expect(dates).toEqual(["2025", "2024"]);
    expect(dates.every((d) => /^\d{4}$/.test(d))).toBe(true);
  });

  it("全ファイルが取引所のエラーなら GmoNoKlinesError。メンテナンスは握りつぶさずに投げる", async () => {
    const now = Date.UTC(2025, 0, 10, 12, 0);
    await expect(fetchGmoKlines(async () => { throw noData(); }, "BTC_JPY", "1h", 5, now)).rejects.toBeInstanceOf(GmoNoKlinesError);
    const maint = new GmoApiError("/v1/klines", ["ERR-5201"], ["maintenance"]);
    await expect(fetchGmoKlines(async () => { throw maint; }, "BTC_JPY", "1h", 5, now)).rejects.toBe(maint);
  });

  it("日付キーは UTC 日付", () => {
    expect(utcDayKey(Date.UTC(2025, 1, 3, 23, 59))).toBe("20250203");
  });
});

/** klines の模擬: date ごとに JST 6:00 区切りのファイルを返す */
function klinesRoute(opts: { leverage: boolean } = { leverage: true }) {
  return (req: { query: URLSearchParams }) => {
    const sym = req.query.get("symbol")!;
    const date = req.query.get("date")!;
    const interval = req.query.get("interval")!;
    if (!opts.leverage && sym.includes("_")) return { __status: 1, __messages: [{ message_code: "ERR-5207", message_string: "symbol not supported" }] };
    const step = interval === "1min" ? M : interval === "15min" ? 15 * M : H;
    return dayFileJst6(date, step).map((c) => ({ openTime: String(c.ts), open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: "1" }));
  };
}

describe("GmoFeed", () => {
  const now = Date.UTC(2025, 0, 10, 12, 0);

  it("listInstruments: レバレッジ銘柄を統一シンボル・手数料・刻み・空売り可・meta 付きで作る", async () => {
    const { fetchImpl } = createGmoMock({ "GET /v1/symbols": SYMBOLS_DATA });
    const feed = new GmoFeed({ clientOptions: { fetchImpl }, symbols: ["BTC_JPY", "XRP_JPY", "DOGE_JPY"], holdingFeeDaily: 0.0004 });
    const list = await feed.listInstruments();
    expect(list.map((i) => i.symbol)).toEqual(["BTC/JPY", "XRP/JPY"]); // DOGE_JPY は無いので無視
    const btc = list[0];
    expect(btc).toMatchObject({
      venue: "gmo", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY", allowShort: true,
      takerFeeRate: 0, makerFeeRate: 0, lotSize: 0.01, minQty: 0.01, tickSize: 1,
    });
    expect(btc.meta).toMatchObject({ gmoSymbol: "BTC_JPY", gmoSpotSymbol: "BTC", leverage: 1, holdingFeeDaily: 0.0004 });
    expect(list[1].tickSize).toBe(0.001);
    expect(list[1].lotSize).toBe(10);
  });

  it("fetchQuote / fetchOrderBook / fetchPrints", async () => {
    const { fetchImpl } = createGmoMock({
      "GET /v1/symbols": SYMBOLS_DATA,
      "GET /v1/ticker": [{ ask: "10010", bid: "10000", high: "1", last: "10005", low: "1", symbol: "BTC_JPY", timestamp: "2025-01-10T12:00:00.000Z", volume: "3" }],
      "GET /v1/orderbooks": { asks: [{ price: "10020", size: "1" }, { price: "10010", size: "2" }], bids: [{ price: "9990", size: "1" }, { price: "10000", size: "3" }], symbol: "BTC_JPY" },
      "GET /v1/trades": { pagination: { currentPage: 1, count: 2 }, list: [
        { price: "10005", side: "SELL", size: "0.1", timestamp: "2025-01-10T12:00:02.000Z" },
        { price: "10004", side: "BUY", size: "0.2", timestamp: "2025-01-10T12:00:01.000Z" },
      ] },
    });
    const feed = new GmoFeed({ clientOptions: { fetchImpl }, symbols: ["BTC_JPY"], now: () => now });
    await feed.listInstruments();
    expect(await feed.fetchQuote("BTC/JPY")).toEqual({ ts: Date.parse("2025-01-10T12:00:00.000Z"), bid: 10000, ask: 10010, last: 10005 });
    const ob = await feed.fetchOrderBook("BTC/JPY");
    expect(ob.asks[0]).toEqual([10010, 2]);
    expect(ob.bids[0]).toEqual([10000, 3]);
    const pr = await feed.fetchPrints("BTC/JPY");
    expect(pr.map((p) => p.side)).toEqual(["buy", "sell"]);
  });

  it("fetchCandles: レバレッジ銘柄の足を使う", async () => {
    const { fetchImpl, requests } = createGmoMock({ "GET /v1/symbols": SYMBOLS_DATA, "GET /v1/klines": klinesRoute() });
    const t = fakeTime(now);
    const feed = new GmoFeed({ client: new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep }), symbols: ["BTC_JPY"], now: () => now });
    await feed.listInstruments();
    const c = await feed.fetchCandles("BTC/JPY", "1h", 30);
    expect(c).toHaveLength(30);
    expect(requests.filter((r) => r.path === "/v1/klines").every((r) => r.query.get("symbol") === "BTC_JPY")).toBe(true);
    expect(feed.candleRefreshIntervalMs("1h")).toBe(60_000);
    await expect(feed.fetchCandles("BTC/JPY", "1s", 5)).rejects.toThrow(/1s/);
  });

  it("fetchCandles: 既定では現物銘柄の足に切り替えずに例外", async () => {
    const { fetchImpl, requests } = createGmoMock({ "GET /v1/symbols": SYMBOLS_DATA, "GET /v1/klines": klinesRoute({ leverage: false }) });
    const t = fakeTime(now);
    const feed = new GmoFeed({ client: new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep }), symbols: ["BTC_JPY"], now: () => now });
    await feed.listInstruments();
    await expect(feed.fetchCandles("BTC/JPY", "15m", 10)).rejects.toThrow(/GMO_ALLOW_SPOT_CANDLES/);
    expect(requests.filter((r) => r.path === "/v1/klines").every((r) => r.query.get("symbol") === "BTC_JPY")).toBe(true);
  });

  it("fetchCandles: 許可されていれば現物銘柄にフォールバックして知らせ、以後もそれを使う", async () => {
    const { fetchImpl, requests } = createGmoMock({ "GET /v1/symbols": SYMBOLS_DATA, "GET /v1/klines": klinesRoute({ leverage: false }) });
    const t = fakeTime(now);
    const notes: unknown[] = [];
    const feed = new GmoFeed({
      client: new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep }), symbols: ["BTC_JPY"], now: () => now,
      allowSpotCandles: true, onSpotCandles: (i) => notes.push(i),
    });
    await feed.listInstruments();
    const c = await feed.fetchCandles("BTC/JPY", "15m", 10);
    expect(c).toHaveLength(10);
    expect(notes).toEqual([expect.objectContaining({ symbol: "BTC/JPY", tf: "15m", leverageSymbol: "BTC_JPY", spotSymbol: "BTC" })]);
    requests.length = 0;
    const d = await feed.fetchCandles("BTC/JPY", "15m", 5, now - 2 * H);
    expect(d.length).toBe(5);
    expect(requests.every((r) => r.query.get("symbol") === "BTC")).toBe(true);
  });
});

describe("setup: VENUES=gmo (paper)", () => {
  const now = Date.UTC(2025, 0, 10, 12, 0);
  it("GMO の銘柄で PaperBroker を組み立て、空売りの再現は付かず普通の空売りになる", async () => {
    const { fetchImpl } = createGmoMock({
      "GET /v1/symbols": SYMBOLS_DATA,
      "GET /v1/ticker": [{ ask: "10010", bid: "10000", high: "1", last: "10005", low: "1", symbol: "BTC_JPY", timestamp: "2025-01-10T12:00:00.000Z", volume: "3" }],
    });
    const config = loadConfig({ VENUES: "gmo", GMO_SYMBOLS: "BTC_JPY", GMO_LEVERAGE_FEE_DAILY: "0.0005" });
    const rt = await buildRuntime(config, { store: new MemoryStore(), intelSources: [], ai: null, fetchImpl, clock: { now: () => now } });
    try {
      expect(rt.instruments).toHaveLength(1);
      const inst = rt.instruments[0];
      expect(inst.venue).toBe("gmo");
      expect(inst.simulatedShort).toBeUndefined();
      expect(canShort(inst, "paper")).toBe(true);
      expect(canShort(inst, "live")).toBe(true);
      expect(inst.meta?.holdingFeeDaily).toBe(0.0005);
      expect(rt.brokerSet.mode).toBe("paper");
      const paper = rt.brokerSet.paper!;
      paper.onQuote("BTC/JPY", { ts: now, bid: 10000, ask: 10010 });
      const r = await paper.placeOrder({ clientId: "s1", symbol: "BTC/JPY", side: "sell", type: "market", qty: "0.015", strategyId: "t" });
      expect(r.status).toBe("filled");
      expect(r.fills[0].qty).toBe("0.01"); // sizeStep 0.01 に切り捨て
      expect((await paper.getPositions())[0].qty).toBe("-0.01");
    } finally {
      rt.close();
    }
  });

  it("現物の足への切り替え: paper は許可して監査ログ gmo.spot_candles を残す。live は GMO_ALLOW_SPOT_CANDLES=true のときだけ", async () => {
    const routes = { "GET /v1/symbols": SYMBOLS_DATA, "GET /v1/klines": klinesRoute({ leverage: false }) };
    const liveSet = { mode: "live" as const, brokers: new Map(), brokerFor: () => { throw new Error("no broker"); } };
    const run = async (env: Record<string, string>, brokerSet?: typeof liveSet) => {
      const { fetchImpl } = createGmoMock(routes);
      const store = new MemoryStore();
      const rt = await buildRuntime(loadConfig({ VENUES: "gmo", GMO_SYMBOLS: "BTC_JPY", ...env }), {
        store, intelSources: [], ai: null, fetchImpl, clock: { now: () => now }, ...(brokerSet ? { brokerSet } : {}),
      });
      try {
        const feed = rt.feeds[0] as GmoFeed;
        const ok = await feed.fetchCandles("BTC/JPY", "1h", 3).then(() => true, (e) => e as Error);
        return { ok, audits: store.listAudit({ type: "gmo.spot_candles" }) };
      } finally {
        rt.close();
      }
    };
    const paper = await run({});
    expect(paper.ok).toBe(true);
    expect(paper.audits).toHaveLength(1);
    expect(paper.audits[0].data).toMatchObject({ symbol: "BTC/JPY", spotSymbol: "BTC", mode: "paper" });
    const live = await run({}, liveSet);
    expect(live.ok).toBeInstanceOf(Error);
    expect((live.ok as Error).message).toContain("GMO_ALLOW_SPOT_CANDLES");
    expect(live.audits).toHaveLength(0);
    const liveAllowed = await run({ GMO_ALLOW_SPOT_CANDLES: "true" }, liveSet);
    expect(liveAllowed.ok).toBe(true);
    expect(liveAllowed.audits[0].data).toMatchObject({ mode: "live" });
  });

  it("live で GMO 以外の発注先を併用すると、GMO の新規エントリーは RiskManager が拒否する", async () => {
    const { fetchImpl } = createGmoMock({ "GET /v1/symbols": SYMBOLS_DATA });
    const liveSet = { mode: "live" as const, brokers: new Map(), brokerFor: () => { throw new Error("no broker"); } };
    const mk = async (venues: string) => {
      const rt = await buildRuntime(loadConfig({ VENUES: venues, GMO_SYMBOLS: "BTC_JPY", OANDA_API_TOKEN: "t", OANDA_ACCOUNT_ID: "a" }), {
        store: new MemoryStore(), intelSources: [], ai: null, fetchImpl, clock: { now: () => now }, brokerSet: liveSet,
      });
      const inst = rt.instruments.find((i) => i.venue === "gmo")!;
      const d = rt.risk.evaluateEntry({
        signal: { strategyId: "s", horizon: "short", symbol: inst.symbol, direction: "long", confidence: 1, expectedEdgeBps: 500, entry: { type: "market" }, stopLoss: 9_900, maxHoldMs: 1, reason: "", features: {} },
        instrument: inst, quote: { ts: now, bid: 9_999, ask: 10_001 }, equity: 1_000_000, available: 1_000_000, positions: [], riskMultiplier: 1, now,
      });
      rt.close();
      return d;
    };
    expect(await mk("gmo,oanda")).toMatchObject({ ok: false, reason: expect.stringContaining("GMO 以外の発注先 (oanda)") });
    expect((await mk("gmo,dex")).ok).toBe(true);
  });

  it("VENUES の検証に gmo を含む", () => {
    expect(() => loadConfig({ GMO_MAX_EFFECTIVE_LEVERAGE: "3" })).toThrow(/GMO_MAX_EFFECTIVE_LEVERAGE/);
    expect(() => loadConfig({ GMO_LEVERAGE_FEE_DAILY: "0.02" })).toThrow(/GMO_LEVERAGE_FEE_DAILY/);
    const c = loadConfig({});
    expect(c.env.GMO_SYMBOLS).toBe("BTC_JPY,ETH_JPY,XRP_JPY");
    expect(c.env.GMO_LEVERAGE_FEE_DAILY).toBe(0.0004);
    expect(c.env.GMO_MAX_EFFECTIVE_LEVERAGE).toBe(1);
  });
});
