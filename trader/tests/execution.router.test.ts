import { describe, expect, it, vi } from "vitest";
import { loadConfig, LIVE_CONFIRM_PHRASE } from "../src/core/config";
import { createBrokers } from "../src/execution/router";
import { PaperBroker } from "../src/execution/paper";
import { CcxtBroker, type CcxtTradeLike } from "../src/execution/ccxtBroker";
import { OandaBroker } from "../src/execution/oandaBroker";
import { AlpacaBroker } from "../src/execution/alpacaBroker";
import type { Instrument } from "../src/core/types";

const inst = (symbol: string, venue: string, assetClass: Instrument["assetClass"] = "crypto"): Instrument => ({
  symbol, venue, assetClass, baseCurrency: symbol.split("/")[0], quoteCurrency: "USD", tickSize: 0.01, lotSize: 1, minQty: 1, takerFeeRate: 0, makerFeeRate: 0, allowShort: true,
});
const insts = [inst("BTC/JPY", "ccxt:bitflyer"), inst("USD/JPY", "oanda", "fx"), inst("AAPL", "alpaca", "stock")];
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

const liveEnv = {
  TRADING_MODE: "live", LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE, NODE_ENV: "production",
  VENUES: "ccxt:bitflyer,oanda,alpaca", CCXT_API_KEY: "k", CCXT_SECRET: "s", OANDA_API_TOKEN: "t", OANDA_ACCOUNT_ID: "a", ALPACA_KEY_ID: "k", ALPACA_SECRET_KEY: "s",
};

const fakeEx = (): CcxtTradeLike => ({
  id: "bitflyer",
  has: {},
  fetchBalance: vi.fn(async () => ({ total: { JPY: 1000, BTC: 0.5 }, free: { JPY: 900 } })),
  createOrder: vi.fn(async () => ({ id: "o1", status: "closed", filled: 1, average: 100, fee: { cost: 0.1 } })),
  cancelOrder: vi.fn(async () => ({})),
});

describe("安全ガード: live 用アダプターは paper/test で生成不可", () => {
  const ccxtOpts = { exchange: fakeEx(), accountCurrency: "JPY", instruments: insts };
  it("mode が live でなければ throw", () => {
    expect(() => new CcxtBroker({ ...ccxtOpts, mode: "paper" })).toThrow(/生成できません/);
    expect(() => new OandaBroker({ mode: "paper", token: "t", accountId: "a" })).toThrow(/生成できません/);
    expect(() => new AlpacaBroker({ mode: "backtest", keyId: "k", secretKey: "s" })).toThrow(/生成できません/);
    // @ts-expect-error mode 未指定
    expect(() => new OandaBroker({ token: "t", accountId: "a" })).toThrow();
  });
  it("mode=live でも NODE_ENV=test なら throw", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(() => new CcxtBroker({ ...ccxtOpts, mode: "live" })).toThrow(/NODE_ENV=test/);
    expect(() => new OandaBroker({ mode: "live", token: "t", accountId: "a" })).toThrow(/NODE_ENV=test/);
    expect(() => new AlpacaBroker({ mode: "live", keyId: "k", secretKey: "s" })).toThrow(/NODE_ENV=test/);
  });
});

describe("createBrokers", () => {
  it("paper モードは全 venue を PaperBroker で処理 (実アダプターを作らない)", () => {
    const createExchange = vi.fn();
    const cfg = loadConfig({ TRADING_MODE: "live", VENUES: "ccxt:bitflyer,oanda,alpaca", CCXT_API_KEY: "k", CCXT_SECRET: "s" }); // 確認フレーズ無し → paper
    expect(cfg.mode).toBe("paper");
    const set = createBrokers(cfg, insts, { createExchange });
    expect(set.mode).toBe("paper");
    for (const i of insts) {
      const b = set.brokerFor(i.symbol);
      expect(b).toBeInstanceOf(PaperBroker);
      expect(b.mode).toBe("paper");
    }
    expect([...set.brokers.values()].every((b) => b instanceof PaperBroker)).toBe(true);
    expect(createExchange).not.toHaveBeenCalled();
    expect(() => set.brokerFor("NOPE")).toThrow();
  });

  it("live モード: NODE_ENV=test 下では実アダプター生成が必ず失敗する", () => {
    const cfg = { ...loadConfig(liveEnv), mode: "live" as const }; // resolveMode を迂回して強制
    expect(() => createBrokers(cfg, insts, { createExchange: fakeEx as any, fetchImpl: vi.fn() as any })).toThrow(/NODE_ENV=test/);
  });

  it("live モード: キー未設定の venue はエラー (NODE_ENV を一時的に変えて検証)", () => {
    const orig = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const base = { ...liveEnv };
      const cfgOf = (e: Record<string, string>) => loadConfig(e);
      expect(cfgOf(base).mode).toBe("live");
      expect(() => createBrokers(cfgOf({ ...base, CCXT_SECRET: "" }), insts, { createExchange: fakeEx })).toThrow(/CCXT_API_KEY/);
      expect(() => createBrokers(cfgOf({ ...base, OANDA_API_TOKEN: "" }), insts, { createExchange: fakeEx })).toThrow(/OANDA/);
      expect(() => createBrokers(cfgOf({ ...base, ALPACA_KEY_ID: "" }), insts, { createExchange: fakeEx })).toThrow(/ALPACA/);
      // 全部そろえば生成でき、有効化していない venue は brokerFor でエラー
      const set = createBrokers(cfgOf({ ...base, VENUES: "oanda" }), insts, { createExchange: fakeEx });
      expect(set.brokerFor("USD/JPY")).toBeInstanceOf(OandaBroker);
      expect(() => set.brokerFor("AAPL")).toThrow(/有効化されていません/);
      const all = createBrokers(cfgOf(base), insts, { createExchange: fakeEx });
      expect(all.brokerFor("BTC/JPY")).toBeInstanceOf(CcxtBroker);
      expect(all.brokerFor("AAPL")).toBeInstanceOf(AlpacaBroker);
      expect(all.brokerFor("AAPL").mode).toBe("live");
      // paper venue は live では扱えない
      expect(() => createBrokers(cfgOf({ ...base, VENUES: "paper" }), [inst("X/Y", "paper")], {})).toThrow(/アダプターがありません/);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

describe("実口座アダプターの挙動 (モック・NODE_ENV を一時変更)", () => {
  const withProd = async (fn: () => Promise<void>) => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try { await fn(); } finally { process.env.NODE_ENV = orig; }
  };

  it("ccxt: clientOrderId を渡し、同じ clientId は再送しない", async () => {
    await withProd(async () => {
      const ex = fakeEx();
      const b = new CcxtBroker({ mode: "live", exchange: ex, accountCurrency: "JPY", instruments: insts });
      const req = { clientId: "cid-1", symbol: "BTC/JPY", side: "buy" as const, type: "market" as const, qty: "1", strategyId: "s" };
      const r = await b.placeOrder(req);
      await b.placeOrder(req);
      expect(ex.createOrder).toHaveBeenCalledTimes(1);
      expect((ex.createOrder as any).mock.calls[0][5]).toMatchObject({ clientOrderId: "cid-1" });
      expect(r).toMatchObject({ status: "filled" });
      expect(r.fills[0]).toMatchObject({ price: 100, fee: "0.1" });
      expect(await b.getBalance()).toEqual({ currency: "JPY", equity: "1000", available: "900" });
      expect(await b.getPositions()).toEqual([{ symbol: "BTC/JPY", qty: "0.5", avgPrice: 0 }]);
    });
  });

  it("oanda: units は符号付き、clientExtensions.id、POST は再試行しない", async () => {
    await withProd(async () => {
      const calls: any[] = [];
      const fetchImpl = vi.fn(async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        if (init.method === "POST") return jsonRes({ orderFillTransaction: { id: "7", orderID: "6", price: "150.01", units: "-100", time: "2025-01-01T00:00:00.000000000Z" } });
        if (String(url).includes("openPositions")) return jsonRes({ positions: [{ instrument: "USD_JPY", long: { units: "0" }, short: { units: "-100", averagePrice: "150.01" } }] });
        return jsonRes({ account: { currency: "JPY", NAV: "1000000", marginAvailable: "900000" } });
      }) as unknown as typeof fetch;
      const b = new OandaBroker({ mode: "live", token: "tok", accountId: "101-1", fetchImpl });
      const r = await b.placeOrder({ clientId: "c1", symbol: "USD/JPY", side: "sell", type: "market", qty: "100", strategyId: "s" });
      const body = JSON.parse(calls[0].init.body);
      expect(calls[0].url).toBe("https://api-fxpractice.oanda.com/v3/accounts/101-1/orders");
      expect(body.order).toMatchObject({ type: "MARKET", instrument: "USD_JPY", units: "-100", clientExtensions: { id: "c1" } });
      expect(r).toMatchObject({ status: "filled", fills: [{ price: 150.01, qty: "100" }] });
      expect(await b.getPositions()).toEqual([{ symbol: "USD/JPY", qty: "-100", avgPrice: 150.01 }]);
      expect((await b.getBalance()).equity).toBe("1000000");
    });
  });

  it("alpaca: client_order_id、paper URL、ショートの符号", async () => {
    await withProd(async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: any, init: any) => {
        calls.push(`${init.method} ${url}`);
        if (init.method === "POST") return jsonRes({ id: "a1", status: "new", filled_qty: "0" });
        if (String(url).endsWith("/v2/positions")) return jsonRes([{ symbol: "AAPL", qty: "10", side: "short", avg_entry_price: "190" }]);
        return jsonRes({ currency: "USD", equity: "10000", buying_power: "20000" });
      }) as unknown as typeof fetch;
      const b = new AlpacaBroker({ mode: "live", keyId: "k", secretKey: "s", paper: true, fetchImpl });
      const r = await b.placeOrder({ clientId: "x1", symbol: "AAPL", side: "sell", type: "limit", qty: "10", limitPrice: 191, strategyId: "s" });
      expect(r.status).toBe("open");
      expect(calls[0]).toBe("POST https://paper-api.alpaca.markets/v2/orders");
      expect((fetchImpl as any).mock.calls[0][1].body).toContain('"client_order_id":"x1"');
      expect(await b.getPositions()).toEqual([{ symbol: "AAPL", qty: "-10", avgPrice: 190 }]);
      expect(await b.getBalance()).toMatchObject({ equity: "10000", available: "20000" });
    });
  });
});
