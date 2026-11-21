import type { AppConfig } from "../core/config";
import type { Broker, Clock, Instrument, Quote } from "../core/types";
import { PaperBroker, type PaperBrokerOptions } from "./paper";

/**
 * live の発注先 (実口座アダプター) が無いことを知らせる文言 (起動を止めるときに出す)。
 * GMOコインは廃止した。Solana の DEX アグリゲーター Jupiter の実弾は次の段階で実装する
 */
export const LIVE_UNSUPPORTED_MESSAGE = "live の発注先は未対応です (Jupiter の実弾は次の段階で実装予定)";

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

/**
 * paper: 全 venue を単一の PaperBroker で処理 (実アダプターは一切生成しない)。
 * live: 実口座アダプターはまだ無いので、常に例外にする (fail-closed。発注先の無い銘柄を live で扱わない)。
 * 実口座アダプターを加えるときは、そのコンストラクタで assertLive (src/execution/guard.ts) を呼び、
 * paper / test モードでの生成を拒否すること (TRADING_MODE=live と LIVE_TRADING_CONFIRM の二重ロックは config.ts の resolveMode)
 */
export function createBrokers(config: AppConfig, instruments: Instrument[], deps: BrokerDeps = {}): BrokerSet {
  if (config.mode === "live") throw new Error(LIVE_UNSUPPORTED_MESSAGE);

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
