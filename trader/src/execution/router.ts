import { createRequire } from "node:module";
import type { AppConfig } from "../core/config";
import type { Broker, Clock, Instrument, Quote } from "../core/types";
import { AlpacaBroker } from "./alpacaBroker";
import { CcxtBroker, type CcxtTradeLike } from "./ccxtBroker";
import { GmoBroker } from "./gmoBroker";
import { OandaBroker } from "./oandaBroker";
import { PaperBroker, type PaperBrokerOptions } from "./paper";

export interface BrokerDeps {
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** 最新気配 (paper の約定・評価、ccxt 現物の保有の評価に使う) */
  quoteProvider?: (symbol: string) => Quote | undefined;
  /** 通貨 -> 口座通貨の換算レート (換算できなければ NaN)。paper と ccxt の評価額に使う */
  toAccount?: (ccy: string) => number;
  /** paper モード用の追加設定 (quoteProvider / toAccount を個別に上書きできる) */
  paper?: Partial<Omit<PaperBrokerOptions, "instruments" | "baseCurrency" | "initialEquity">>;
  /** live の ccxt exchange 生成 (テストで差し替え)。既定は ccxt を require して生成 */
  createExchange?: (exchangeId: string, cred: { apiKey: string; secret: string; password?: string }) => CcxtTradeLike;
}

export interface BrokerSet {
  mode: "paper" | "live";
  brokers: Map<string, Broker>;
  /** paper モードのときの PaperBroker (onQuote / snapshot 用) */
  paper?: PaperBroker;
  brokerFor(symbol: string): Broker;
}

const defaultCreateExchange: NonNullable<BrokerDeps["createExchange"]> = (id, cred) => {
  const ccxt = createRequire(import.meta.url)("ccxt") as Record<string, any>;
  const Ctor = ccxt[id];
  if (typeof Ctor !== "function") throw new Error(`ccxt に取引所 ${id} がありません`);
  return new Ctor({ apiKey: cred.apiKey, secret: cred.secret, password: cred.password || undefined, enableRateLimit: true });
};

/**
 * paper: 全 venue を単一の PaperBroker で処理 (実アダプターは一切生成しない)。
 * live: VENUES に設定された venue だけ実アダプターを生成。キー未設定はエラー。
 */
export function createBrokers(config: AppConfig, instruments: Instrument[], deps: BrokerDeps = {}): BrokerSet {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  if (config.mode !== "live") {
    const paper = new PaperBroker({
      instruments,
      baseCurrency: config.env.BASE_CURRENCY,
      initialEquity: config.env.PAPER_INITIAL_EQUITY,
      // paper で再現する空売りの借入コスト (日率)。live の経路 (下) には渡さない
      shortBorrowRateDaily: config.env.PAPER_SHORT_BORROW_RATE_DAILY,
      clock: deps.clock,
      ...(deps.quoteProvider ? { quoteProvider: deps.quoteProvider } : {}),
      ...(deps.toAccount ? { toAccount: deps.toAccount } : {}),
      ...(deps.paper ?? {}),
    });
    return {
      mode: "paper",
      brokers: new Map([["paper", paper]]),
      paper,
      brokerFor(symbol) {
        if (!bySymbol.has(symbol)) throw new Error(`未知の銘柄: ${symbol}`);
        return paper;
      },
    };
  }

  const env = config.env;
  const enabled = new Set(env.VENUES.split(",").map((s) => s.trim()).filter(Boolean));
  const venues = [...new Set(instruments.map((i) => i.venue))].filter((v) => enabled.has(v));
  const brokers = new Map<string, Broker>();
  const guard = { mode: config.mode } as const;
  // ccxt 現物の評価額に使う。互換のため deps.paper 側に渡されたものも使う
  const quoteProvider = deps.quoteProvider ?? deps.paper?.quoteProvider;
  const toAccount = deps.toAccount ?? deps.paper?.toAccount;

  for (const v of venues) {
    if (v.startsWith("ccxt:")) {
      if (!env.CCXT_API_KEY || !env.CCXT_SECRET) throw new Error(`${v}: CCXT_API_KEY / CCXT_SECRET が未設定です`);
      const exId = v.slice("ccxt:".length);
      const exchange = (deps.createExchange ?? defaultCreateExchange)(exId, { apiKey: env.CCXT_API_KEY, secret: env.CCXT_SECRET, password: env.CCXT_PASSWORD });
      brokers.set(
        v,
        new CcxtBroker({
          ...guard,
          exchange,
          accountCurrency: env.BASE_CURRENCY,
          instruments: instruments.filter((i) => i.venue === v),
          ...(quoteProvider ? { quoteProvider } : {}),
          ...(toAccount ? { toAccount } : {}),
        }),
      );
    } else if (v === "gmo") {
      if (!env.GMO_API_KEY || !env.GMO_API_SECRET) throw new Error("gmo: GMO_API_KEY / GMO_API_SECRET が未設定です");
      brokers.set(
        v,
        new GmoBroker({
          ...guard,
          // POST を許可したクライアントは GmoBroker が assertLive の後に作る (ここでは渡さない)
          clientOptions: { apiKey: env.GMO_API_KEY, apiSecret: env.GMO_API_SECRET, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
          instruments: instruments.filter((i) => i.venue === v),
          accountCurrency: "JPY",
        }),
      );
    } else if (v === "oanda") {
      if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) throw new Error("oanda: OANDA_API_TOKEN / OANDA_ACCOUNT_ID が未設定です");
      brokers.set(
        v,
        new OandaBroker({
          ...guard,
          token: env.OANDA_API_TOKEN,
          accountId: env.OANDA_ACCOUNT_ID,
          env: env.OANDA_ENV === "live" ? "live" : "practice",
          fetchImpl: deps.fetchImpl,
          instruments: instruments.filter((i) => i.venue === v),
        }),
      );
    } else if (v === "alpaca") {
      if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) throw new Error("alpaca: ALPACA_KEY_ID / ALPACA_SECRET_KEY が未設定です");
      brokers.set(v, new AlpacaBroker({ ...guard, keyId: env.ALPACA_KEY_ID, secretKey: env.ALPACA_SECRET_KEY, paper: env.ALPACA_PAPER === "true", fetchImpl: deps.fetchImpl }));
    } else {
      throw new Error(`${v}: live 用の発注アダプターがありません`);
    }
  }

  return {
    mode: "live",
    brokers,
    brokerFor(symbol) {
      const inst = bySymbol.get(symbol);
      if (!inst) throw new Error(`未知の銘柄: ${symbol}`);
      const b = brokers.get(inst.venue);
      if (!b) throw new Error(`${symbol}: venue ${inst.venue} は有効化されていません (VENUES を確認)`);
      return b;
    },
  };
}
