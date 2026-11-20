import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { createGmoCheckClient, runGmoCheck } from "../src/market/gmo/check";
import { createGmoMock, fakeTime, SYMBOLS_DATA } from "./helpers/gmoMock";

/** `gmo check`: GET だけで応答の形を確かめる (すべてモック。注文・取消は呼ばない) */
const NOW = Date.UTC(2025, 0, 10, 12, 0);
const KEY = "AKEY1234567890abcdefXYZ";
const SECRET = "SSECRET0987654321zyxwvuTSR";

const kline = (ts: number) => ({ openTime: String(ts), open: "1", high: "1", low: "1", close: "1", volume: "0" });
function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /v1/status": { status: "OPEN" },
    "GET /v1/symbols": SYMBOLS_DATA,
    "GET /v1/ticker": (r: { query: URLSearchParams }) => [{ ask: "10010", bid: "10000", high: "1", last: "10005", low: "1", symbol: r.query.get("symbol"), timestamp: "2025-01-10T12:00:00.000Z", volume: "3" }],
    "GET /v1/orderbooks": (r: { query: URLSearchParams }) => ({ asks: [{ price: "10010", size: "1" }], bids: [{ price: "10000", size: "1" }], symbol: r.query.get("symbol") }),
    "GET /v1/klines": [kline(Date.UTC(2025, 0, 8, 21, 0)), kline(Date.UTC(2025, 0, 8, 21, 1))],
    "GET /v1/account/margin": { actualProfitLoss: "1000000", availableAmount: "900000", margin: "0", profitLoss: "0" },
    "GET /v1/positionSummary": { list: [] },
    "GET /v1/activeOrders": { list: [] },
    "GET /v1/latestExecutions": { list: [] },
    "POST /v1/order": "1",
    "POST /v1/closeBulkOrder": "1",
    "POST /v1/cancelOrder": null,
    ...over,
  };
}

async function run(env: Record<string, string>, over: Record<string, unknown> = {}) {
  const { fetchImpl, requests } = createGmoMock(routes(over));
  const t = fakeTime(NOW);
  const lines: string[] = [];
  const code = await runGmoCheck({ env, out: (s) => lines.push(s), clientOptions: { fetchImpl, now: t.now, sleep: t.sleep }, now: NOW });
  return { code, lines, text: lines.join("\n"), requests };
}

describe("gmo check", () => {
  it("公開 API を銘柄ごとに確かめ、POST は一度も出さない。キーが無ければ非公開 API は呼ばない", async () => {
    const r = await run({ GMO_SYMBOLS: "BTC_JPY,ETH_JPY" });
    expect(r.code).toBe(0);
    expect(r.requests.every((x) => x.method === "GET")).toBe(true);
    expect(r.requests.some((x) => x.url.includes("/private/"))).toBe(false);
    const paths = r.requests.map((x) => `${x.path}?${x.query.toString()}`);
    expect(paths).toContain("/v1/klines?symbol=BTC_JPY&interval=1min&date=20250109");
    expect(paths).toContain("/v1/klines?symbol=ETH_JPY&interval=4hour&date=2025");
    expect(r.text).toContain("非公開 API] GMO_API_KEY / GMO_API_SECRET が未設定");
    expect(r.text).toContain("06:00 JST");
    // 公式資料と未照合の前提 (要確認) を表示する: レバレッジ銘柄では SOK (post-only) を使わない
    expect(r.text).toContain("[要確認");
    expect(r.text).toMatch(/SOK \(Post-only\) は取引所現物だけ/);
  });

  it("キーがあれば読み取り専用の非公開 API だけを呼び、キー・秘密は表示しない", async () => {
    const r = await run({ GMO_SYMBOLS: "BTC_JPY", GMO_API_KEY: KEY, GMO_API_SECRET: SECRET });
    expect(r.code).toBe(0);
    expect(r.requests.filter((x) => x.method !== "GET")).toEqual([]);
    const priv = r.requests.filter((x) => x.url.includes("/private/")).map((x) => x.path);
    expect(new Set(priv)).toEqual(new Set(["/v1/account/margin", "/v1/positionSummary", "/v1/activeOrders", "/v1/latestExecutions"]));
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain(SECRET);
  });

  it("想定と違う項目は項目名を表示して NG。klines が無ければ現物銘柄を試す", async () => {
    const r = await run(
      { GMO_SYMBOLS: "BTC_JPY", GMO_API_KEY: KEY, GMO_API_SECRET: SECRET },
      {
        "GET /v1/account/margin": { actualProfitLoss: 1000000, availableAmount: "900000", margin: "0" },
        "GET /v1/klines": (q: { query: URLSearchParams }) =>
          q.query.get("symbol") === "BTC_JPY" ? { __status: 1, __messages: [{ message_code: "ERR-5207", message_string: "no data" }] } : [kline(NOW - 3_600_000)],
      },
    );
    expect(r.code).toBe(1);
    expect(r.text).toContain("data.actualProfitLoss");
    expect(r.text).toContain("data.profitLoss");
    expect(r.text).toContain("symbol=BTC&interval=1min");
    expect(r.requests.filter((x) => x.method !== "GET")).toEqual([]);
    expect(r.text).not.toContain(SECRET);
  });
});

describe("gmo check のクライアント", () => {
  it("POST (発注・決済・取消) は送信前に例外 (allowPost を渡されても上書きする)", async () => {
    const { fetchImpl, requests } = createGmoMock(routes());
    const c = createGmoCheckClient({ GMO_API_KEY: KEY, GMO_API_SECRET: SECRET }, { fetchImpl, allowPost: true } as never);
    const body = { symbol: "BTC_JPY", side: "BUY" as const, executionType: "MARKET" as const, size: "0.01" };
    await expect(c.postOrder(body)).rejects.toThrow(/POST/);
    await expect(c.postCloseBulkOrder(body)).rejects.toThrow(/POST/);
    await expect(c.postCancelOrder("1")).rejects.toThrow(/POST/);
    expect(requests).toHaveLength(0);
  });
});

describe("CLI: npm run trader -- gmo check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("main から実行でき、POST を出さない", async () => {
    const { fetchImpl, requests } = createGmoMock(routes());
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("GMO_SYMBOLS", "BTC_JPY");
    vi.stubEnv("GMO_API_KEY", KEY);
    vi.stubEnv("GMO_API_SECRET", SECRET);
    const out: string[] = [];
    const code = await main(["gmo", "check"], { out: (s) => out.push(s), err: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((x) => x.method === "GET")).toBe(true);
    expect(out.join("\n")).not.toContain(SECRET);
    expect(out.join("\n")).not.toContain(KEY);
  });

  it("未知のサブコマンドはエラー", async () => {
    const out: string[] = [];
    expect(await main(["gmo", "order"], { out: (s) => out.push(s), err: (s) => out.push(s) })).toBe(2);
  });
});
