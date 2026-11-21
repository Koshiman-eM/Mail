import { describe, expect, it } from "vitest";
import type { Candle } from "../src/core/types";
import { GeckoTerminalClient, pageCandlesBackward, parseGeckoOhlcv, parseGeckoPools, pickBestPool } from "../src/market/jupiter/gecko";
import { JupiterShapeError } from "../src/market/jupiter/parse";
import { createMockFetch, fakeClock, loadFixture, type RecordedCall } from "./fixtures/jupiter/mockFetch";

const MINT = "MemeAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111";
const M = 60_000;

describe("parseGeckoPools / pickBestPool (フィクスチャ)", () => {
  const pools = parseGeckoPools(loadFixture("gecko_pools.json"));

  it("address・reserve (文字列の数値)・base / quote の mint・dex を読む。address の無い要素は捨てる", () => {
    expect(pools).toHaveLength(4);
    expect(pools[0]).toEqual({
      address: "PooLAAAAbbbbCCCCddddEEEEffffGGGGhhhh1111", name: "SDOG / SOL", reserveUsd: 500000.12, baseMint: MINT,
      quoteMint: "So11111111111111111111111111111111111111112", dex: "raydium", createdAt: Date.parse("2025-01-01T00:00:00Z"),
    });
    expect(pools[3].baseMint).toBeUndefined();
  });

  it("そのトークンが base のプールのうち reserve が最大 (quote 側のプール・base 不明のプールは使わない)", () => {
    expect(pickBestPool(pools, MINT)?.address).toBe("PooLCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333");
    expect(pickBestPool(pools, MINT, { allowUnknownBase: true })?.address).toBe("PooLDDDDeeeeFFFFggggHHHHjjjjKKKKmmmm4444");
    expect(pickBestPool(pools, "nothing")).toBeUndefined();
  });

  it("data が配列でなければ JupiterShapeError", () => {
    expect(() => parseGeckoPools({ data: {} })).toThrow(JupiterShapeError);
  });
});

describe("parseGeckoOhlcv (フィクスチャ)", () => {
  it("秒 → ミリ秒・昇順・ts の重複は後勝ち。読めない行は数える", () => {
    const r = parseGeckoOhlcv(loadFixture("gecko_ohlcv.json"));
    expect(r.candles.map((c) => c.ts / 1000)).toEqual([1735689600, 1735689660, 1735689720, 1735689780]);
    expect(r.candles[1]).toEqual({ ts: 1735689660000, open: 1.01, high: 1.03, low: 1.0, close: 1.02, volume: 10 });
    expect(r.candles[2]).toEqual({ ts: 1735689720000, open: 1.02, high: 1.04, low: 1.01, close: 1.03, volume: 800 });
    expect(r.invalidRows).toBe(4); // "bad" / high < low / 短い行 / 配列でない
  });

  it("出来高が null なら 0", () => {
    const r = parseGeckoOhlcv({ data: { attributes: { ohlcv_list: [[1735689660, 1, 1, 1, 1, null]] } } });
    expect(r.candles[0].volume).toBe(0);
  });

  it("ohlcv_list が無ければ JupiterShapeError", () => {
    expect(() => parseGeckoOhlcv({ data: { attributes: {} } })).toThrow(JupiterShapeError);
    expect(() => parseGeckoOhlcv(null)).toThrow(JupiterShapeError);
  });
});

/** 1 分足の合成の履歴 (取引の無い分は除く)。ts の新しい順でページを返す */
function geckoHistory(fromSec: number, toSec: number, skip: (i: number) => boolean = () => false) {
  const rows: number[][] = [];
  for (let t = fromSec, i = 0; t <= toSec; t += 60, i++) if (!skip(i)) rows.push([t, 1 + i / 1000, 1.1 + i / 1000, 0.9 + i / 1000, 1 + i / 1000, i]);
  return (call: RecordedCall) => {
    const before = call.query.get("before_timestamp");
    const limit = Number(call.query.get("limit"));
    const eligible = rows.filter((r) => before === null || r[0] <= Number(before)); // 境界を含む実装を想定 (重複は除かれる)
    const page = eligible.slice(-limit).reverse();
    return { body: { data: { attributes: { ohlcv_list: page } } } };
  };
}

describe("pageCandlesBackward", () => {
  const mk = (sec: number): Candle => ({ ts: sec * 1000, open: 1, high: 1, low: 1, close: 1, volume: 0 });

  it("before に最古の時刻を入れてさかのぼり、昇順で末尾 limit 本", async () => {
    const all = Array.from({ length: 50 }, (_, i) => mk(1000 + i * 60));
    const befores: (number | undefined)[] = [];
    const r = await pageCandlesBackward(
      async (b, n) => {
        befores.push(b);
        return all.filter((c) => b === undefined || c.ts / 1000 <= b).slice(-n).reverse();
      },
      { limit: 25, pageSize: 10 },
    );
    expect(r.candles).toHaveLength(25);
    expect(r.candles[24].ts).toBe(all[49].ts);
    expect(r.candles.every((c, i) => i === 0 || r.candles[i - 1].ts < c.ts)).toBe(true);
    expect(befores[0]).toBeUndefined();
    expect(befores[1]).toBe(all[40].ts / 1000);
    expect(r.exhausted).toBe(false);
  });

  it("空・進まないページで先頭に達したとみなす", async () => {
    const all = Array.from({ length: 5 }, (_, i) => mk(1000 + i * 60));
    const r = await pageCandlesBackward(async (b, n) => all.filter((c) => b === undefined || c.ts / 1000 <= b).slice(-n), { limit: 100, pageSize: 3 });
    expect(r.candles).toHaveLength(5);
    expect(r.exhausted).toBe(true);
  });

  it("stopAt に達したら止める・maxPages で止める", async () => {
    const all = Array.from({ length: 100 }, (_, i) => mk(1000 + i * 60));
    const fetchPage = async (b: number | undefined, n: number) => all.filter((c) => b === undefined || c.ts / 1000 < b).slice(-n);
    const r = await pageCandlesBackward(fetchPage, { limit: 1, stopAt: all[85].ts, pageSize: 10 });
    expect(r.pages).toBe(2);
    expect(r.candles[0].ts).toBe(all[80].ts);
    const r2 = await pageCandlesBackward(fetchPage, { limit: 1000, pageSize: 10, maxPages: 3 });
    expect(r2.pages).toBe(3);
    expect(r2.candles).toHaveLength(30);
  });
});

describe("GeckoTerminalClient", () => {
  const NOW_SEC = 1_750_000_020; // 1 分の途中
  const setup = (route: (c: RecordedCall, i: number) => { status?: number; body?: unknown }, o: { callsPerMinute?: number } = {}) => {
    const clk = fakeClock(NOW_SEC * 1000);
    const m = createMockFetch(route, clk.now);
    const gecko = new GeckoTerminalClient({ fetchImpl: m.fetchImpl, now: clk.now, sleep: clk.sleep, callsPerMinute: o.callsPerMinute ?? 600, baseDelayMs: 10 });
    return { ...m, clk, gecko };
  };

  it("Accept ヘッダー・パス・クエリ (minute/5 → aggregate=5, currency=usd, token=base)", async () => {
    const { gecko, calls } = setup(() => ({ body: loadFixture("gecko_ohlcv.json") }));
    const c = await gecko.fetchOhlcvPage("POOL1", "5m", { beforeSec: 123, limit: 5000 });
    expect(c).toHaveLength(4);
    expect(calls[0].headers.accept).toBe("application/json;version=20230302");
    expect(calls[0].path).toBe("/api/v2/networks/solana/pools/POOL1/ohlcv/minute");
    expect(Object.fromEntries(calls[0].query)).toEqual({ aggregate: "5", before_timestamp: "123", limit: "1000", currency: "usd", token: "base" });
    await gecko.fetchOhlcvPage("POOL1", "4h");
    expect(calls[1].path.endsWith("/ohlcv/hour")).toBe(true);
    expect(calls[1].query.get("aggregate")).toBe("4");
    await expect(gecko.fetchOhlcvPage("POOL1", "1w")).rejects.toThrow(/1w/);
  });

  it("ページングして昇順・ms・重複なしで limit 本 (取引の無い分は空白のまま)", async () => {
    const start = NOW_SEC - 3000 * 60;
    const { gecko, calls } = setup(geckoHistory(start - (start % 60), NOW_SEC - (NOW_SEC % 60), (i) => i % 7 === 3));
    const c = await gecko.fetchOhlcv("POOL1", "1m", { limit: 2500 });
    expect(c).toHaveLength(2500);
    expect(calls.length).toBe(3);
    expect(c.every((x, i) => i === 0 || c[i - 1].ts < x.ts)).toBe(true);
    expect(c.every((x) => x.ts % 60_000 === 0)).toBe(true);
    expect(c[c.length - 1].ts).toBe((NOW_SEC - (NOW_SEC % 60)) * 1000);
  });

  it("確定足のキャッシュ: 同じ分の間は呼ばず、次の分は最新側だけ取り直す", async () => {
    const start = NOW_SEC - 200 * 60;
    let end = NOW_SEC - (NOW_SEC % 60);
    let route = geckoHistory(start - (start % 60), end);
    const { gecko, calls, clk } = setup((c) => route(c));
    const a = await gecko.fetchOhlcv("POOL1", "1m", { limit: 100 });
    expect(calls).toHaveLength(1);
    clk.advance(20_000); // 同じ分
    const b = await gecko.fetchOhlcv("POOL1", "1m", { limit: 100 });
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    clk.advance(60_000); // 次の分
    end += 60;
    route = geckoHistory(start - (start % 60), end);
    const c = await gecko.fetchOhlcv("POOL1", "1m", { limit: 100 });
    expect(calls).toHaveLength(2);
    expect(Number(calls[1].query.get("limit"))).toBeLessThan(10);
    expect(calls[1].query.get("before_timestamp")).toBeNull();
    expect(c[c.length - 1].ts).toBe(end * 1000);
    expect(c[0].ts).toBe(a[1].ts);
  });

  it("since: since 以降の先頭 limit 本", async () => {
    const start = NOW_SEC - 500 * 60;
    const s0 = start - (start % 60);
    const { gecko } = setup(geckoHistory(s0, NOW_SEC - (NOW_SEC % 60)));
    const since = (s0 + 100 * 60) * 1000;
    const c = await gecko.fetchOhlcv("POOL1", "1m", { limit: 10, since });
    expect(c).toHaveLength(10);
    expect(c[0].ts).toBe(since);
  });

  it("プールの検索はキャッシュし、404 はプールなし (短い期間キャッシュ)", async () => {
    const { gecko, calls, clk } = setup((c) => (c.path.includes("UNKNOWN") ? { status: 404, body: { errors: [] } } : { body: loadFixture("gecko_pools.json") }));
    expect((await gecko.bestPoolFor(MINT))?.address).toBe("PooLCCCCddddEEEEffffGGGGhhhhJJJJkkkk3333");
    await gecko.bestPoolFor(MINT);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`/api/v2/networks/solana/tokens/${MINT}/pools`);
    expect(await gecko.topPools("UNKNOWN")).toEqual([]);
    await gecko.topPools("UNKNOWN");
    expect(calls).toHaveLength(2);
    clk.advance(31 * M);
    await gecko.topPools("UNKNOWN");
    await gecko.topPools(MINT);
    expect(calls).toHaveLength(3);
    clk.advance(6 * 60 * M);
    await gecko.topPools(MINT);
    expect(calls).toHaveLength(4);
  });

  it("専用のレート制限 (既定 10 回/分 = 6 秒ごと)", async () => {
    const clk = fakeClock(0);
    const m = createMockFetch(() => ({ body: { data: [] } }), clk.now);
    const gecko = new GeckoTerminalClient({ fetchImpl: m.fetchImpl, now: clk.now, sleep: clk.sleep });
    for (const t of ["a", "b", "c"]) await gecko.topPools(t);
    expect(m.calls.map((c) => c.at)).toEqual([0, 6000, 12000]);
  });

  it("429 は再試行する", async () => {
    const { gecko, calls } = setup((_c, i) => (i === 0 ? { status: 429, body: {} } : { body: loadFixture("gecko_ohlcv.json") }));
    expect(await gecko.fetchOhlcvPage("POOL1", "1m")).toHaveLength(4);
    expect(calls).toHaveLength(2);
  });
});
