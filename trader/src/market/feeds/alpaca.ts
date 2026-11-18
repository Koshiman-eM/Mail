import { fetchJson, type FetchOptions } from "../../core/http";
import { systemClock, TIMEFRAME_MS, type Candle, type Clock, type Instrument, type MarketDataFeed, type Quote, type Timeframe } from "../../core/types";

export const ALPACA_DATA_URL = "https://data.alpaca.markets";

export const ALPACA_TIMEFRAME: Partial<Record<Timeframe, string>> = {
  "1m": "1Min", "5m": "5Min", "15m": "15Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day", "1w": "1Week",
};

export interface AlpacaFeedOptions {
  keyId: string;
  secretKey: string;
  /** 対象銘柄 (米国株ティッカー)。全銘柄列挙は重いので明示する */
  symbols: string[];
  /** 空売り可否 (証拠金口座前提で既定 true) */
  allowShort?: boolean;
  /** データフィード。無料枠は "iex" */
  dataFeed?: "iex" | "sip";
  fetchImpl?: typeof fetch;
  clock?: Clock;
  dataUrl?: string;
}

export class AlpacaFeed implements MarketDataFeed {
  readonly venue = "alpaca";
  readonly minIntervalMs = 350;
  private readonly clock: Clock;

  constructor(private readonly o: AlpacaFeedOptions) {
    this.clock = o.clock ?? systemClock;
  }

  private get<T>(path: string): Promise<T> {
    const opts: FetchOptions = {
      headers: { "APCA-API-KEY-ID": this.o.keyId, "APCA-API-SECRET-KEY": this.o.secretKey },
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    };
    return fetchJson<T>(`${this.o.dataUrl ?? ALPACA_DATA_URL}${path}`, opts);
  }

  async listInstruments(): Promise<Instrument[]> {
    return this.o.symbols.map((symbol) => ({
      symbol,
      venue: this.venue,
      assetClass: "stock" as const,
      baseCurrency: symbol,
      quoteCurrency: "USD",
      tickSize: 0.01,
      lotSize: 1,
      minQty: 1,
      takerFeeRate: 0,
      makerFeeRate: 0,
      allowShort: this.o.allowShort ?? true,
    }));
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const t = ALPACA_TIMEFRAME[tf];
    if (!t) throw new Error(`未対応の時間足: ${tf}`);
    const q = new URLSearchParams({ timeframe: t, limit: String(Math.min(limit, 10_000)), adjustment: "raw", feed: this.o.dataFeed ?? "iex" });
    let desc = false;
    if (since !== undefined) {
      q.set("start", new Date(since).toISOString());
    } else {
      // 株は取引時間が限られるため、余裕を持った期間から新しい順に取得して反転する
      const span = Math.max(limit * TIMEFRAME_MS[tf] * 4, 7 * 86_400_000);
      q.set("start", new Date(this.clock.now() - span).toISOString());
      q.set("sort", "desc");
      desc = true;
    }
    const res = await this.get<{ bars: any[] | null }>(`/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`);
    const bars = (res.bars ?? []).map((b) => ({
      ts: Date.parse(b.t),
      open: Number(b.o),
      high: Number(b.h),
      low: Number(b.l),
      close: Number(b.c),
      volume: Number(b.v ?? 0),
    }));
    return desc ? bars.reverse() : bars;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const res = await this.get<{ quote: any }>(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=${this.o.dataFeed ?? "iex"}`);
    const q = res.quote;
    const bid = Number(q?.bp);
    const ask = Number(q?.ap);
    if (!(bid > 0) || !(ask > 0)) throw new Error(`Alpaca quote が無効: ${symbol}`);
    return { ts: Date.parse(q.t), bid, ask, bidSize: Number(q.bs ?? 0), askSize: Number(q.as ?? 0), last: (bid + ask) / 2 };
  }
}
