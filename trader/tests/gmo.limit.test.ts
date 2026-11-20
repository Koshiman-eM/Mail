import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntryContext, Instrument, OrderRequest } from "../src/core/types";
import { PositionManager } from "../src/engine/positions";
import { GmoBroker } from "../src/execution/gmoBroker";
import { TradeJournal } from "../src/learning/journal";
import { MemoryStore } from "../src/storage/memory";
import { createGmoMock, fakeTime, type RecordedRequest, type RouteValue } from "./helpers/gmoMock";

/**
 * GMOコインの指値 (maker): 新規の LIMIT (レバレッジ銘柄なので post-only = SOK は送らない)、reduceOnly の LIMIT は closeBulkOrder、
 * live では利確の指値を板に置かない (LIMIT_TAKE_PROFIT は paper 専用)、自分の決済注文 (CLOSE) を反対方向の新規と誤認しないこと。
 * すべてモック (実 API へは送信しない)。
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
  tickSize: 1, lotSize: 0.01, minQty: 0.01, takerFeeRate: 0.0005, makerFeeRate: -0.0001, allowShort: true,
  meta: { gmoSymbol: "BTC_JPY", gmoSpotSymbol: "BTC", leverage: 1, holdingFeeDaily: 0.0004 },
};
const T = Date.UTC(2025, 0, 10, 12, 0);
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ clientId: "c1", symbol: "BTC/JPY", side: "buy", type: "limit", qty: "0.03", strategyId: "s", ...o });

const summary = (buy?: [string, string?]) => ({
  list: buy ? [{ averagePositionRate: "10000000", positionLossGain: "0", side: "BUY", sumOrderQuantity: buy[1] ?? "0", sumPositionQuantity: buy[0], symbol: "BTC_JPY" }] : [],
});
const openPos = (buy?: string) => ({
  pagination: { currentPage: 1, count: buy ? 1 : 0 },
  list: buy
    ? [{ positionId: 100, symbol: "BTC_JPY", side: "BUY", size: buy, orderdSize: "0", price: "10000000", lossGain: "0", leverage: "1", losscutPrice: "0", timestamp: "2025-01-10T11:00:00.000Z" }]
    : [],
});
const order = (o: Record<string, unknown> = {}) => ({
  orderId: 2001, rootOrderId: 2001, symbol: "BTC_JPY", side: "SELL", orderType: "NORMAL", executionType: "LIMIT", settleType: "CLOSE",
  size: "0.03", executedSize: "0", price: "10200000", losscutPrice: "0", status: "ORDERED", timeInForce: "SOK", timestamp: "2025-01-10T12:00:00.100Z", ...o,
});

function setup(routes: Record<string, RouteValue>) {
  const t = fakeTime(T);
  const mock = createGmoMock(routes);
  const broker = new GmoBroker({ mode: "live", clientOptions: { apiKey: "k", apiSecret: "s", fetchImpl: mock.fetchImpl, now: t.now, sleep: t.sleep }, instruments: [BTC] });
  return { broker, ...mock, t };
}
const posts = (rs: RecordedRequest[]) => rs.filter((r) => r.method === "POST");
const body = (r: RecordedRequest) => JSON.parse(r.body) as Record<string, unknown>;

describe("GmoBroker: 指値", () => {
  it("能力: post-only は不可 (SOK は現物だけの想定)、利確の板置きも使わない", () => {
    expect(setup({}).broker.capabilities).toEqual({ postOnly: false, restingTakeProfit: false });
  });

  it("新規の指値は /v1/order の LIMIT。postOnly が付いていても SOK は送らない (価格は刻みにそろえ、買いは切り捨て)", async () => {
    const { broker, requests } = setup({
      "GET /v1/positionSummary": summary(),
      "GET /v1/openPositions": openPos(),
      "GET /v1/activeOrders": { list: [] },
      "POST /v1/order": "3001",
    });
    const r = await broker.placeOrder(req({ limitPrice: 9_999_999.7, postOnly: true, tif: "GTC" }));
    expect(r).toMatchObject({ status: "open", orderId: "3001" });
    const p = posts(requests);
    expect(p).toHaveLength(1);
    expect(p[0].path).toBe("/v1/order");
    expect(body(p[0])).toEqual({ symbol: "BTC_JPY", side: "BUY", executionType: "LIMIT", size: "0.03", price: "9999999" });
    // post-only でない GTC の指値も timeInForce を送らない (既定に任せる)
    const { broker: b2, requests: r2 } = setup({
      "GET /v1/positionSummary": summary(),
      "GET /v1/openPositions": openPos(),
      "GET /v1/activeOrders": { list: [] },
      "POST /v1/order": "3002",
    });
    await b2.placeOrder(req({ clientId: "c2", limitPrice: 9_999_999, tif: "GTC" }));
    expect(body(posts(r2)[0])).not.toHaveProperty("timeInForce");
  });

  it("reduceOnly の指値は /v1/closeBulkOrder の LIMIT で送る (SOK は送らない)", async () => {
    const { broker, requests } = setup({
      "GET /v1/positionSummary": summary(["0.03"]),
      "POST /v1/closeBulkOrder": "2001",
    });
    const r = await broker.placeOrder(req({ clientId: "t1", side: "sell", reduceOnly: true, limitPrice: 10_200_000.2, postOnly: true }));
    expect(r).toMatchObject({ status: "open", orderId: "2001" });
    const p = posts(requests);
    expect(p.map((x) => x.path)).toEqual(["/v1/closeBulkOrder"]);
    // 売りは切り上げ (指定より不利にしない)
    expect(body(p[0])).toEqual({ symbol: "BTC_JPY", side: "SELL", executionType: "LIMIT", size: "0.03", price: "10200001" });
  });

  it("自分の利確の指値 (settleType CLOSE) を反対方向の新規と誤認しない。反対方向の新規 (OPEN) があれば送らない", async () => {
    const closeOrder = order();
    const { broker, requests } = setup({
      "GET /v1/positionSummary": summary(["0.03", "0.03"]),
      "GET /v1/openPositions": openPos("0.03"),
      "GET /v1/activeOrders": { pagination: { currentPage: 1, count: 1 }, list: [closeOrder] },
      "POST /v1/order": "3003",
    });
    const r = await broker.placeOrder(req({ clientId: "c3", limitPrice: 9_900_000, postOnly: true }));
    expect(r.status).toBe("open");
    expect(posts(requests).map((x) => x.path)).toEqual(["/v1/order"]);

    const { broker: b2, requests: r2 } = setup({
      "GET /v1/positionSummary": summary(),
      "GET /v1/openPositions": openPos(),
      "GET /v1/activeOrders": { pagination: { currentPage: 1, count: 1 }, list: [order({ orderId: 4001, rootOrderId: 4001, settleType: "OPEN" })] },
      "POST /v1/order": "3004",
    });
    const r4 = await b2.placeOrder(req({ clientId: "c4", limitPrice: 9_900_000, postOnly: true }));
    expect(r4.status).toBe("rejected");
    expect(r4.reason).toMatch(/反対方向の新規注文/);
    expect(posts(r2)).toHaveLength(0);
  });
});

describe("PositionManager + GmoBroker (live): 利確の指値は板に置かない", () => {
  const ctx = { regime: { label: "range", trend: 0, trendStrength: 0, volatility: 0.01, volatilityPercentile: 0.5, spreadBps: 1 }, confidence: 0.7, expectedEdgeBps: 50, costBps: 5, params: {}, features: {}, riskMultiplier: 1, reason: "t" } as EntryContext;

  function world() {
    const routes: Record<string, RouteValue> = {
      "GET /v1/positionSummary": () => summary(["0.03", "0"]),
      "GET /v1/activeOrders": () => ({ list: [] }),
      "POST /v1/closeBulkOrder": () => "2002",
      "POST /v1/cancelOrder": () => ({}),
      "GET /v1/orders": () => ({ list: [order({ orderId: 2002, rootOrderId: 2002, executionType: "MARKET", status: "ORDERED", timeInForce: "FAK", price: "0" })] }),
    };
    const { broker, requests, t } = setup(routes);
    const store = new MemoryStore();
    const journal = new TradeJournal({ store, mode: "live" });
    // limitTakeProfit: true を渡しても live では置かない (engine も live では渡さない)
    const pm = new PositionManager({ journal, brokerFor: () => broker, store, instrumentOf: () => BTC, limitTakeProfit: true });
    const p = pm.open(
      {
        mode: "live", symbol: "BTC/JPY", venue: "gmo", assetClass: "crypto", strategyId: "s", horizon: "scalp", direction: "long", qty: 0.03, entryTs: T,
        entryPrice: 10_000_000, intendedEntryPrice: 10_000_000, initialStop: 9_800_000, takeProfit: 10_200_000, entryContext: ctx,
      },
      { maxHoldMs: 3_600_000 },
    );
    return { pm, p, requests, store, t };
  }

  it("placeTakeProfit も onQuote も利確の指値を送らず、損切りは取消を挟まずに closeBulkOrder の MARKET で送る", async () => {
    const { pm, p, requests } = world();
    expect(await pm.placeTakeProfit(p, { ts: T, bid: 10_000_000, ask: 10_000_100 }, T)).toBe(false);
    await pm.onQuote("BTC/JPY", { ts: T + 1_000, bid: 10_000_000, ask: 10_000_100 }, T + 1_000);
    expect(posts(requests)).toHaveLength(0);
    expect(pm.restingTakeProfits()).toHaveLength(0);
    const r = await pm.onQuote("BTC/JPY", { ts: T + 5_000, bid: 9_700_000, ask: 9_700_100 }, T + 5_000);
    expect(r.status).toBe("pending"); // 成行は受付のみ (照会で確定させる)
    const p2 = posts(requests);
    expect(p2.map((x) => `${x.path}:${body(x).executionType}`)).toEqual(["/v1/closeBulkOrder:MARKET"]);
    expect(body(p2[0])).toMatchObject({ side: "SELL", size: "0.03" });
    expect(requests.some((x) => x.path === "/v1/cancelOrder")).toBe(false);
  });
});
