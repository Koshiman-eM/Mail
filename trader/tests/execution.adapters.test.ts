import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE } from "../src/core/config";
import type { Instrument, OrderRequest, Quote } from "../src/core/types";
import { AlpacaBroker } from "../src/execution/alpacaBroker";
import { CcxtBroker, type CcxtTradeLike } from "../src/execution/ccxtBroker";
import { OandaBroker } from "../src/execution/oandaBroker";
import { createBrokers } from "../src/execution/router";
import { createRequire } from "node:module";
import { classifyCcxtError } from "../src/execution/ccxtBroker";
import * as ccxtEsm from "ccxt";

/** アダプターと同じ (router と同じ createRequire の) ccxt のエラークラス。実クラスのインスタンスを投げて判定を確かめる */
const E = createRequire(import.meta.url)("ccxt") as Record<string, new (m: string) => Error>;

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
    // reduceOnly 対応の取引所 (bitflyer 以外) を想定する
    const b = ccxt(mockEx({ createOrder, fetchPositions }, "mock"), { instruments: [FXBTC] });
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
    await ccxt(mockEx({ createOrder }, "mock")).placeOrder(req({ protectiveStop: 9_000_000 }));
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

  it("明確な拒否 (ExchangeError 系) だけ rejected、通信系は例外。拒否済みは getOrder でも確定", async () => {
    const rej = ccxt(mockEx({ createOrder: vi.fn(async () => { throw new E.InsufficientFunds("no money"); }) }));
    expect(await rej.placeOrder(req())).toMatchObject({ status: "rejected", reason: "no money" });
    const net = ccxt(mockEx({ createOrder: vi.fn(async () => { throw new E.RequestTimeout("timeout"); }) }));
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

// ───────────────────────── 追加: 安全修正 ─────────────────────────

describe("ccxt のエラー分類 (クラス階層は ccxt/js/src/base/errors.js)", () => {
  const rejected = [
    "ExchangeError", "AuthenticationError", "PermissionDenied", "AccountNotEnabled", "AccountSuspended", "ArgumentsRequired", "BadRequest",
    "BadSymbol", "OperationRejected", "NoChange", "MarketClosed", "ManualInteractionNeeded", "RestrictedLocation", "InsufficientFunds",
    "InvalidAddress", "InvalidOrder", "OrderNotFound", "OrderNotCached", "OrderImmediatelyFillable", "OrderNotFillable", "DuplicateOrderId",
    "ContractUnavailable", "NotSupported", "InvalidProxySettings", "ExchangeClosedByUser",
    "RateLimitExceeded", "DDoSProtection", "OnMaintenance",
  ];
  const unknown = ["OperationFailed", "NetworkError", "RequestTimeout", "ExchangeNotAvailable", "InvalidNonce", "ChecksumError", "BadResponse", "NullResponse", "CancelPending"];
  it.each(rejected)("%s は rejected", (n) => {
    expect(classifyCcxtError(new E[n]("x"))).toBe("rejected");
    expect(classifyCcxtError(new (ccxtEsm as any)[n]("x"))).toBe("rejected"); // ESM 版のクラスでも
  });
  it.each(unknown)("%s は状態不明 (例外)", (n) => {
    expect(classifyCcxtError(new E[n]("x"))).toBe("unknown");
    expect(classifyCcxtError(new (ccxtEsm as any)[n]("x"))).toBe("unknown");
  });
  it("ccxt 以外の例外・文字列は状態不明 (名前だけ似せた素の Error も不成立にしない)", () => {
    expect(classifyCcxtError(new Error("boom"))).toBe("unknown");
    expect(classifyCcxtError("x")).toBe("unknown");
    const fake = new Error("x");
    fake.name = "InsufficientFunds";
    expect(classifyCcxtError(fake)).toBe("unknown");
  });
  it("bitflyer 相当: 汎用 ExchangeError (証拠金不足 -205) は rejected、OnMaintenance も rejected、RequestTimeout は例外", async () => {
    const mk = (err: Error) => ccxt(mockEx({ createOrder: vi.fn(async () => { throw err; }) }));
    expect(await mk(new E.ExchangeError('bitflyer {"status":-205,"error_message":"Margin amount is insufficient"}')).placeOrder(req())).toMatchObject({ status: "rejected" });
    expect(await mk(new E.OnMaintenance("maint")).placeOrder(req())).toMatchObject({ status: "rejected" });
    expect(await mk(new E.RateLimitExceeded("429")).placeOrder(req())).toMatchObject({ status: "rejected" });
    await expect(mk(new E.RequestTimeout("t")).placeOrder(req())).rejects.toThrow();
    await expect(mk(new E.BadResponse("t")).placeOrder(req())).rejects.toThrow();
    await expect(mk(new E.CancelPending("t")).placeOrder(req())).rejects.toThrow();
  });
});

describe("CcxtBroker: 重複 clientId", () => {
  it("DuplicateOrderId / 'Duplicate order sent' は rejected にせず clientId で既存の注文の状態を返す。照会できなければ例外", async () => {
    const existing = { id: "B1", clientOrderId: "c1", status: "closed", side: "buy", type: "market", filled: 1, average: 100, fee: { cost: 0, currency: "JPY" } };
    for (const err of [new E.DuplicateOrderId("dup"), new E.InvalidOrder('binance {"code":-2010,"msg":"Duplicate order sent."}')]) {
      const fetchOrder = vi.fn(async (_id: string, _s?: string, params?: any) => {
        expect(params).toEqual({ clientOrderId: "c1" });
        return existing;
      });
      const b = ccxt(mockEx({ has: {}, createOrder: vi.fn(async () => { throw err; }), fetchOrder }, "binance"));
      expect(await b.placeOrder(req())).toMatchObject({ orderId: "B1", status: "filled" });
    }
    const b2 = ccxt(mockEx({ has: {}, createOrder: vi.fn(async () => { throw new E.DuplicateOrderId("dup"); }), fetchOrder: vi.fn(async () => { throw new E.NetworkError("down"); }) }, "mock"));
    await expect(b2.placeOrder(req())).rejects.toThrow();
  });
});

describe("CcxtBroker.getOrder: clientId の照会を広げる", () => {
  const open = { id: "O1", clientOrderId: "c1", status: "open", side: "buy", type: "limit", filled: 0, amount: 1 };
  it("fetchOrder('', symbol, { clientOrderId }) を試す。ArgumentsRequired なら一覧へ進む", async () => {
    const fetchOrder = vi.fn(async (_id: string, _s?: string, params?: any) => ({ ...open, ...(params ? {} : {}) }));
    const b = ccxt(mockEx({ has: {}, fetchOrder }, "binance"));
    expect(await b.getOrder("c1", "BTC/JPY")).toMatchObject({ orderId: "O1", status: "open" });
    expect(fetchOrder).toHaveBeenCalledWith("", "BTC/JPY", { clientOrderId: "c1" });
    // 次回以降は記録した orderId で照会
    await b.getOrder("c1", "BTC/JPY");
    expect(fetchOrder).toHaveBeenLastCalledWith("O1", "BTC/JPY");

    const fetchOpenOrders = vi.fn(async () => [{ ...open, id: "Z", clientOrderId: "other" }, open]);
    const fetchClosedOrders = vi.fn(async () => []);
    const b2 = ccxt(mockEx({ has: { fetchOpenOrders: true, fetchClosedOrders: true }, fetchOrder: vi.fn(async () => { throw new E.ArgumentsRequired("id"); }), fetchOpenOrders, fetchClosedOrders }, "mock"));
    expect(await b2.getOrder("c1", "BTC/JPY", undefined, { createdAt: 1_000_000, side: "buy", qty: "1" })).toMatchObject({ orderId: "O1" });
    expect(fetchClosedOrders).toHaveBeenCalledWith("BTC/JPY", 1_000_000 - 60_000);
  });
  it("一覧に clientOrderId があるのに一致が無ければ undefined。一覧が片方でも失敗すれば例外", async () => {
    const has = { fetchOpenOrders: true, fetchClosedOrders: true };
    const ng = vi.fn(async () => { throw new E.ArgumentsRequired("id"); });
    const b = ccxt(mockEx({ has, fetchOrder: ng, fetchOpenOrders: vi.fn(async () => [{ ...open, clientOrderId: "other" }]), fetchClosedOrders: vi.fn(async () => []) }, "mock"));
    expect(await b.getOrder("c1", "BTC/JPY")).toBeUndefined();
    const b2 = ccxt(mockEx({ has, fetchOrder: ng, fetchOpenOrders: vi.fn(async () => []), fetchClosedOrders: vi.fn(async () => { throw new E.RequestTimeout("t"); }) }, "mock"));
    await expect(b2.getOrder("c1", "BTC/JPY")).rejects.toThrow();
    // fetchOrders だけでもよい
    const b3 = ccxt(mockEx({ has: { fetchOrders: true }, fetchOrder: ng, fetchOrders: vi.fn(async () => [open]) }, "mock"));
    expect(await b3.getOrder("c1", "BTC/JPY")).toMatchObject({ orderId: "O1" });
  });
  it("bitflyer 相当 (clientOrderId 無し): hint (side・数量・時刻) で 1 件だけ一致なら採用して orderId を記録、0 件は undefined、2 件は例外", async () => {
    const T = 1_700_000_000_000;
    const o = (id: string, ts: number, over: any = {}) => ({ id, status: "open", side: "buy", type: "market", amount: 0.01, filled: 0, timestamp: ts, ...over });
    const hint = { createdAt: T, side: "buy" as const, qty: "0.01" };
    const fetchOrder = vi.fn(async (id: string) => {
      if (id === "") throw new E.OrderNotFound("bitflyer order not found"); // 誤って「無い」と判断しないこと
      return o(id, T + 1000);
    });
    const list = vi.fn(async () => [
      o("far", T - 11_000), // 範囲外
      o("sell", T, { side: "sell" }),
      o("qty", T, { amount: 0.02 }),
      o("late", T + 121_000),
      o("hit", T + 5_000),
    ]);
    const has = { fetchOpenOrders: true, fetchClosedOrders: true };
    const b = ccxt(mockEx({ has, fetchOrder, fetchOpenOrders: list, fetchClosedOrders: vi.fn(async () => []) }));
    expect(await b.getOrder("c1", "BTC/JPY", undefined, hint)).toMatchObject({ orderId: "hit", status: "open" });
    await b.getOrder("c1", "BTC/JPY");
    expect(fetchOrder).toHaveBeenLastCalledWith("hit", "BTC/JPY");
    // 別の clientId は、c1 が採用済みの注文を候補にしない
    expect(await b.getOrder("c2", "BTC/JPY", undefined, hint)).toBeUndefined();

    const none = ccxt(mockEx({ has, fetchOrder, fetchOpenOrders: vi.fn(async () => []), fetchClosedOrders: vi.fn(async () => []) }));
    expect(await none.getOrder("c1", "BTC/JPY", undefined, hint)).toBeUndefined();
    const two = ccxt(mockEx({ has, fetchOrder, fetchOpenOrders: vi.fn(async () => [o("a", T), o("b", T + 1)]), fetchClosedOrders: vi.fn(async () => []) }));
    await expect(two.getOrder("c1", "BTC/JPY", undefined, hint)).rejects.toThrow(/2 件/);
    // hint が無ければ特定できない (空の一覧でも「無い」とは言えない)
    await expect(none.getOrder("c1", "BTC/JPY")).rejects.toThrow();
  });
  it("照会手段が無い・一覧の一部しか取れない場合は例外 (未約定とみなさない)", async () => {
    const ng = vi.fn(async () => { throw new E.NotSupported("x"); });
    const b = ccxt(mockEx({ has: {}, fetchOrder: ng }, "mock"));
    await expect(b.getOrder("c1", "BTC/JPY", undefined, { createdAt: 1, side: "buy", qty: "1" })).rejects.toThrow(/照会できません/);
    const b2 = ccxt(mockEx({ has: { fetchOpenOrders: true }, fetchOrder: ng, fetchOpenOrders: vi.fn(async () => []) }, "mock"));
    await expect(b2.getOrder("c1", "BTC/JPY", undefined, { createdAt: 1, side: "buy", qty: "1" })).rejects.toThrow();
  });
});

describe("CcxtBroker: bitFlyer の発注パラメーター", () => {
  it("bitflyer には clientOrderId / reduceOnly を送らない。reduceOnly 対応の取引所には送る", async () => {
    const createOrder = vi.fn(async () => ({ id: "JRF-2", info: {} }));
    const fx = ccxt(mockEx({ createOrder, fetchPositions: vi.fn(async () => [{ symbol: "BTC/JPY:JPY", contracts: 0.5, side: "long", entryPrice: 1 }]) }), { instruments: [FXBTC] });
    await fx.placeOrder(req({ symbol: "BTC/JPY:JPY", side: "sell", qty: "2", reduceOnly: true }));
    const call = createOrder.mock.calls[0] as any[];
    expect(call[2]).toBe("sell");
    expect(call[3]).toBe(0.5); // 建玉で上限
    expect(call[5]).toEqual({});
    const ok = vi.fn(async () => ({ id: "X", info: {} }));
    const other = ccxt(mockEx({ createOrder: ok, has: { fetchPositions: true }, fetchPositions: vi.fn(async () => [{ symbol: "BTC/JPY:JPY", contracts: 1, side: "long" }]) }, "mock"), { instruments: [FXBTC] });
    await other.placeOrder(req({ symbol: "BTC/JPY:JPY", side: "sell", qty: "1", reduceOnly: true }));
    expect((ok.mock.calls[0] as any[])[5]).toEqual({ clientOrderId: "c1", reduceOnly: true });
  });
  it("IOC / FOK は bitflyer では time_in_force、他の取引所では timeInForce で渡す", async () => {
    const createOrder = vi.fn(async () => ({ id: "JRF-4", info: {} }));
    const bf = ccxt(mockEx({ createOrder, fetchPositions: vi.fn(async () => []) }), { instruments: [FXBTC] });
    await bf.placeOrder(req({ symbol: "BTC/JPY:JPY", side: "buy", qty: "0.01", tif: "IOC" }));
    expect((createOrder.mock.calls[0] as any[])[5]).toEqual({ time_in_force: "IOC" });
    const ok = vi.fn(async () => ({ id: "Y", info: {} }));
    const other = ccxt(mockEx({ createOrder: ok, has: { fetchPositions: true }, fetchPositions: vi.fn(async () => []) }, "mock"), { instruments: [FXBTC] });
    await other.placeOrder(req({ symbol: "BTC/JPY:JPY", side: "buy", qty: "0.01", tif: "FOK" }));
    expect((ok.mock.calls[0] as any[])[5]).toEqual({ clientOrderId: "c1", timeInForce: "FOK" });
  });
  it("bitflyer のデリバティブ決済で建玉を照会できなければ送らずに rejected (記録せず再試行できる)", async () => {
    const createOrder = vi.fn(async () => ({ id: "JRF-3", info: {} }));
    let fail = true;
    const fetchPositions = vi.fn(async () => {
      if (fail) throw new E.RequestTimeout("t");
      return [{ symbol: "BTC/JPY:JPY", contracts: 1, side: "long" }];
    });
    const b = ccxt(mockEx({ createOrder, fetchPositions }), { instruments: [FXBTC] });
    const r = req({ symbol: "BTC/JPY:JPY", side: "sell", qty: "1", reduceOnly: true });
    expect(await b.placeOrder(r)).toMatchObject({ status: "rejected" });
    expect(createOrder).not.toHaveBeenCalled();
    fail = false;
    expect(await b.placeOrder(r)).toMatchObject({ orderId: "JRF-3", status: "open" });
    expect(createOrder).toHaveBeenCalledTimes(1);
    // fetchPositions に未対応でも同様
    const b2 = ccxt(mockEx({ createOrder, has: {}, fetchPositions: undefined }), { instruments: [FXBTC] });
    expect(await b2.placeOrder({ ...r, clientId: "c9" })).toMatchObject({ status: "rejected" });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});

describe("CcxtBroker: bitFlyer FX の証拠金", () => {
  it("デリバティブ銘柄があるときだけ getcollateral の collateral + open_position_pnl を評価額に加える", async () => {
    const privateGetGetcollateral = vi.fn(async () => ({ collateral: "100000", open_position_pnl: "-2500", require_collateral: "1", keep_rate: "9" }));
    const fx = ccxt(mockEx({ privateGetGetcollateral }), { instruments: [FXBTC] });
    expect(await fx.getBalance()).toMatchObject({ currency: "JPY", equity: "897500" });
    expect(privateGetGetcollateral).toHaveBeenCalledTimes(1);
    // 現物だけなら呼ばない
    const spotOnly = ccxt(mockEx({ privateGetGetcollateral }), { instruments: [BTCJPY] });
    await spotOnly.getBalance();
    expect(privateGetGetcollateral).toHaveBeenCalledTimes(1);
    // market が spot でない銘柄 (":" 無しのシンボルでも)
    const m = ccxt(mockEx({ privateGetGetcollateral, markets: { "FX_BTC": { spot: false, type: "future" } } }), { instruments: [spot("FX_BTC/JPY", {}), ] });
    await m.getBalance();
    expect(privateGetGetcollateral).toHaveBeenCalledTimes(1); // FX_BTC/JPY は markets に無く spot 扱い
    const m2 = ccxt(mockEx({ privateGetGetcollateral, markets: { "BTC/JPY": { spot: false, type: "future" } } }), { instruments: [BTCJPY] });
    expect(await m2.getBalance()).toMatchObject({ equity: "897500" });
    // 他の取引所では呼ばない
    const other = ccxt(mockEx({ privateGetGetcollateral }, "mock"), { instruments: [FXBTC] });
    await other.getBalance();
    expect(privateGetGetcollateral).toHaveBeenCalledTimes(2);
  });
  it("getcollateral が失敗・不正なら例外 (評価額を欠けたまま返さない)", async () => {
    const bad = ccxt(mockEx({ privateGetGetcollateral: vi.fn(async () => { throw new E.RequestTimeout("t"); }) }), { instruments: [FXBTC] });
    await expect(bad.getBalance()).rejects.toThrow();
    const odd = ccxt(mockEx({ privateGetGetcollateral: vi.fn(async () => ({})) }), { instruments: [FXBTC] });
    await expect(odd.getBalance()).rejects.toThrow(/不正/);
    const none = ccxt(mockEx({}), { instruments: [FXBTC] });
    await expect(none.getBalance()).rejects.toThrow(/getcollateral|privateGetGetcollateral/);
  });
});

describe("OandaBroker: 拒否の分類・手数料の通貨", () => {
  const oreq = { clientId: "k1", symbol: "USD/JPY", side: "buy" as const, type: "market" as const, qty: "1000", strategyId: "s" };
  it("発注の POST は再試行しない。4xx (429 を含む) は rejected、5xx / 通信断は例外", async () => {
    for (const status of [400, 401, 429]) {
      const { calls, fetchImpl } = oandaMock((_u, init) => (init.method === "POST" ? jsonRes({ errorMessage: "x" }, status) : undefined));
      const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
      expect(await b.placeOrder(oreq)).toMatchObject({ status: "rejected" });
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    }
    const { calls, fetchImpl } = oandaMock((_u, init) => (init.method === "POST" ? jsonRes({ errorMessage: "x" }, 503) : undefined));
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
    await expect(b.placeOrder(oreq)).rejects.toThrow();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const net = vi.fn(async (u: any, init: any) => {
      if (init.method === "POST") throw new TypeError("fetch failed");
      return jsonRes({ account: { currency: "JPY", NAV: "1", marginAvailable: "1" } });
    }) as unknown as typeof fetch;
    await expect(new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl: net }).placeOrder(oreq)).rejects.toThrow();
  });
  it("口座通貨が取れなければ summary を取り直す。それでも不明で commission があれば feeCurrency は UNKNOWN", async () => {
    let n = 0;
    const { calls, fetchImpl } = oandaMock((url, init) => {
      if (url.endsWith("/summary")) return ++n === 1 ? jsonRes({ error: "x" }, 500) : jsonRes({ account: { currency: "JPY", NAV: "1", marginAvailable: "1" } });
      return init.method === "POST" ? jsonRes({ orderFillTransaction: fillTx }) : undefined;
    });
    const b = new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl });
    expect(await b.placeOrder(oreq)).toMatchObject({ fills: [{ fee: "12.5", feeCurrency: "JPY" }] });
    expect(calls.filter((c) => c.url.endsWith("/summary")).length).toBeGreaterThanOrEqual(2);

    const { fetchImpl: f2 } = oandaMock((url, init) => {
      if (url.endsWith("/summary")) return jsonRes({ error: "x" }, 400);
      return init.method === "POST" ? jsonRes({ orderFillTransaction: fillTx }) : undefined;
    });
    const r = await new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl: f2 }).placeOrder({ ...oreq, clientId: "k2" });
    expect(r.fills[0]).toMatchObject({ fee: "12.5", feeCurrency: "UNKNOWN" });
    // commission が 0 なら feeCurrency は付けない
    const { fetchImpl: f3 } = oandaMock((url, init) => {
      if (url.endsWith("/summary")) return jsonRes({ error: "x" }, 400);
      return init.method === "POST" ? jsonRes({ orderFillTransaction: { ...fillTx, commission: "0" } }) : undefined;
    });
    const r3 = await new OandaBroker({ mode: "live", token: "t", accountId: "A", fetchImpl: f3 }).placeOrder({ ...oreq, clientId: "k3" });
    expect(r3.fills[0]).not.toHaveProperty("feeCurrency");
  });
});

describe("AlpacaBroker: 拒否の分類・重複 client_order_id", () => {
  const areq = { clientId: "a1", symbol: "AAPL", side: "buy" as const, type: "market" as const, qty: "1", strategyId: "s" };
  const mk = (routes: (url: string, init: any) => Response | undefined) => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (u: any, init: any) => {
      calls.push({ url: String(u), method: init.method });
      return routes(String(u), init) ?? jsonRes({ message: "not found" }, 404);
    }) as unknown as typeof fetch;
    return { calls, b: new AlpacaBroker({ mode: "live", keyId: "k", secretKey: "s", paper: true, fetchImpl }) };
  };
  it("発注の POST は再試行しない。4xx (429 を含む) は rejected、5xx / 通信断は例外", async () => {
    for (const status of [403, 422, 429]) {
      const { calls, b } = mk((_u, init) => (init.method === "POST" ? jsonRes({ message: "insufficient buying power" }, status) : undefined));
      expect(await b.placeOrder(areq)).toMatchObject({ status: "rejected" });
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    }
    const { calls, b } = mk((_u, init) => (init.method === "POST" ? jsonRes({ message: "x" }, 500) : undefined));
    await expect(b.placeOrder(areq)).rejects.toThrow();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const net = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(new AlpacaBroker({ mode: "live", keyId: "k", secretKey: "s", fetchImpl: net }).placeOrder(areq)).rejects.toThrow();
  });
  it("client_order_id の重複 (422 'client_order_id must be unique') は by_client_order_id で既存の注文の状態を返す。照会できなければ例外", async () => {
    const { calls, b } = mk((url, init) => {
      if (init.method === "POST") return jsonRes({ code: 40010001, message: "client_order_id must be unique" }, 422);
      if (url.includes("by_client_order_id")) return jsonRes({ id: "E1", status: "filled", filled_qty: "1", filled_avg_price: "190", type: "market" });
      return undefined;
    });
    expect(await b.placeOrder(areq)).toMatchObject({ orderId: "E1", status: "filled" });
    expect(calls.some((c) => c.url.includes("by_client_order_id?client_order_id=a1"))).toBe(true);
    const { b: b2 } = mk((_u, init) => (init.method === "POST" ? jsonRes({ message: "client_order_id must be unique" }, 422) : undefined));
    await expect(b2.placeOrder(areq)).rejects.toThrow();
    // 重複以外の 422 (client_order_id に触れていても) は rejected
    const { b: b3 } = mk((_u, init) => (init.method === "POST" ? jsonRes({ message: "client_order_id must be at most 128 characters" }, 422) : undefined));
    expect(await b3.placeOrder(areq)).toMatchObject({ status: "rejected" });
  });
});
