/**
 * バックテスト用: GeckoTerminal のプールの OHLCV を MarketDataFeed の形で返す (`backtest --source jupiter --token <mint|symbol>`)。
 * - fetchCandles(symbol, tf, limit, since) は GeckoTerminalClient.fetchOhlcv (新しい順にさかのぼるページング・確定足のキャッシュ) を呼ぶ。
 *   since があればそこまでさかのぼる (1 ページ 1000 本。GECKO_CALLS_PER_MIN の枠で待つ。1m の 30 日分は約 44 回)。
 * - 気配は無い (バックテストは足だけを使う)。銘柄は 1 つ (jupiterInstrument で作ったもの。コストは costModel とネットワーク手数料)。
 * - GeckoTerminal が古い 1m の足をどこまで返すかは未確認 (要確認)。足りなければ「足を取得できませんでした」・短い期間になる。
 */
import { GECKO_MAX_LIMIT, type GeckoTerminalClient } from "../jupiter/gecko";
import { TIMEFRAME_MS, type Candle, type Instrument, type MarketDataFeed, type Quote, type Timeframe } from "../../core/types";

export class GeckoHistoryFeed implements MarketDataFeed {
  readonly venue: string;

  constructor(
    private readonly gecko: GeckoTerminalClient,
    private readonly inst: Instrument,
    private readonly pool: string,
    private readonly now: () => number = Date.now,
  ) {
    this.venue = inst.venue;
  }

  async listInstruments(): Promise<Instrument[]> {
    return [this.inst];
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    if (symbol !== this.inst.symbol) return [];
    const bars = since !== undefined ? Math.ceil((this.now() - since) / TIMEFRAME_MS[tf]) + 2 : limit;
    const maxPages = Math.min(200, Math.ceil(bars / GECKO_MAX_LIMIT) + 1);
    return this.gecko.fetchOhlcv(this.pool, tf, { limit: Math.max(1, limit), ...(since !== undefined ? { since } : {}), maxPages });
  }

  async fetchQuote(): Promise<Quote> {
    throw new Error("GeckoHistoryFeed は気配を返しません (バックテスト専用)");
  }
}
