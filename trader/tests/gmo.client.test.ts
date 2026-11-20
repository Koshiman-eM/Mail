import { describe, expect, it } from "vitest";
import { HttpError } from "../src/core/http";
import {
  GmoApiError, GmoClient, GmoShapeError, gmoErrorKind, gmoSign, gmoToUnified, parseGmoResponse, parseGmoSymbols, RateLimiter, tickerSchema, unifiedToGmo,
} from "../src/market/gmo/client";
import { createGmoMock, fakeTime, gmoErr } from "./helpers/gmoMock";

/** GMOコインのクライアント (すべてモック。実 API へは送信しない) */
describe("gmoSign", () => {
  it("既知の入力に対する HMAC-SHA256 の hex (openssl で計算した値)", () => {
    const body = '{"symbol":"BTC_JPY","side":"BUY","executionType":"MARKET","size":"0.01"}';
    expect(gmoSign("test-secret", "1700000000000", "POST", "/v1/order", body)).toBe("9f0a22e279b8559ead879f9f683be09281f51c262fd6274dc434a863f2da5e85");
    expect(gmoSign("test-secret", "1700000000000", "GET", "/v1/orders", "")).toBe("1beffe117205dad5d58dcb0ba605d478a04a92c881301bd88c3ad1dec9c5c63c");
  });

  it("クエリ文字列は署名に含めない", () => {
    expect(gmoSign("test-secret", "1700000000000", "GET", "/v1/orders?orderId=123", "")).toBe(gmoSign("test-secret", "1700000000000", "GET", "/v1/orders", ""));
  });
});

describe("parseGmoResponse", () => {
  const ok = { status: 0, data: [{ ask: "100", bid: "99", high: "101", last: "100", low: "98", symbol: "BTC_JPY", timestamp: "2025-01-01T00:00:00.000Z", volume: "1.5" }] };

  it("正常な応答は検証して返す (時刻はミリ秒)", () => {
    const d = parseGmoResponse("/v1/ticker", ok, tickerSchema);
    expect(d[0].ask).toBe("100");
    expect(d[0].timestamp).toBe(Date.parse("2025-01-01T00:00:00.000Z"));
  });

  it("status ≠ 0 は GmoApiError (message_code を含む)", () => {
    const e = (() => {
      try {
        parseGmoResponse("/v1/order", { status: 1, messages: [{ message_code: "ERR-201", message_string: "Insufficient funds" }] }, tickerSchema);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(GmoApiError);
    expect((e as GmoApiError).codes).toEqual(["ERR-201"]);
    expect((e as GmoApiError).kind).toBe("insufficient");
    expect((e as Error).message).toContain("ERR-201");
  });

  it("メンテナンス・リクエスト過多の分類", () => {
    expect(gmoErrorKind(["ERR-5201"])).toBe("maintenance");
    expect(gmoErrorKind(["ERR-5003"])).toBe("rate_limit");
    expect(gmoErrorKind(["ERR-999"])).toBe("other");
  });

  it("形が違えば項目名つきの GmoShapeError (推測で進めない)", () => {
    const bad = { status: 0, data: [{ ...ok.data[0], ask: 100, bid: undefined }] };
    try {
      parseGmoResponse("/v1/ticker", bad, tickerSchema);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmoShapeError);
      const issues = (e as GmoShapeError).issues.join("\n");
      expect(issues).toContain("data.0.ask");
      expect(issues).toContain("data.0.bid");
    }
    expect(() => parseGmoResponse("/v1/ticker", { data: [] }, tickerSchema)).toThrow(GmoShapeError); // status が無い
    expect(() => parseGmoResponse("/v1/ticker", { status: 0, data: [{ ...ok.data[0], last: "1e5" }] }, tickerSchema)).toThrow(GmoShapeError);
  });
});

describe("GmoClient", () => {
  it("非公開 API はヘッダー 3 つで署名し、path に /private とクエリを含めない", async () => {
    const t = fakeTime(1_700_000_000_000);
    const { fetchImpl, requests } = createGmoMock({ "GET /v1/orders": { list: [] } });
    const c = new GmoClient({ apiKey: "k", apiSecret: "test-secret", fetchImpl, now: t.now, sleep: t.sleep });
    await c.getOrders("123");
    const r = requests[0];
    expect(r.url).toBe("https://api.coin.z.com/private/v1/orders?orderId=123");
    expect(r.headers["api-key"]).toBe("k");
    expect(r.headers["api-timestamp"]).toBe("1700000000000");
    expect(r.headers["api-sign"]).toBe("1beffe117205dad5d58dcb0ba605d478a04a92c881301bd88c3ad1dec9c5c63c");
  });

  it("POST の本文を署名に含める", async () => {
    const t = fakeTime(1_700_000_000_000);
    const { fetchImpl, requests } = createGmoMock({ "POST /v1/order": "555" });
    const c = new GmoClient({ apiKey: "k", apiSecret: "test-secret", fetchImpl, now: t.now, sleep: t.sleep, allowPost: true });
    expect(await c.postOrder({ symbol: "BTC_JPY", side: "BUY", executionType: "MARKET", size: "0.01" })).toBe("555");
    expect(requests[0].body).toBe('{"symbol":"BTC_JPY","side":"BUY","executionType":"MARKET","size":"0.01"}');
    expect(requests[0].headers["api-sign"]).toBe("9f0a22e279b8559ead879f9f683be09281f51c262fd6274dc434a863f2da5e85");
  });

  it("allowPost を明示しないクライアントは POST (発注・決済・取消) を送信前に例外にする", async () => {
    const t = fakeTime();
    const { fetchImpl, requests } = createGmoMock({ "POST /v1/order": "1", "POST /v1/closeBulkOrder": "1", "POST /v1/cancelOrder": null });
    const c = new GmoClient({ apiKey: "k", apiSecret: "s", fetchImpl, now: t.now, sleep: t.sleep });
    const body = { symbol: "BTC_JPY", side: "BUY" as const, executionType: "MARKET" as const, size: "0.01" };
    await expect(c.postOrder(body)).rejects.toThrow(/POST/);
    await expect(c.postCloseBulkOrder(body)).rejects.toThrow(/POST/);
    await expect(c.postCancelOrder("1")).rejects.toThrow(/POST/);
    await expect(new GmoClient({ apiKey: "k", apiSecret: "s", fetchImpl, allowPost: false }).postOrder(body)).rejects.toThrow(/POST/);
    expect(requests).toHaveLength(0);
  });

  it("一覧の data は {} か { list } (ページングのある API は pagination も) だけ。未知のキー・必須の項目の欠けは例外", async () => {
    const t = fakeTime();
    const row = { averagePositionRate: "1", positionLossGain: "0", side: "BUY", sumOrderQuantity: "0", sumPositionQuantity: "0.01", symbol: "BTC_JPY" };
    let data: unknown = {};
    const { fetchImpl } = createGmoMock({ "GET /v1/positionSummary": () => data, "GET /v1/activeOrders": () => data });
    const c = new GmoClient({ apiKey: "k", apiSecret: "s", fetchImpl, now: t.now, sleep: t.sleep });
    expect((await c.getPositionSummary("BTC_JPY")).list).toEqual([]);
    data = { list: [row] };
    expect((await c.getPositionSummary("BTC_JPY")).list).toHaveLength(1);
    data = { list: [row], unexpected: true };
    await expect(c.getPositionSummary("BTC_JPY")).rejects.toThrow(/unexpected|未知|Unrecognized/i);
    data = { pagination: { currentPage: 1, count: 1 }, list: [row] };
    await expect(c.getPositionSummary("BTC_JPY")).rejects.toBeInstanceOf(GmoShapeError); // ページングの無い API
    data = { pagination: { currentPage: 1, count: 0 }, list: [] };
    expect((await c.getActiveOrders("BTC_JPY")).list).toEqual([]);
    data = { list: [{ ...row, sumOrderQuantity: undefined }] };
    try {
      await c.getPositionSummary("BTC_JPY");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmoShapeError);
      expect((e as GmoShapeError).issues.join("\n")).toContain("data.list.0.sumOrderQuantity");
    }
    data = [];
    await expect(c.getPositionSummary("BTC_JPY")).rejects.toBeInstanceOf(GmoShapeError);
  });

  it("キーが無ければ非公開 API は送信せずに例外", async () => {
    const { fetchImpl, requests } = createGmoMock({});
    await expect(new GmoClient({ fetchImpl }).getMargin()).rejects.toThrow(/GMO_API_KEY/);
    expect(requests).toHaveLength(0);
  });

  it("POST は通信エラーでも再試行しない (二重発注の防止)。GET は署名し直して再試行する", async () => {
    const t = fakeTime();
    let n = 0;
    const { fetchImpl, requests } = createGmoMock({
      "POST /v1/order": () => new Error("socket hang up"),
      "GET /v1/account/margin": () => (n++ === 0 ? new Error("ECONNRESET") : { actualProfitLoss: "1000", availableAmount: "900", margin: "0", profitLoss: "0" }),
    });
    const c = new GmoClient({ apiKey: "k", apiSecret: "s", fetchImpl, now: t.now, sleep: t.sleep, allowPost: true });
    await expect(c.postOrder({ symbol: "BTC_JPY", side: "BUY", executionType: "MARKET", size: "0.01" })).rejects.toThrow();
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    const m = await c.getMargin();
    expect(m.actualProfitLoss).toBe("1000");
    const gets = requests.filter((r) => r.method === "GET");
    expect(gets).toHaveLength(2);
    expect(gets[0].headers["api-timestamp"]).not.toBe(gets[1].headers["api-timestamp"]);
  });

  it("エラー応答 (メンテナンス) は GmoApiError。HTTP エラーの本文が GMO 形式でも GmoApiError", async () => {
    const t = fakeTime();
    const { fetchImpl } = createGmoMock({
      "GET /v1/status": gmoErr("ERR-5201", "MAINTENANCE"),
      "GET /v1/symbols": { __http: 400, __body: { status: 5, messages: [{ message_code: "ERR-5003", message_string: "Requests are too many" }] } },
      "GET /v1/ticker": { __raw: "<html>gateway</html>" },
    });
    const c = new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep });
    await expect(c.getStatus()).rejects.toMatchObject({ name: "GmoApiError", kind: "maintenance" });
    await expect(c.getSymbols()).rejects.toMatchObject({ name: "GmoApiError", kind: "rate_limit", httpStatus: 400 });
    await expect(c.getTicker("BTC_JPY")).rejects.toBeInstanceOf(GmoShapeError);
  });

  it("HTTP 5xx は公開 API で再試行し、最後は HttpError", async () => {
    const t = fakeTime();
    const { fetchImpl, requests } = createGmoMock({ "GET /v1/status": { __http: 502, __body: "bad gateway" } });
    const c = new GmoClient({ fetchImpl, now: t.now, sleep: t.sleep });
    await expect(c.getStatus()).rejects.toBeInstanceOf(HttpError);
    expect(requests).toHaveLength(4);
  });
});

describe("RateLimiter", () => {
  it("1 秒に 6 回までに抑える", async () => {
    const t = fakeTime(0);
    const rl = new RateLimiter(6, 1000, t.now, t.sleep);
    const stamps: number[] = [];
    for (let i = 0; i < 13; i++) {
      await rl.acquire();
      stamps.push(t.now());
    }
    for (let i = 6; i < stamps.length; i++) expect(stamps[i] - stamps[i - 6]).toBeGreaterThanOrEqual(1000);
    expect(stamps.slice(0, 6).every((s) => s === 0)).toBe(true);
  });
});

describe("シンボル変換", () => {
  it("統一シンボルと GMO の表記", () => {
    expect(gmoToUnified("BTC_JPY")).toBe("BTC/JPY");
    expect(gmoToUnified("BTC")).toBeUndefined();
    expect(unifiedToGmo("btc/jpy")).toBe("BTC_JPY");
    expect(parseGmoSymbols(" BTC_JPY, eth_jpy ,BTC_JPY")).toEqual(["BTC_JPY", "ETH_JPY"]);
    expect(() => parseGmoSymbols("BTC")).toThrow(/レバレッジ銘柄/);
  });
});
