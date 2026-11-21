import type { AppConfig } from "../core/config";
import type { Broker, Clock, Instrument, Quote } from "../core/types";
import { GmoBroker } from "./gmoBroker";
import { PaperBroker, type PaperBrokerOptions } from "./paper";

export interface BrokerDeps {
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** 最新気配 (paper の約定・評価に使う) */
  quoteProvider?: (symbol: string) => Quote | undefined;
  /** 通貨 -> 口座通貨の換算レート (換算できなければ NaN)。paper の評価額に使う */
  toAccount?: (ccy: string) => number;
  /** paper モード用の追加設定 (quoteProvider / toAccount を個別に上書きできる) */
  paper?: Partial<Omit<PaperBrokerOptions, "instruments" | "baseCurrency" | "initialEquity">>;
}

export interface BrokerSet {
  mode: "paper" | "live";
  brokers: Map<string, Broker>;
  /** paper モードのときの PaperBroker (onQuote / snapshot 用) */
  paper?: PaperBroker;
  brokerFor(symbol: string): Broker;
}

/**
 * paper: 全 venue を単一の PaperBroker で処理 (実アダプターは一切生成しない)。
 * live: 実口座アダプターは GMOコイン (gmo) だけ。VENUES に設定された venue だけ生成し、キー未設定はエラー。
 * gmo 以外の venue (ccxt:<id> など) の銘柄があれば例外にする (fail-closed。発注先の無い銘柄を live で扱わない)
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
  // live で発注できるのは GMOコインだけ。ほかの取引先 (ccxt:<id>・paper など) の銘柄があれば起動を止める
  const others = [...new Set(instruments.map((i) => i.venue))].filter((v) => v !== "gmo");
  if (others.length > 0) {
    throw new Error(`${others.join(", ")}: live 用の発注アダプターがありません (live の発注は GMOコインの gmo だけです。VENUES / WATCHLIST を確認)`);
  }
  const enabled = new Set(env.VENUES.split(",").map((s) => s.trim()).filter(Boolean));
  const brokers = new Map<string, Broker>();
  if (enabled.has("gmo") && instruments.length > 0) {
    if (!env.GMO_API_KEY || !env.GMO_API_SECRET) throw new Error("gmo: GMO_API_KEY / GMO_API_SECRET が未設定です");
    brokers.set(
      "gmo",
      new GmoBroker({
        mode: config.mode,
        // POST を許可したクライアントは GmoBroker が assertLive の後に作る (ここでは渡さない)
        clientOptions: { apiKey: env.GMO_API_KEY, apiSecret: env.GMO_API_SECRET, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
        instruments,
        accountCurrency: "JPY",
      }),
    );
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
