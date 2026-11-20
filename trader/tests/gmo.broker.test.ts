import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config";
import { HttpError } from "../src/core/http";
import type { Instrument, OrderRequest } from "../src/core/types";
import { LiveModeRequiredError } from "../src/execution/guard";
import { classifyGmoError, GmoBroker } from "../src/execution/gmoBroker";
import { createBrokers } from "../src/execution/router";
import { createGmoMock, fakeTime, gmoErr, type RecordedRequest, type RouteValue } from "./helpers/gmoMock";

/**
 * GMOコインの実口座アダプター (すべてモック。実 API へは送信しない)。
 * アダプターは NODE_ENV=test では生成できないので、各テストの間だけ production にする (既存のアダプターのテストと同じ)。
 */
let origEnv: string | undefined;
beforeEach(() => {
  origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
});
afterEach(() => {
  process.env.NODE_ENV = origEnv;
});

const BTC: Instrument = {
  symbol: "BTC/JPY", venue: "gmo", assetClass: "crypto", baseCurrency: "BTC", quoteCurrency: "JPY",
  tickSize: 1, lotSize: 0.01, minQty: 0.01, takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
  meta: { gmoSymbol: "BTC_JPY", gmoSpotSymbol: "BTC", leverage: 1, holdingFeeDaily: 0.0004 },
};
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ clientId: "c1", symbol: "BTC/JPY", side: "buy", type: "market", qty: "0.015", strategyId: "s", ...o });
const T = Date.UTC(2025, 0, 10, 12, 0);

const summary = (buy?: [string, string?], sell?: [string, string?], symbol = "BTC_JPY") => ({
  list: [
    ...(buy ? [{ averagePositionRate: "10000000", positionLossGain: "0", side: "BUY", sumOrderQuantity: buy[1] ?? "0", sumPositionQuantity: buy[0], symbol }] : []),
    ...(sell ? [{ averagePositionRate: "10100000", positionLossGain: "0", side: "SELL", sumOrderQuantity: sell[1] ?? "0", sumPositionQuantity: sell[0], symbol }] : []),
  ],
});
const openPos = (rows: [side: "BUY" | "SELL", size: string][]) => ({
  pagination: { currentPage: 1, count: rows.length },
  list: rows.map(([side, size], i) => ({
    positionId: 100 + i, symbol: "BTC_JPY", side, size, orderdSize: "0", price: "10000000", lossGain: "0", leverage: "2", losscutPrice: "0", timestamp: "2025-01-10T11:00:00.000Z",
  })),
});
/** 建玉の routes (positionSummary と openPositions を一致させる) */
const positions = (buy?: string, sell?: string): Record<string, RouteValue> => ({
  "GET /v1/positionSummary": summary(buy ? [buy] : undefined, sell ? [sell] : undefined),
  "GET /v1/openPositions": openPos([...(buy ? [["BUY", buy] as ["BUY", string]] : []), ...(sell ? [["SELL", sell] as ["SELL", string]] : [])]),
});
const order = (o: Record<string, unknown> = {}) => ({
  orderId: 1001, rootOrderId: 1001, symbol: "BTC_JPY", side: "BUY", orderType: "NORMAL", executionType: "MARKET", settleType: "OPEN",
  size: "0.03", executedSize: "0.03", price: "0", losscutPrice: "0", status: "EXECUTED", timeInForce: "FAK", timestamp: "2025-01-10T12:00:00.100Z", ...o,
});
const exec = (id: number, size: string, price: string, fee: string, o: Record<string, unknown> = {}) => ({
  executionId: id, orderId: 1001, positionId: 7, symbol: "BTC_JPY", side: "BUY", settleType: "OPEN", size, price, lossGain: "0", fee, timestamp: "2025-01-10T12:00:00.200Z", ...o,
});
const NO_ACTIVE: Record<string, RouteValue> = { "GET /v1/activeOrders": { list: [] } };

function setup(routes: Record<string, RouteValue>) {
  const t = fakeTime(T);
  const mock = createGmoMock(routes);
  const broker = new GmoBroker({ mode: "live", clientOptions: { apiKey: "k", apiSecret: "s", fetchImpl: mock.fetchImpl, now: t.now, sleep: t.sleep }, instruments: [BTC] });
  return { broker, ...mock, t };
}
const posts = (rs: RecordedRequest[]) => rs.filter((r) => r.method === "POST");

describe("GmoBroker の生成", () => {
  it("paper モード・テスト中は生成を拒否する (assertLive)", () => {
    const clientOptions = { apiKey: "k", apiSecret: "s", fetchImpl: createGmoMock({}).fetchImpl };
    expect(() => new GmoBroker({ mode: "paper", clientOptions, instruments: [BTC] })).toThrow(LiveModeRequiredError);
    process.env.NODE_ENV = "test";
    expect(() => new GmoBroker({ mode: "live", clientOptions, instruments: [BTC] })).toThrow(LiveModeRequiredError);
  });

  it("router: live でキーが無ければエラー、paper では実アダプターを作らない", () => {
    const live = { ...loadConfig({ VENUES: "gmo" }), mode: "live" as const };
    expect(() => createBrokers(live, [BTC])).toThrow(/GMO_API_KEY/);
    const withKey = { ...loadConfig({ VENUES: "gmo", GMO_API_KEY: "k", GMO_API_SECRET: "s" }), mode: "live" as const };
    const set = createBrokers(withKey, [BTC], { fetchImpl: createGmoMock({}).fetchImpl });
    expect(set.brokerFor("BTC/JPY")).toBeInstanceOf(GmoBroker);
    const paper = createBrokers(loadConfig({ VENUES: "gmo" }), [BTC]);
    expect(paper.mode).toBe("paper");
    expect(paper.brokerFor("BTC/JPY").venue).toBe("paper");
  });
});

describe("GmoBroker.placeOrder (新規)", () => {
  it("新規は /v1/order。数量は sizeStep に切り捨て、protectiveStop は送らない", async () => {
    const { broker, requests } = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": "1001" });
    const r = await broker.placeOrder(req({ protectiveStop: 9_000_000 }));
    expect(r).toMatchObject({ orderId: "1001", status: "open" });
    const p = posts(requests);
    expect(p).toHaveLength(1);
    expect(p[0].path).toBe("/v1/order");
    expect(JSON.parse(p[0].body)).toEqual({ symbol: "BTC_JPY", side: "BUY", executionType: "MARKET", size: "0.01" });
    // 送る前に建玉 (2 種類) と有効注文を確かめる
    const gets = requests.filter((x) => x.method === "GET").map((x) => x.path);
    expect(gets).toEqual(expect.arrayContaining(["/v1/positionSummary", "/v1/openPositions", "/v1/activeOrders"]));
  });

  it("売りから新規建て (空売り) ができる。指値は刻みにそろえ (売りは切り上げ)、IOC は FAK", async () => {
    const { broker, requests } = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": "1002" });
    const r = await broker.placeOrder(req({ side: "sell", type: "limit", limitPrice: 10_000_000.4, tif: "IOC", qty: "0.02" }));
    expect(r.status).toBe("open");
    expect(JSON.parse(posts(requests)[0].body)).toEqual({ symbol: "BTC_JPY", side: "SELL", executionType: "LIMIT", size: "0.02", price: "10000001", timeInForce: "FAK" });
  });

  it("反対側の建玉があるときの新規は送らずに拒否 (両建て防止)", async () => {
    const { broker, requests } = setup({ ...positions("0.05"), ...NO_ACTIVE });
    const r = await broker.placeOrder(req({ side: "sell" }));
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("両建て");
    expect(posts(requests)).toHaveLength(0);
  });

  it("反対方向の新規注文 (settleType OPEN) が未約定で残っていれば拒否。決済注文 (CLOSE) や同じ方向は妨げない", async () => {
    const a = setup({ ...positions(), "GET /v1/activeOrders": { list: [order({ orderId: 9, side: "SELL", status: "ORDERED", executedSize: "0", executionType: "LIMIT", price: "11000000" })] } });
    const r = await a.broker.placeOrder(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("反対方向の新規注文");
    expect(posts(a.requests)).toHaveLength(0);
    const b = setup({
      ...positions(),
      "GET /v1/activeOrders": { list: [order({ orderId: 9, side: "SELL", settleType: "CLOSE", status: "ORDERED", executedSize: "0" }), order({ orderId: 10, side: "BUY", status: "ORDERED", executedSize: "0" })] },
      "POST /v1/order": "1003",
    });
    expect((await b.broker.placeOrder(req())).status).toBe("open");
  });

  it("建玉・有効注文を照会できなければ送らない", async () => {
    for (const routes of [
      { "GET /v1/positionSummary": { __http: 500, __body: "x" }, ...NO_ACTIVE },
      { ...positions(), "GET /v1/activeOrders": { __http: 500, __body: "x" } },
      { ...positions(), "GET /v1/activeOrders": { list: [], extra: 1 } }, // 未知のキー
    ] as Record<string, RouteValue>[]) {
      const { broker, requests } = setup(routes);
      const r = await broker.placeOrder(req());
      expect(r.status).toBe("rejected");
      expect(posts(requests)).toHaveLength(0);
    }
  });

  it("positionSummary と openPositions の建玉数量が食い違えば送らない", async () => {
    const { broker, requests } = setup({ "GET /v1/positionSummary": summary(), "GET /v1/openPositions": openPos([["SELL", "0.01"]]), ...NO_ACTIVE });
    const r = await broker.placeOrder(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("食い違います");
    expect(posts(requests)).toHaveLength(0);
  });

  it("応答に要求と違う銘柄の要素があれば読み飛ばさずに中止する", async () => {
    const { broker, requests } = setup({ "GET /v1/positionSummary": summary(undefined, ["0.05"], "ETH_JPY"), "GET /v1/openPositions": openPos([]), ...NO_ACTIVE });
    const r = await broker.placeOrder(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("要求と違う銘柄");
    expect(posts(requests)).toHaveLength(0);
  });

  it("確認と送信は銘柄ごとに直列化する (並行した新規の 2 本目は 1 本目の結果を見てから確認する)", async () => {
    let filled = false;
    const routes: Record<string, RouteValue> = {
      "GET /v1/positionSummary": () => (filled ? summary(["0.01"]) : summary()),
      "GET /v1/openPositions": () => (filled ? openPos([["BUY", "0.01"]]) : openPos([])),
      ...NO_ACTIVE,
      "POST /v1/order": () => {
        filled = true; // 1 本目の買いが約定した
        return "1001";
      },
    };
    const { broker, requests } = setup(routes);
    const [a, b] = await Promise.all([broker.placeOrder(req({ clientId: "a" })), broker.placeOrder(req({ clientId: "b", side: "sell" }))]);
    expect(a.status).toBe("open");
    expect(b.status).toBe("rejected"); // 直列化しないと両方の確認が先に走り、両建てになる
    expect(posts(requests)).toHaveLength(1);
  });

  it("数量が刻み・最小未満なら送らない", async () => {
    const { broker, requests } = setup({ ...positions(), ...NO_ACTIVE });
    expect((await broker.placeOrder(req({ qty: "0.009" }))).status).toBe("rejected");
    expect(posts(requests)).toHaveLength(0);
  });

  it("取引所のエラー応答と HTTP 400/401/403/404/429 は rejected。408 などその他は状態不明 (例外)", async () => {
    const a = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": gmoErr("ERR-201", "Insufficient funds") });
    const r = await a.broker.placeOrder(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("残高不足");
    const b = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": gmoErr("ERR-5201", "MAINTENANCE") });
    expect((await b.broker.placeOrder(req())).reason).toContain("メンテナンス");
    for (const st of [400, 401, 403, 404, 429]) {
      const c = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": { __http: st, __body: "plain" } });
      expect((await c.broker.placeOrder(req())).status).toBe("rejected");
    }
    const d = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": { __http: 408, __body: "timeout" } });
    await expect(d.broker.placeOrder(req())).rejects.toBeInstanceOf(HttpError);
    expect(classifyGmoError(new HttpError(409, "u", ""))).toBe("unknown");
    expect(classifyGmoError(new HttpError(502, "u", ""))).toBe("unknown");
  });

  it("通信エラー・5xx・応答の形の違いは状態不明として例外 (再送しない)", async () => {
    for (const v of [new Error("socket hang up"), { __http: 503, __body: "unavailable" }, { __raw: "not json" }]) {
      const { broker, requests } = setup({ ...positions(), ...NO_ACTIVE, "POST /v1/order": v });
      await expect(broker.placeOrder(req())).rejects.toBeTruthy();
      expect(posts(requests)).toHaveLength(1);
    }
  });
});

describe("GmoBroker.placeOrder (reduceOnly = closeBulkOrder)", () => {
  it("/v1/closeBulkOrder に送り、数量は「建玉 − 決済注文中」で上限にする", async () => {
    const { broker, requests } = setup({ "GET /v1/positionSummary": summary(["0.05", "0.02"]), "POST /v1/closeBulkOrder": "2001" });
    const r = await broker.placeOrder(req({ side: "sell", reduceOnly: true, qty: "0.1" }));
    expect(r).toMatchObject({ orderId: "2001", status: "open" });
    const p = posts(requests);
    expect(p.map((x) => x.path)).toEqual(["/v1/closeBulkOrder"]);
    expect(JSON.parse(p[0].body)).toEqual({ symbol: "BTC_JPY", side: "SELL", executionType: "MARKET", size: "0.03" });
  });

  it("「建玉 − 決済注文中」が 0 以下でも、有効注文に決済 (CLOSE) が無ければ建玉の数量で送る", async () => {
    const { broker, requests } = setup({ "GET /v1/positionSummary": summary(["0.05", "0.05"]), ...NO_ACTIVE, "POST /v1/closeBulkOrder": "2002" });
    const r = await broker.placeOrder(req({ side: "sell", reduceOnly: true, qty: "0.05" }));
    expect(r.status).toBe("open");
    expect(JSON.parse(posts(requests)[0].body).size).toBe("0.05");
  });

  it("決済 (CLOSE) の注文が既にあれば従来どおり差し引き、追加で決済できなければ送らない", async () => {
    const { broker, requests } = setup({
      "GET /v1/positionSummary": summary(["0.05", "0.05"]),
      "GET /v1/activeOrders": { list: [order({ orderId: 77, side: "SELL", settleType: "CLOSE", status: "ORDERED", executedSize: "0", size: "0.05" })] },
    });
    const r = await broker.placeOrder(req({ side: "sell", reduceOnly: true, qty: "0.05" }));
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("決済注文が既に出ている");
    expect(posts(requests)).toHaveLength(0);
  });

  it("決済対象が無ければ送らない。決済数量が最小発注数量未満なら明確な理由で拒否 (手動で決済が必要)", async () => {
    const a = setup({ "GET /v1/positionSummary": summary(undefined, ["0.05"]) });
    expect((await a.broker.placeOrder(req({ side: "sell", reduceOnly: true }))).status).toBe("rejected");
    expect(posts(a.requests)).toHaveLength(0);
    const minQty = { ...BTC, minQty: 0.05 };
    const t = fakeTime(T);
    const mock = createGmoMock({ "GET /v1/positionSummary": summary(["0.03"]) });
    const broker = new GmoBroker({ mode: "live", clientOptions: { apiKey: "k", apiSecret: "s", fetchImpl: mock.fetchImpl, now: t.now, sleep: t.sleep }, instruments: [minQty] });
    const r = await broker.placeOrder(req({ side: "sell", reduceOnly: true, qty: "0.03" }));
    expect(r.status).toBe("rejected");
    expect(r.reason).toContain("最小発注数量");
    expect(r.reason).toContain("手動で決済が必要");
    expect(posts(mock.requests)).toHaveLength(0);
  });
});

describe("GmoBroker.getOrder", () => {
  it("orders と executions から約定数量・平均価格・手数料を集計する", async () => {
    const { broker } = setup({
      "GET /v1/orders": { list: [order()] },
      "GET /v1/executions": { list: [exec(1, "0.01", "10000000", "40"), exec(2, "0.02", "10000300", "80")] },
    });
    const r = await broker.getOrder("c1", "BTC/JPY", "1001");
    expect(r?.status).toBe("filled");
    expect(r?.fills).toHaveLength(1);
    expect(r?.fills[0].qty).toBe("0.03");
    expect(r?.fills[0].price).toBe(10000200);
    expect(r?.fills[0].fee).toBe("120");
    expect(r?.fills[0].liquidity).toBe("taker");
  });

  it("約定明細が足りなければ確定させない。未約定は open、取消は canceled。形の違いは例外", async () => {
    const a = setup({ "GET /v1/orders": { list: [order()] }, "GET /v1/executions": { list: [exec(1, "0.01", "10000000", "4")] } });
    expect((await a.broker.getOrder("c1", "BTC/JPY", "1001"))?.status).toBe("open");
    const b = setup({ "GET /v1/orders": { list: [order({ status: "ORDERED", executedSize: "0" })] } });
    expect((await b.broker.getOrder("c1", "BTC/JPY", "1001"))?.status).toBe("open");
    const c = setup({ "GET /v1/orders": { list: [order({ status: "CANCELED", executedSize: "0" })] } });
    expect((await c.broker.getOrder("c1", "BTC/JPY", "1001"))?.status).toBe("canceled");
    const d = setup({ "GET /v1/orders": {} }); // 該当なし
    expect(await d.broker.getOrder("c1", "BTC/JPY", "1001")).toBeUndefined();
    const e = setup({ "GET /v1/orders": { list: [order({ status: "UNKNOWN_STATE" })] } });
    await expect(e.broker.getOrder("c1", "BTC/JPY", "1001")).rejects.toThrow(/形/);
    const { timeInForce: _drop, ...noTif } = order();
    const f = setup({ "GET /v1/orders": { list: [noTif] } }); // 必須の項目が無い
    await expect(f.broker.getOrder("c1", "BTC/JPY", "1001")).rejects.toThrow(/timeInForce/);
  });

  it("orderId が無いときは hint で有効注文と最近の約定を突き合わせ、候補 1 件だけ採用する", async () => {
    const createdAt = T;
    const hint = { createdAt, side: "buy" as const, qty: "0.03" };
    const a = setup({
      "GET /v1/activeOrders": { list: [order({ orderId: 2000, side: "SELL", status: "ORDERED", executedSize: "0" })] },
      "GET /v1/latestExecutions": { list: [exec(1, "0.03", "10000000", "0")] },
      "GET /v1/orders": (q: { query: URLSearchParams }) => ({ list: q.query.get("orderId") === "1001" ? [order()] : [] }),
      "GET /v1/executions": { list: [exec(1, "0.03", "10000000", "0")] },
    });
    const r = await a.broker.getOrder("c1", "BTC/JPY", undefined, hint);
    expect(r?.orderId).toBe("1001");
    expect(r?.status).toBe("filled");
    expect(posts(a.requests)).toHaveLength(0);

    const b = setup({
      "GET /v1/activeOrders": { list: [order({ orderId: 3001, status: "ORDERED", executedSize: "0" }), order({ orderId: 3002, status: "ORDERED", executedSize: "0" })] },
      "GET /v1/latestExecutions": { list: [] },
    });
    await expect(b.broker.getOrder("c1", "BTC/JPY", undefined, hint)).rejects.toThrow(/2 件/);

    const c = setup({
      "GET /v1/activeOrders": { list: [order({ orderId: 4001, status: "ORDERED", executedSize: "0", timestamp: "2025-01-10T11:00:00.000Z" }), order({ orderId: 4002, size: "0.5", status: "ORDERED", executedSize: "0" })] },
      "GET /v1/latestExecutions": { list: [] },
    });
    expect(await c.broker.getOrder("c1", "BTC/JPY", undefined, hint)).toBeUndefined();
    await expect(c.broker.getOrder("c1", "BTC/JPY")).rejects.toThrow(/hint/);
  });

  it("hint 照会: 時刻窓の外の約定は注文を照会しない。窓の中の注文が 20 件を超えたら例外", async () => {
    const hint = { createdAt: T, side: "buy" as const, qty: "0.03" };
    const old = Array.from({ length: 50 }, (_, i) => exec(i, "0.01", "1", "0", { orderId: 5000 + i, timestamp: "2025-01-10T09:00:00.000Z" }));
    const a = setup({ ...NO_ACTIVE, "GET /v1/latestExecutions": { list: old }, "GET /v1/orders": { list: [] } });
    expect(await a.broker.getOrder("c1", "BTC/JPY", undefined, hint)).toBeUndefined();
    expect(a.requests.filter((r) => r.path === "/v1/orders")).toHaveLength(0);
    const many = Array.from({ length: 21 }, (_, i) => exec(i, "0.01", "1", "0", { orderId: 6000 + i }));
    const b = setup({ ...NO_ACTIVE, "GET /v1/latestExecutions": { list: many }, "GET /v1/orders": { list: [] } });
    await expect(b.broker.getOrder("c1", "BTC/JPY", undefined, hint)).rejects.toThrow(/上限 20/);
    expect(b.requests.filter((r) => r.path === "/v1/orders")).toHaveLength(0);
  });

  it("発注が通信エラーで終わった注文も、hint 照会で見つけられる", async () => {
    const { broker } = setup({
      ...positions(),
      "POST /v1/order": new Error("timeout"),
      "GET /v1/activeOrders": { list: [order({ orderId: 5001, size: "0.01", status: "ORDERED", executedSize: "0" })] },
      "GET /v1/latestExecutions": { list: [] },
      "GET /v1/orders": { list: [order({ orderId: 5001, size: "0.01", status: "ORDERED", executedSize: "0" })] },
    });
    // 発注前の確認では有効注文 (同じ方向の新規) があっても妨げない
    await expect(broker.placeOrder(req({ qty: "0.015" }))).rejects.toThrow();
    // engine は発注数量 0.015 を hint で渡す。送った数量 (0.01 に丸めた) でも突き合わせる
    const r = await broker.getOrder("c1", "BTC/JPY", undefined, { createdAt: T, side: "buy", qty: "0.015" });
    expect(r).toMatchObject({ orderId: "5001", status: "open" });
  });
});

describe("GmoBroker の口座", () => {
  it("getBalance は account/margin、getPositions は positionSummary をネット (BUY 正・SELL 負)", async () => {
    const { broker } = setup({
      "GET /v1/account/margin": { actualProfitLoss: "1000500", availableAmount: "800000", margin: "200000", profitLoss: "500" },
      ...positions(undefined, "0.02"),
    });
    expect(await broker.getBalance()).toEqual({ currency: "JPY", equity: "1000500", available: "800000" });
    expect(await broker.getPositions()).toEqual([{ symbol: "BTC/JPY", qty: "-0.02", avgPrice: 10100000 }]);
  });

  it("getPositions: 両建て・openPositions との食い違い・違う銘柄の要素は例外", async () => {
    await expect(setup(positions("0.01", "0.03")).broker.getPositions()).rejects.toThrow(/両建て/);
    await expect(setup({ "GET /v1/positionSummary": summary(["0.02"]), "GET /v1/openPositions": openPos([["BUY", "0.01"]]) }).broker.getPositions()).rejects.toThrow(/食い違/);
    await expect(setup({ "GET /v1/positionSummary": summary(["0.02"], undefined, "ETH_JPY"), "GET /v1/openPositions": openPos([]) }).broker.getPositions()).rejects.toThrow(/要求と違う銘柄/);
    await expect(setup({ "GET /v1/positionSummary": { list: [], foo: 1 }, "GET /v1/openPositions": openPos([]) }).broker.getPositions()).rejects.toThrow(/形/);
  });

  it("cancelOrder は orderId を数値で送る", async () => {
    const { broker, requests } = setup({ "POST /v1/cancelOrder": null });
    await broker.cancelOrder("1001", "BTC/JPY");
    expect(JSON.parse(posts(requests)[0].body)).toEqual({ orderId: 1001 });
  });
});
