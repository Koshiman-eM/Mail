/**
 * 発注先の組 (BrokerSet)。銘柄ごとに発注先 (Broker) を引く。
 *
 * - paper (`createPaperBrokerSet`): 全銘柄を単一の PaperBroker で処理する (実口座アダプターは一切生成しない)。
 * - live (`liveBrokerSet`): アプリが作った実口座アダプター (venue → Broker) をまとめる。どれかの銘柄の venue に
 *   アダプターが無ければ例外 (発注先の無い銘柄を live で扱わない。fail-closed)。
 *   実口座アダプターはコンストラクタで assertLive (src/execution/guard.ts) を呼び、paper / test モードでの生成を拒否すること
 *   (TRADING_MODE=live と LIVE_TRADING_CONFIRM の二重ロックは src/core/config.ts の resolveMode)。
 */
import type { AppConfig } from "../core/config";
import type { Broker, Clock, Instrument, Quote } from "../core/types";
import { PaperBroker, type PaperBrokerOptions } from "./paper";

export interface BrokerDeps {
  clock?: Clock;
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

/** paper: 全 venue を単一の PaperBroker で処理する (config.mode によらず paper。live の判定は呼び出し側) */
export function createPaperBrokerSet(config: Pick<AppConfig, "env">, instruments: Instrument[], deps: BrokerDeps = {}): BrokerSet {
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const paper = new PaperBroker({
    instruments,
    baseCurrency: config.env.BASE_CURRENCY,
    initialEquity: config.env.PAPER_INITIAL_EQUITY,
    // paper で再現する空売りの借入コスト (日率)
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

/**
 * live: venue → 実口座アダプター の組。銘柄の venue (完全一致) でアダプターを引く。
 * アダプターの無い venue の銘柄が 1 つでもあれば例外 (起動を止める)
 */
export function liveBrokerSet(brokers: ReadonlyMap<string, Broker> | Record<string, Broker>, instruments: readonly Instrument[]): BrokerSet {
  const map = brokers instanceof Map ? new Map(brokers) : new Map(Object.entries(brokers));
  const missing = [...new Set(instruments.filter((i) => !map.has(i.venue)).map((i) => `${i.symbol} (${i.venue})`))];
  if (missing.length > 0) throw new Error(`live の発注先 (実口座アダプター) が無い銘柄があります: ${missing.join(", ")}`);
  const venueOf = new Map(instruments.map((i) => [i.symbol, i.venue]));
  return {
    mode: "live",
    brokers: map,
    brokerFor(symbol) {
      const v = venueOf.get(symbol);
      const b = v === undefined ? undefined : map.get(v);
      if (!b) throw new Error(`未知の銘柄: ${symbol}`);
      return b;
    },
  };
}
