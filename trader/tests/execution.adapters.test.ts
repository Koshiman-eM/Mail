import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE } from "../src/core/config";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";
import { AlpacaBroker } from "../src/execution/alpacaBroker";
import { CcxtBroker, type CcxtTradeLike } from "../src/execution/ccxtBroker";
import { OandaBroker } from "../src/execution/oandaBroker";
import { createBrokers } from "../src/execution/router";

/**
 * 実口座アダプターの正規化・安全動作 (全てモック。実 API へは送信しない)。
 * アダプターは NODE_ENV=test では生成できないので、各テストの間だけ production にする。
 */
let origEnv: string | undefined;
beforeEach(() => {
  origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
});
afterEach(() => {
  process.env.NODE_ENV = origEnv;
});

const spot = (symbol: string, extra: Partial<Instrument> = {}): Instrument => {
  const [pair] = symbol.split(":");
  const [base, quote] = pair.split("/");
  return {
    symbol, venue: "ccxt:bitflyer", assetClass: "crypto", baseCurrency: base, quoteCurrency: quote,
    tickSize: 1, lotSize: 0.00000001, minQty: 0.001, takerFeeRate: 0.0015, makerFeeRate: 0.0015, allowShort: false, ...extra,
  };
};
const BTCJPY = spot("BTC/JPY");
const FXBTC = spot("BTC/JPY:JPY", { allowShort: true });
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({ clientId: "c1", symbol: "BTC/JPY", side: "buy", type: "market", qty: "1", strategyId: "s", ...o });

class ArgumentsRequired extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ArgumentsRequired";
  }
}
class OrderNotFound extends Error {
  constructor(m: string) {
    super(m);
    this.name = "OrderNotFound";
  }
}

/** bitflyer 相当の exchange モック */
function mockEx(over: Partial<CcxtTradeLike> = {}, id = "bitflyer"): CcxtTradeLike {
  return {
    id,
    has: { fetchPositions: true, fetchOrder: "emulated", fetchMyTrades: true },
    fetchBalance: vi.fn(async () => ({ total: { JPY: 800_000, BTC: 0.02 }, free: { JPY: 700_000, BTC: 0.02 } })),
    // bitflyer の fetchPositions は symbols 無しだと ArgumentsRequired
    fetchPositions: vi.fn(async (symbols?: string[]) => {
      if (!symbols) throw new ArgumentsRequired("bitflyer fetchPositions() requires a `symbols` argument");
      return [];
    }),
    // bitflyer の createOrder は受付 ID だけを返す (status / filled なし)
    createOrder: vi.fn(async () => ({ id: "JRF-1", info: {} })),
    cancelOrder: vi.fn(async () => ({})),
    fetchOrder: vi.fn(async () => {
      throw new OrderNotFound("not found");
    }),
    ...over,
  };
}
const ccxt = (ex: CcxtTradeLike, o: Partial<ConstructorParameters<typeof CcxtBroker>[0]> = {}) =>
  new CcxtBroker({ mode: "live", exchange: ex, accountCurrency: "JPY", instruments: [BTCJPY], ...o });

describe("CcxtBroker", () => {
  it("受付のみの応答は status open・fills 空。getOrder は記録した注文 ID で照会し累計約定へ正規化する", async () => {
    const fetchOrder = vi.fn(async (id: string, symbol?: string) => {
      expect([id, symbol]).toEqual(["JRF-1", "BTC/JPY"]);
      return { id, status: "closed", side: "buy", type: "market", filled: 0.01, average: 10_000_000, fee: { cost: 150, currency: "JPY" }, lastTradeTimestamp: 5 };
    });
    const b = ccxt(mockEx({ fetchOrder }));
    const r = await b.placeOrder(req({ qty: "0.01" }));
    expect(r).toEqual({ orderId: "JRF-1", clientId: "c1", status: "open", fills: [] });
    const g = await b.getOrder("c1", "BTC/JPY");
    expect(g).toMatchObject({ orderId: "JRF-1", status: "filled", fills: [{ qty: "0.01", price: 10_000_000, fee: "150", ts: 5, liquidity: "taker" }] });
    expect(g!.fills[0].feeCurrency).toBeUndefined();
    // 同じ clientId の再発注は送らず、最新の状態を返す
    expect(await b.placeOrder(req({ qty: "0.01" }))).toBe(g);
    expect(b["ex"].createOrder).toHaveBeenCalledTimes(1);
  });

  it("status の対応: open/部分約定/取消 (部分約定つき)/期限切れ/拒否、OrderNotFound は undefined", async () => {
    const orders: Record<string, any> = {
      a: { id: "a", status: "open", filled: 0 },
      b: { id: "b", status: "open", filled: 0.4, average: 100 },
      c: { id: "c", status: "canceled", filled: 0.4, average: 100 },
      d: { id: "d", status: "expired", filled: 0 },
      e: { id: "e", status: "rejected", filled: 0 },
    };
    const fetchOrder = vi.fn(async (id: string) => {
      if (!orders[id]) throw new OrderNotFound(id);
      return { side: "buy", ...orders[id] };
    });
    const b = ccxt(mockEx({ fetchOrder }, "mock"));
    const st = async (id: string) => (await b.getOrder(`cid-${id}`, "BTC/JPY", id))?.status;
    expect(await st("a")).toBe("open");
    expect(await st("b")).toBe("partially_filled");
    const c = await b.getOrder("cid-c", "BTC/JPY", "c");
    expect(c).toMatchObject({ status: "canceled", fills: [{ qty: "0.4", price: 100 }] });
    expect(await st("d")).toBe("canceled");
    expect(await st("e")).toBe("rejected");
    expect(await b.getOrder("cid-z", "BTC/JPY", "z")).toBeUndefined();
  });

  it("getOrder: 注文 ID が無ければ clientOrderId で照会 (対応時)。照会手段が無ければ例外 (未約定とみなさない)", async () => {
    const byCid = vi.fn(async () => ({ id: "x9", status: "closed", side: "buy", filled: 1, average: 100, fee: { cost: 0.1, currency: "JPY" } }));
    const b1 = ccxt(mockEx({ has: { fetchOrderWithClientOrderId: true }, fetchOrderWithClientOrderId: byCid }, "mock"));
    expect(await b1.getOrder("cid-1", "BTC/JPY")).toMatchObject({ orderId: "x9", status: "filled" });
    expect(byCid).toHaveBeenCalledWith("cid-1", "BTC/JPY");
    const b2 = ccxt(mockEx({}, "mock"));
    await expect(b2.getOrder("cid-2", "BTC/JPY")).rejects.toThrow(/照会できません/);
    // 通信エラーなどは例外のまま
    const b3 = ccxt(mockEx({ fetchOrder: vi.fn(async () => { throw new Error("NetworkError"); }) }, "mock"));
    await expect(b3.getOrder("cid-3", "BTC/JPY", "o")).rejects.toThrow(/NetworkError/);
  });

  it("価格欠落: average/price が無い約定は含めず open にして照会へ回す。照会時は約定明細から価格を求める", async () => {
    const createOrder = vi.fn(async () => ({ id: "p1", status: "closed", filled: 1, price: 0 }));
    const fetchOrder = vi.fn(async () => ({ id: "p1", status: "closed", side: "buy", type: "market", filled: 1, price: 0, fee: { cost: 1, currency: "JPY" } }));
    const fetchMyTrades = vi.fn(async () => [
      { order: "p1", price: 100, amount: 0.25 },
      { order: "p1", price: 104, amount: 0.75 },
      { order: "other", price: 1, amount: 9 },
    ]);
    const b = ccxt(mockEx({ createOrder, fetchOrder, fetchMyTrades }, "mock"));
    const r = await b.placeOrder(req());
    expect(r.status).toBe("open");
    expect(r.fills).toEqual([]);
    expect(r.reason).toMatch(/価格が不明/);
    const g = await b.getOrder("c1", "BTC/JPY");
    expect(g).toMatchObject({ status: "filled", fills: [{ price: 103, qty: "1", fee: "1" }] });

    // 明細も取れなければ open のまま (価格 0 で記帳しない)
    const b2 = ccxt(mockEx({ createOrder, fetchOrder, has: {} }, "mock"));
    await b2.placeOrder(req());
    expect(await b2.getOrder("c1", "BTC/JPY")).toMatchObject({ status: "open", fills: [] });
    // closed なのに約定数量が無い応答も確定させない
    const b3 = ccxt(mockEx({ createOrder: vi.fn(async () => ({ id: "q", status: "closed" })) }, "mock"));
    expect((await b3.placeOrder(req())).status).toBe("open");
  });

  it("手数料: ベース通貨建ては数量を補正してクオート換算 (bitflyer は通貨不明ならベース扱い)", async () => {
    const order = (side: string, fee: Record<string, unknown>) => ({ id: "f", status: "closed", side, filled: 1, average: 100, fee });
    // bitflyer: total_commission は通貨が付かない → BTC 建てとみなす
    const bf = ccxt(mockEx({ createOrder: vi.fn(async (_s, _t, side) => order(side, { cost: 0.0015 })) }));
    const buy = await bf.placeOrder(req({ clientId: "b" }));
    expect(buy.fills[0]).toMatchObject({ qty: "0.9985", fee: "0.15" });
    expect(buy.fills[0].feeCurrency).toBeUndefined();
    const sell = await bf.placeOrder(req({ clientId: "s", side: "sell" }));
    expect(sell.fills[0]).toMatchObject({ qty: "1.0015", fee: "0.15" });

    // 他の取引所: 通貨不明はクオート扱い、明示の BTC はベース扱い
    const mk = (fee: Record<string, unknown>, o: Partial<ConstructorParameters<typeof CcxtBroker>[0]> = {}) =>
      ccxt(mockEx({ createOrder: vi.fn(async () => order("buy", fee)) }, "binance"), o);
    expect((await mk({ cost: 0.5 }).placeOrder(req())).fills[0]).toMatchObject({ qty: "1", fee: "0.5" });
    expect((await mk({ cost: 0.001, currency: "BTC" }).placeOrder(req())).fills[0]).toMatchObject({ qty: "0.999", fee: "0.1" });
    // BNB 建て: 換算できればクオートへ、できなければ feeCurrency を付ける
    const conv = await mk({ cost: 0.01, currency: "BNB" }, { toAccount: (c) => (c === "BNB" ? 90_000 : NaN) }).placeOrder(req());
    expect(conv.fills[0]).toMatchObject({ qty: "1", fee: "900" });
    const raw = await mk({ cost: 0.01, currency: "BNB" }).placeOrder(req());
    expect(raw.fills[0]).toMatchObject({ qty: "1", fee: "0.01", feeCurrency: "BNB" });
    // fees 配列 (通貨混在): クオート分は本体、換算できない分は数量 0 の明細
    const mixed = ccxt(mockEx({ createOrder: vi.fn(async () => ({ ...order("buy", {}), fee: undefined, fees: [{ cost: 2, currency: "JPY" }, { cost: 0.01, currency: "BNB" }] })) }, "binance"));
    const m = await mixed.placeOrder(req());
    expect(m.fills).toHaveLength(2);
    expect(m.fills[0]).toMatchObject({ qty: "1", fee: "2" });
    expect(m.fills[1]).toMatchObject({ qty: "0", fee: "0.01", feeCurrency: "BNB" });

    // デリバティブ (数量は枚数) はベース建て手数料でも数量を補正しない
    const d = new CcxtBroker({ mode: "live", exchange: mockEx({ createOrder: vi.fn(async () => order("buy", { cost: 0.001, currency: "BTC" })) }, "mock"), accountCurrency: "JPY", instruments: [FXBTC] });
    expect((await d.placeOrder(req({ symbol: "BTC/JPY:JPY" }))).fills[0]).toMatchObject({ qty: "1", fee: "0.1" });
  });

  it("現物の reduceOnly: reduceOnly を送らず、売り数量を保有 (free) でクランプ。保有 0 なら送らずに rejected", async () => {
    const createOrder = vi.fn(async () => ({ id: "r1", status: "closed", side: "sell", filled: 0.0123, average: 100, fee: { cost: 0, currency: "JPY" } }));
    const fetchBalance = vi.fn(async () => ({ total: { JPY: 0, BTC: 0.02 }, free: { BTC: 0.0123456789 } }));
    const b = ccxt(mockEx({ createOrder, fetchBalance }, "mock"), { instruments: [{ ...BTCJPY, lotSize: 0.0001 }] });
    await b.placeOrder(req({ side: "sell", qty: "1", reduceOnly: true }));
    const [sym, , side, amount, , params] = createOrder.mock.calls[0] as unknown as [string, string, string, number, number, Record<string, unknown>];
    expect([sym, side, amount]).toEqual(["BTC/JPY", "sell", 0.0123]); // lotSize で切り捨て
    expect(params).not.toHaveProperty("reduceOnly");
    expect(params).toMatchObject({ clientOrderId: "c1" });
    // 要求が保有より少なければそのまま
    await b.placeOrder(req({ clientId: "c2", side: "sell", qty: "0.005", reduceOnly: true }));
    expect((createOrder.mock.calls[1] as unknown[])[3]).toBe(0.005);

    // 保有 0 / 現物の買い決済 (売り建ては無い) は送らない
    const empty = ccxt(mockEx({ createOrder, fetchBalance: vi.fn(async () => ({ total: { JPY: 1 }, free: { JPY: 1 } })) }, "mock"));
    expect(await empty.placeOrder(req({ clientId: "e1", side: "sell", reduceOnly: true }))).toMatchObject({ status: "rejected" });
    expect(await b.placeOrder(req({ clientId: "e2", side: "buy", reduceOnly: true }))).toMatchObject({ status: "rejected" });
    expect(createOrder).toHaveBeenCalledTimes(2);

    // 残高照会の失敗: 送らずに rejected。未送信なので記録せず、同じ clientId で再試行できる
    let fail = true;
    const flaky = ccxt(mockEx({ createOrder, fetchBalance: vi.fn(async () => { if (fail) throw new Error("timeout"); return { total: { BTC: 1 }, free: { BTC: 1 } }; }) }, "mock"));
    expect(await flaky.placeOrder(req({ clientId: "f", side: "sell", reduceOnly: true }))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/未送信/) });
    fail = false;
    expect((await flaky.placeOrder(req({ clientId: "f", side: "sell", reduceOnly: true }))).status).not.toBe("rejected");
    expect(createOrder).toHaveBeenCalledTimes(3);
  });

  it("デリバティブの reduceOnly: reduceOnly を送り、建玉 (fetchPositions に symbol を渡す) でクランプ", async () => {
    const createOrder = vi.fn(async () => ({ id: "d1", status: "open", filled: 0 }));
    const fetchPositions = vi.fn(async (symbols?: string[]) => {
      if (!symbols) throw new ArgumentsRequired("symbols");
      return [{ product_code: "FX_BTC_JPY", side: "BUY", price: 36000, size: 0.01 }, { product_code: "FX_BTC_JPY", side: "BUY", price: 38000, size: 0.03 }];
    });
    const b = ccxt(mockEx({ createOrder, fetchPositions }), { instruments: [FXBTC] });
    await b.placeOrder(req({ symbol: "BTC/JPY:JPY", side: "sell", qty: "1", reduceOnly: true }));
    expect(fetchPositions).toHaveBeenCalledWith(["BTC/JPY:JPY"]);
    const call = createOrder.mock.calls[0] as unknown as [string, string, string, number, number, Record<string, unknown>];
    expect(call[3]).toBe(0.04);
    expect(call[5]).toMatchObject({ reduceOnly: true });
    // ロングしか無いのに買いの決済は rejected
    expect((await b.placeOrder(req({ clientId: "c2", symbol: "BTC/JPY:JPY", side: "buy", reduceOnly: true }))).status).toBe("rejected");
  });

  it("protectiveStop は ccxt では付けない (取引所側のストップが決済後に残る危険があるため)", async () => {
    const createOrder = vi.fn(async () => ({ id: "s1" }));
    await ccxt(mockEx({ createOrder })).placeOrder(req({ protectiveStop: 9_000_000 }));
    const params = (createOrder.mock.calls[0] as unknown[])[5] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["clientOrderId"]);
  });

  it("getPositions (bitflyer 相当): 現物は残高から導出し fetchPositions を呼ばない。デリバティブは symbols 付きで呼び、失敗したら一部だけ返さず例外にする", async () => {
    const ex = mockEx();
    const onlySpot = ccxt(ex);
    expect(await onlySpot.getPositions()).toEqual([{ symbol: "BTC/JPY", qty: "0.02", avgPrice: 0 }]);
    expect(ex.fetchPositions).not.toHaveBeenCalled();

    const fp = vi.fn(async (symbols?: string[]) => {
      if (!symbols) throw new ArgumentsRequired("symbols");
      return [
        { product_code: "FX_BTC_JPY", side: "BUY", price: 36000, size: 0.01 },
        { product_code: "FX_BTC_JPY", side: "BUY", price: 38000, size: 0.03 },
      ];
    });
    const both = ccxt(mockEx({ fetchPositions: fp }), { instruments: [BTCJPY, FXBTC] });
    expect(await both.getPositions()).toEqual([
      { symbol: "BTC/JPY", qty: "0.02", avgPrice: 0 },
      { symbol: "BTC/JPY:JPY", qty: "0.04", avgPrice: 37500 },
    ]);
    // 統一形式 (contracts / side short / entryPrice) も読む
    const unified = ccxt(mockEx({ fetchPositions: vi.fn(async () => [{ symbol: "BTC/JPY:JPY", contracts: 2, side: "short", entryPrice: 100 }]) }), { instruments: [FXBTC] });
    expect(await unified.getPositions()).toEqual([{ symbol: "BTC/JPY:JPY", qty: "-2", avgPrice: 100 }]);

    const broken = ccxt(mockEx({ fetchPositions: vi.fn(async () => { throw new ArgumentsRequired("x"); }) }), { instruments: [BTCJPY, FXBTC] });
    await expect(broken.getPositions()).rejects.toThrow(/デリバティブの建玉取得に失敗/);
  });

  it("評価額: 口座通貨の現金 + 現物の保有 × 現在値 × 為替。価格不明の通貨は除外", async () => {
    const quotes: Record<string, Quote> = { "BTC/JPY": { ts: 1, bid: 9_990_000, ask: 10_010_000 } };
    const ex = mockEx({ fetchBalance: vi.fn(async () => ({ total: { JPY: 800_000, BTC: 0.02, ETH: 1, USDT: 100 }, free: { JPY: 700_000 } })) });
    const insts = [BTCJPY, spot("ETH/JPY"), spot("XRP/USDT")];
    // 価格を注入しないと現金だけ (従来の挙動)
    expect(await ccxt(ex, { instruments: insts }).getBalance()).toEqual({ currency: "JPY", equity: "800000", available: "700000" });
    const b = ccxt(ex, { instruments: insts, quoteProvider: (s) => quotes[s], toAccount: (c) => (c === "USDT" ? 150 : NaN) });
    // 800000 + 0.02*10,000,000 + USDT 100*150 (ETH は価格不明で除外)
    expect(await b.getBalance()).toEqual({ currency: "JPY", equity: "1015000", available: "700000" });
  });

  it("明確な拒否 (InvalidOrder 等) だけ rejected、通信系は例外", async () => {
    class InsufficientFunds extends Error {
      constructor(m: string) {
        super(m);
        this.name = "InsufficientFunds";
      }
    }
    const rej = ccxt(mockEx({ createOrder: vi.fn(async () => { throw new InsufficientFunds("no money"); }) }));
    expect(await rej.placeOrder(req())).toMatchObject({ status: "rejected", reason: "no money" });
    const net = ccxt(mockEx({ createOrder: vi.fn(async () => { throw new Error("RequestTimeout"); }) }));
    await expect(net.placeOrder(req())).rejects.toThrow();
    // 拒否済みの注文は getOrder でも確定 (取引所に照会しない)
    expect(await rej.getOrder("c1", "BTC/JPY")).toMatchObject({ status: "rejected" });
  });
});

describe("createBrokers: ccxt へ quoteProvider / toAccount を注入", () => {
  const env = {
    TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE, NODE_ENV: "production", BASE_CURRENCY: "JPY",
    VENUES: "ccxt:bitflyer", CCXT_API_KEY: "k", CCXT_SECRET: "s",
  };
  it("top-level の deps と、互換のため deps.paper 側の値も使う", async () => {
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe("live");
    const quoteProvider = (s: string): Quote | undefined => (s === "BTC/JPY" ? { ts: 1, bid: 10_000_000, ask: 10_000_000 } : undefined);
    const createExchange = () => mockEx();
    const a = createBrokers(cfg, [BTCJPY], { createExchange, quoteProvider, toAccount: () => NaN });
    expect((await a.brokerFor("BTC/JPY").getBalance()).equity).toBe("1000000");
    const b = createBrokers(cfg, [BTCJPY], { createExchange, paper: { quoteProvider } });
    expect((await b.brokerFor("BTC/JPY").getBalance()).equity).toBe("1000000");
  });
});

// ───────────────────────── OANDA ─────────────────────────

const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const USDJPY: Instrument = {
  symbol: "USD/JPY", venue: "oanda", assetClass: "fx", baseCurrency: "USD", quoteCurrency: "JPY", tickSize: 0.001, lotSize: 1, minQty: 1,
  takerFeeRate: 0, makerFeeRate: 0, allowShort: true, contractSize: 1,
};

function oandaMock(routes: (url: string, init: any) => Response | undefined) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const fetchImpl = vi.fn(async (u: any, init: any) => {
    const url = String(u);
    calls.push({ url, method: init.method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    const r = routes(url, init);
    if (r) return r;
    if (url.endsWith("/summary")) return jsonRes({ account: { currency: "JPY", NAV: "1000000", marginAvailable: "900000" } });
    return jsonRes({ errorMessage: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const fillTx = { id: "7", orderID: "6", price: "150.01", units: "1000", commission: "12.5", time: "2025-01-01T00:00:00.000000000Z" };

describe("OandaBroker", () => {
  it("成行に stopLossOnFill (instrument の精度で丸め) を付け、commission に口座通貨を付ける", async () => {
    const { calls, fetchImpl } = oandaMock((url, init) => (init.method === "POST" ? jsonRes({ orderFillTransaction: fillTx }) : undefined));
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl, instruments: [USDJPY] });
    const r = await b.placeOrder({ clientId: "c1", symbol: "USD/JPY", side: "buy", type: "market", qty: "1000", strategyId: "s", protectiveStop: 149.98765 });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body.order).toMatchObject({ type: "MARKET", units: "1000", stopLossOnFill: { price: "149.988", timeInForce: "GTC" } });
    expect(r).toMatchObject({ status: "filled", fills: [{ qty: "1000", price: 150.01, fee: "12.5", feeCurrency: "JPY" }] });
  });

  it("instrument が無ければ JPY クロスは 3 桁・他は 5 桁で丸める。決済 (reduceOnly) には付けない。指値も丸める", async () => {
    const { calls, fetchImpl } = oandaMock((url, init) => {
      if (init.method === "POST") return jsonRes({ orderCreateTransaction: { id: "9" } });
      if (url.includes("/positions/EUR_USD")) return jsonRes({ position: { long: { units: "500" }, short: { units: "0" } } });
      return undefined;
    });
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
    const r = await b.placeOrder({ clientId: "a", symbol: "EUR/USD", side: "sell", type: "limit", limitPrice: 1.0812345, qty: "10", strategyId: "s", protectiveStop: 1.0912345 });
    expect(r).toEqual({ orderId: "9", clientId: "a", status: "open", fills: [] });
    const posts = () => calls.filter((c) => c.method === "POST");
    expect(posts()[0].body.order).toMatchObject({ price: "1.08123", stopLossOnFill: { price: "1.09123" } });
    await b.placeOrder({ clientId: "b", symbol: "EUR/USD", side: "sell", type: "market", qty: "800", reduceOnly: true, strategyId: "s", protectiveStop: 1.2 });
    // 建玉 500 でクランプ、REDUCE_ONLY、SL は付けない
    expect(posts()[1].body.order).toMatchObject({ units: "-500", positionFill: "REDUCE_ONLY" });
    expect(posts()[1].body.order).not.toHaveProperty("stopLossOnFill");
    // 建玉が無ければ送らない
    expect((await b.placeOrder({ clientId: "c", symbol: "EUR/USD", side: "buy", type: "market", qty: "1", reduceOnly: true, strategyId: "s" })).status).toBe("rejected");
    expect(posts()).toHaveLength(2);
  });

  it("getOrder: clientExtensions.id で照会。FILLED は約定トランザクションから、CANCELLED / PENDING / 404 も正規化", async () => {
    const orders: Record<string, any> = {
      "@f1": { id: "6", state: "FILLED", type: "MARKET", fillingTransactionID: "7" },
      "@x1": { id: "10", state: "CANCELLED", type: "MARKET", cancellingTransactionID: "11" },
      "@p1": { id: "12", state: "PENDING", type: "LIMIT" },
    };
    const { calls, fetchImpl } = oandaMock((url) => {
      const m = url.match(/\/orders\/([^/?]+)$/);
      if (m && orders[decodeURIComponent(m[1])]) return jsonRes({ order: orders[decodeURIComponent(m[1])] });
      if (url.endsWith("/transactions/7")) return jsonRes({ transaction: { ...fillTx, units: "-1000" } });
      return undefined;
    });
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
    expect(await b.getOrder("f1", "USD/JPY")).toMatchObject({ orderId: "6", status: "filled", fills: [{ qty: "1000", price: 150.01, feeCurrency: "JPY" }] });
    expect(calls.some((c) => c.url.endsWith("/v3/accounts/A/orders/@f1"))).toBe(true);
    expect(await b.getOrder("x1", "USD/JPY")).toMatchObject({ orderId: "10", status: "canceled", fills: [] });
    expect(await b.getOrder("p1", "USD/JPY")).toMatchObject({ orderId: "12", status: "open" });
    expect(await b.getOrder("none", "USD/JPY")).toBeUndefined();
    // clientId で見つからなければ orderId でも照会する
    orders["12"] = orders["@p1"];
    expect(await b.getOrder("none", "USD/JPY", "12")).toMatchObject({ orderId: "12", status: "open" });
    expect(calls.some((c) => c.url.endsWith("/v3/accounts/A/orders/12"))).toBe(true);
  });

  it("同じ clientExtensions.id の再送 (CLIENT_ORDER_ID_ALREADY_EXISTS) は rejected にせず既存の注文の状態を返す", async () => {
    const { fetchImpl } = oandaMock((url, init) => {
      if (init.method === "POST") return jsonRes({ orderRejectTransaction: { rejectReason: "CLIENT_ORDER_ID_ALREADY_EXISTS" }, errorCode: "CLIENT_ORDER_ID_ALREADY_EXISTS" }, 400);
      if (url.endsWith("/orders/@dup")) return jsonRes({ order: { id: "6", state: "FILLED", type: "MARKET", fillingTransactionID: "7" } });
      if (url.endsWith("/transactions/7")) return jsonRes({ transaction: fillTx });
      return undefined;
    });
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
    expect(await b.placeOrder({ clientId: "dup", symbol: "USD/JPY", side: "buy", type: "market", qty: "1000", strategyId: "s" })).toMatchObject({ status: "filled" });
  });
});

// ───────────────────────── Alpaca ─────────────────────────

describe("AlpacaBroker", () => {
  const mk = (routes: (url: string, init: any) => Response | undefined) => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const fetchImpl = vi.fn(async (u: any, init: any) => {
      const url = String(u);
      calls.push({ url, method: init.method, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      return routes(url, init) ?? jsonRes({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
    return { calls, b: new AlpacaBroker({ mode: "live", keyId: "k", secretKey: "s", paper: true, fetchImpl }) };
  };

  it("getOrder: by_client_order_id で照会し status / filled_qty / filled_avg_price を正規化 (手数料 0、feeCurrency なし)", async () => {
    const orders: Record<string, any> = {
      p: { id: "1", status: "partially_filled", filled_qty: "3", filled_avg_price: "190.5", type: "limit", filled_at: "2025-01-02T00:00:00Z" },
      f: { id: "2", status: "filled", filled_qty: "10", filled_avg_price: "191", type: "market" },
      c: { id: "3", status: "canceled", filled_qty: "3", filled_avg_price: "190" },
      x: { id: "4", status: "expired", filled_qty: "0" },
      n: { id: "5", status: "new", filled_qty: "0" },
      a: { id: "6", status: "accepted", filled_qty: "0" },
      r: { id: "7", status: "rejected", filled_qty: "0" },
      noprice: { id: "8", status: "filled", filled_qty: "10", filled_avg_price: null },
    };
    const { calls, b } = mk((url) => {
      const m = url.match(/client_order_id=([^&]+)/);
      if (m && orders[m[1]]) return jsonRes(orders[m[1]]);
      if (url.endsWith("/v2/orders/9")) return jsonRes({ id: "9", status: "filled", filled_qty: "1", filled_avg_price: "10" });
      return undefined;
    });
    const p = await b.getOrder("p", "AAPL");
    expect(p).toMatchObject({ orderId: "1", status: "partially_filled", fills: [{ qty: "3", price: 190.5, fee: "0", liquidity: "maker", ts: Date.parse("2025-01-02T00:00:00Z") }] });
    expect(p!.fills[0].feeCurrency).toBeUndefined();
    expect(calls[0].url).toBe("https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=p");
    expect(await b.getOrder("f", "AAPL")).toMatchObject({ status: "filled", fills: [{ qty: "10", price: 191, liquidity: "taker" }] });
    expect(await b.getOrder("c", "AAPL")).toMatchObject({ status: "canceled", fills: [{ qty: "3" }] });
    expect((await b.getOrder("x", "AAPL"))?.status).toBe("canceled");
    expect((await b.getOrder("n", "AAPL"))?.status).toBe("open");
    expect((await b.getOrder("a", "AAPL"))?.status).toBe("open");
    expect((await b.getOrder("r", "AAPL"))?.status).toBe("rejected");
    expect(await b.getOrder("noprice", "AAPL")).toMatchObject({ status: "open", fills: [] });
    expect(await b.getOrder("missing", "AAPL")).toBeUndefined();
    expect(await b.getOrder("missing", "AAPL", "9")).toMatchObject({ orderId: "9", status: "filled" });
  });

  it("受付のみ (accepted) の発注は open・fills 空", async () => {
    const { b } = mk((_url, init) => (init.method === "POST" ? jsonRes({ id: "a1", status: "accepted", filled_qty: "0" }) : undefined));
    expect(await b.placeOrder({ clientId: "x", symbol: "AAPL", side: "buy", type: "market", qty: "1", strategyId: "s" })).toEqual({ orderId: "a1", clientId: "x", status: "open", fills: [] });
  });

  it("reduceOnly: reduce_only を送らず、売り数量を保有 (qty_available) でクランプ。保有なしは送らない。保護ストップは付けない", async () => {
    const { calls, b } = mk((url, init) => {
      if (init.method === "POST") return jsonRes({ id: "o", status: "new", filled_qty: "0" });
      if (url.endsWith("/v2/positions/AAPL")) return jsonRes({ symbol: "AAPL", qty: "5", side: "long", qty_available: "4" });
      return undefined;
    });
    await b.placeOrder({ clientId: "s1", symbol: "AAPL", side: "sell", type: "market", qty: "10", reduceOnly: true, strategyId: "s", protectiveStop: 180 });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ symbol: "AAPL", qty: "4", side: "sell" });
    expect(Object.keys(post.body)).not.toContain("reduce_only");
    expect(JSON.stringify(post.body)).not.toMatch(/stop|bracket|order_class/);
    // ロングに対する買い決済・建玉なし (404) は rejected で送らない
    expect((await b.placeOrder({ clientId: "s2", symbol: "AAPL", side: "buy", type: "market", qty: "1", reduceOnly: true, strategyId: "s" })).status).toBe("rejected");
    expect((await b.placeOrder({ clientId: "s3", symbol: "MSFT", side: "sell", type: "market", qty: "1", reduceOnly: true, strategyId: "s" })).status).toBe("rejected");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});
