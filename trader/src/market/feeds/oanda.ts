import { fetchJson, type FetchOptions } from "../../core/http";
import type { Candle, Instrument, MarketDataFeed, Quote, Timeframe } from "../../core/types";

export const OANDA_HOSTS = { practice: "https://api-fxpractice.oanda.com", live: "https://api-fxtrade.oanda.com" } as const;

export const OANDA_GRANULARITY: Partial<Record<Timeframe, string>> = {
  "1m": "M1", "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4", "1d": "D", "1w": "W",
};

/** "USD/JPY" -> "USD_JPY" */
export const toOandaSymbol = (s: string) => s.replace("/", "_");
/** "USD_JPY" -> "USD/JPY" */
export const fromOandaSymbol = (s: string) => s.replace("_", "/");

/** OANDA の時刻 (ナノ秒精度 RFC3339) を ms へ */
export function parseOandaTime(t: string): number {
  return Date.parse(t.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
}

export interface OandaFeedOptions {
  token: string;
  accountId: string;
  env?: "practice" | "live";
  fetchImpl?: typeof fetch;
  /** 銘柄の絞り込み (例: ["USD/JPY"])。空なら全 CURRENCY */
  symbols?: string[];
}

export class OandaFeed implements MarketDataFeed {
  readonly venue = "oanda";
  readonly minIntervalMs = 100;
  private readonly base: string;
  private instruments?: Instrument[];

  constructor(private readonly o: OandaFeedOptions) {
    this.base = OANDA_HOSTS[o.env ?? "practice"];
  }

  private get<T>(path: string): Promise<T> {
    const opts: FetchOptions = {
      headers: { authorization: `Bearer ${this.o.token}` },
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    };
    return fetchJson<T>(`${this.base}${path}`, opts);
  }

  async listInstruments(): Promise<Instrument[]> {
    if (this.instruments) return this.instruments;
    const res = await this.get<{ instruments: any[] }>(`/v3/accounts/${this.o.accountId}/instruments`);
    const filter = this.o.symbols?.length ? new Set(this.o.symbols) : undefined;
    const out: Instrument[] = [];
    for (const i of res.instruments ?? []) {
      if (i.type !== "CURRENCY") continue;
      const symbol = fromOandaSymbol(i.name);
      if (filter && !filter.has(symbol)) continue;
      const [base, quote] = symbol.split("/");
      const lot = Number(`1e-${Math.max(0, Number(i.tradeUnitsPrecision ?? 0))}`);
      out.push({
        symbol,
        venue: this.venue,
        assetClass: "fx",
        baseCurrency: base,
        quoteCurrency: quote,
        tickSize: Number(`1e-${Number(i.displayPrecision ?? 5)}`),
        lotSize: lot,
        minQty: Number(i.minimumTradeSize ?? lot) || lot,
        // 手数料は無く、コストはスプレッドで表現される
        takerFeeRate: 0,
        makerFeeRate: 0,
        allowShort: true,
        contractSize: 1,
      });
    }
    this.instruments = out;
    return out;
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const g = OANDA_GRANULARITY[tf];
    if (!g) throw new Error(`未対応の時間足: ${tf}`);
    const q = new URLSearchParams({ granularity: g, price: "MBA", count: String(Math.min(limit, 5000)) });
    if (since !== undefined) q.set("from", String(since / 1000));
    const res = await this.get<{ candles: any[] }>(`/v3/instruments/${toOandaSymbol(symbol)}/candles?${q}`);
    return (res.candles ?? [])
      .filter((c) => c.mid)
      .map((c) => ({
        ts: parseOandaTime(c.time),
        open: Number(c.mid.o),
        high: Number(c.mid.h),
        low: Number(c.mid.l),
        close: Number(c.mid.c),
        volume: Number(c.volume ?? 0),
      }));
  }

  async fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const q = new URLSearchParams({ instruments: symbols.map(toOandaSymbol).join(",") });
    const res = await this.get<{ prices: any[] }>(`/v3/accounts/${this.o.accountId}/pricing?${q}`);
    const out: Record<string, Quote> = {};
    for (const p of res.prices ?? []) {
      const bid = Number(p.bids?.[0]?.price ?? p.closeoutBid);
      const ask = Number(p.asks?.[0]?.price ?? p.closeoutAsk);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
      out[fromOandaSymbol(p.instrument)] = {
        ts: parseOandaTime(p.time),
        bid,
        ask,
        ...(p.bids?.[0]?.liquidity !== undefined ? { bidSize: Number(p.bids[0].liquidity) } : {}),
        ...(p.asks?.[0]?.liquidity !== undefined ? { askSize: Number(p.asks[0].liquidity) } : {}),
        last: (bid + ask) / 2,
      };
    }
    return out;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const q = (await this.fetchQuotes([symbol]))[symbol];
    if (!q) throw new Error(`OANDA pricing に ${symbol} がありません`);
    return q;
  }
}
