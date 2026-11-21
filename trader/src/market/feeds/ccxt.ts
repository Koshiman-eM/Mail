import { createRequire } from "node:module";
import type { AssetClass, Candle, Instrument, MarketDataFeed, OrderBook, Quote, Timeframe, TradePrint } from "../../core/types";
import { fetchBitbankCandles, type BitbankBoundary } from "./bitbankCandles";
import { fileCandleRefreshIntervalMs } from "../fileCandles";

/** ccxt の exchange のうち使う部分だけの型 (テストでモック可能) */
export interface CcxtLike {
  id: string;
  precisionMode?: number;
  rateLimit?: number;
  markets?: Record<string, unknown>;
  /** ccxt の機能表。fetchOHLCV が falsy (undefined / false) なら足を取得できない (例: bitflyer) */
  has?: Record<string, unknown>;
  loadMarkets(): Promise<Record<string, any>>;
  fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<number[][]>;
  fetchTicker(symbol: string): Promise<any>;
  fetchOrderBook(symbol: string, limit?: number): Promise<any>;
  fetchTrades(symbol: string, since?: number, limit?: number): Promise<any[]>;
}

/** ccxt の precisionMode 定数 */
export const PRECISION = { DECIMAL_PLACES: 2, SIGNIFICANT_DIGITS: 3, TICK_SIZE: 4 } as const;

export const DEFAULT_MEME_BASES = [
  "DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI", "BOME", "MEME", "TRUMP", "MOG", "POPCAT", "BRETT", "NEIRO", "PNUT", "MEW",
];

export interface CcxtFeedOptions {
  /** venue 名。既定 "ccxt:<exchange.id>" */
  venue?: string;
  /** ミームコインのベース通貨 (既定一覧に追加) */
  extraMemeBases?: string[];
  /** 手数料が market に無いときの既定値 */
  defaultTakerFee?: number;
  defaultMakerFee?: number;
  /** 対象のクオート通貨 (空なら全て) */
  quoteFilter?: string[];
  /** 現在時刻 (テスト用。既定 Date.now) */
  now?: () => number;
}

const toNumber = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 精度値を刻み幅へ変換 (TICK_SIZE は値そのもの、DECIMAL_PLACES/SIGNIFICANT_DIGITS は 10^-n) */
export function precisionToStep(value: unknown, mode: number | undefined): number | undefined {
  const n = toNumber(value);
  if (n === undefined) return undefined;
  if (mode === PRECISION.TICK_SIZE) return n > 0 ? n : undefined;
  // 小数桁数。ただし 1 未満の値が来た場合は既に刻み幅とみなす
  if (n > 0 && n < 1) return n;
  return Number(`1e-${Math.max(0, Math.round(n))}`);
}

export function marketToInstrument(
  m: any,
  precisionMode: number | undefined,
  venue: string,
  memeBases: Set<string>,
  defaults: { taker: number; maker: number },
): Instrument | undefined {
  if (!m || m.active === false || !m.symbol || !m.base || !m.quote) return undefined;
  const isSpot = m.spot === true || m.type === "spot";
  const tickSize = precisionToStep(m.precision?.price, precisionMode) ?? 0.01;
  const lotSize = precisionToStep(m.precision?.amount, precisionMode) ?? 1e-8;
  const minQty = toNumber(m.limits?.amount?.min) ?? lotSize;
  const minNotional = toNumber(m.limits?.cost?.min);
  const contractSize = toNumber(m.contractSize);
  const assetClass: AssetClass = memeBases.has(String(m.base).toUpperCase()) ? "meme" : "crypto";
  return {
    symbol: m.symbol,
    venue,
    assetClass,
    baseCurrency: m.base,
    quoteCurrency: m.quote,
    tickSize,
    lotSize,
    minQty,
    ...(minNotional !== undefined ? { minNotional } : {}),
    takerFeeRate: toNumber(m.taker) ?? defaults.taker,
    makerFeeRate: toNumber(m.maker) ?? defaults.maker,
    allowShort: !isSpot,
    ...(contractSize !== undefined && !isSpot ? { contractSize } : {}),
  };
}

const TF_MAP: Partial<Record<Timeframe, string>> = {
  "1s": "1s", "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w",
};

export class CcxtFeed implements MarketDataFeed {
  readonly venue: string;
  readonly minIntervalMs: number;
  private instruments?: Instrument[];
  private readonly memeBases: Set<string>;
  /** bitbank のローソク足ファイルの日付境界 (取得データから判定できたら保持) */
  private readonly bitbankBoundary: Partial<Record<"day" | "year", BitbankBoundary>> = {};

  constructor(
    private readonly exchange: CcxtLike,
    private readonly opts: CcxtFeedOptions = {},
  ) {
    this.venue = opts.venue ?? `ccxt:${exchange.id}`;
    this.minIntervalMs = exchange.rateLimit ?? 200;
    this.memeBases = new Set([...DEFAULT_MEME_BASES, ...(opts.extraMemeBases ?? [])].map((s) => s.toUpperCase()));
  }

  /** 公開 API のみ (キー不要) の exchange を生成して Feed を作る。ccxt は CJS 同梱のため同期 require */
  static create(exchangeId: string, opts: CcxtFeedOptions = {}): CcxtFeed {
    const ccxt = createRequire(import.meta.url)("ccxt") as Record<string, any>;
    const Ctor = ccxt[exchangeId];
    if (typeof Ctor !== "function") throw new Error(`ccxt に取引所 ${exchangeId} がありません`);
    return new CcxtFeed(new Ctor({ enableRateLimit: true }) as CcxtLike, opts);
  }

  async listInstruments(): Promise<Instrument[]> {
    if (this.instruments) return this.instruments;
    const markets = await this.exchange.loadMarkets();
    const defaults = { taker: this.opts.defaultTakerFee ?? 0.001, maker: this.opts.defaultMakerFee ?? 0.001 };
    const out: Instrument[] = [];
    for (const m of Object.values(markets)) {
      const inst = marketToInstrument(m, this.exchange.precisionMode, this.venue, this.memeBases, defaults);
      if (!inst) continue;
      if (this.opts.quoteFilter?.length && !this.opts.quoteFilter.includes(inst.quoteCurrency)) continue;
      out.push(inst);
    }
    this.instruments = out;
    return out;
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const t = TF_MAP[tf];
    if (!t) throw new Error(`未対応の時間足: ${tf}`);
    if (this.exchange.has && !this.exchange.has.fetchOHLCV) {
      throw new Error(
        `取引所 ${this.exchange.id} は ccxt でローソク足 (fetchOHLCV) を提供していません。` +
          "ローソク足が必要な処理 (バックテスト等) には別の取引所を CCXT_EXCHANGE に指定してください",
      );
    }
    if (this.exchange.id === "bitbank") {
      return fetchBitbankCandles(
        { exchange: this.exchange, now: (this.opts.now ?? Date.now)(), boundary: this.bitbankBoundary },
        symbol, tf, limit, since,
      );
    }
    const rows = await this.exchange.fetchOHLCV(symbol, t, since, limit);
    return rows
      .map((r) => ({ ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] ?? 0) }))
      .filter((c) => Number.isFinite(c.close))
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * MarketHub の毎回更新で、同じ (銘柄, 時間足) の足を取り直す最短間隔 (ms)。0 なら毎回取る (従来どおり)。
   * bitbank は 1 回の更新でファイル (1 日 / 1 年分) を丸ごと返すため間引く。
   * 正の値を返す feed には、hub は since (最後に持っている足の ts) を付けて差分を要求する。
   */
  candleRefreshIntervalMs(tf: Timeframe): number {
    return this.exchange.id === "bitbank" ? fileCandleRefreshIntervalMs(tf) : 0;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const t = await this.exchange.fetchTicker(symbol);
    const last = toNumber(t.last) ?? toNumber(t.close);
    const bid = toNumber(t.bid) ?? last;
    const ask = toNumber(t.ask) ?? last;
    if (bid === undefined || ask === undefined) throw new Error(`ticker に価格がありません: ${symbol}`);
    return {
      ts: toNumber(t.timestamp) ?? Date.now(),
      bid,
      ask,
      ...(toNumber(t.bidVolume) !== undefined ? { bidSize: toNumber(t.bidVolume) } : {}),
      ...(toNumber(t.askVolume) !== undefined ? { askSize: toNumber(t.askVolume) } : {}),
      ...(last !== undefined ? { last } : {}),
    };
  }

  async fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const ob = await this.exchange.fetchOrderBook(symbol, depth);
    const conv = (rows: any[]): [number, number][] => (rows ?? []).map((r) => [Number(r[0]), Number(r[1])]);
    return { ts: toNumber(ob.timestamp) ?? Date.now(), bids: conv(ob.bids), asks: conv(ob.asks) };
  }

  async fetchPrints(symbol: string, limit = 100): Promise<TradePrint[]> {
    const trades = await this.exchange.fetchTrades(symbol, undefined, limit);
    return trades
      .filter((t) => t.price !== undefined && t.amount !== undefined)
      .map((t) => ({
        ts: Number(t.timestamp),
        price: Number(t.price),
        size: Number(t.amount),
        side: t.side === "sell" ? ("sell" as const) : ("buy" as const),
      }))
      .sort((a, b) => a.ts - b.ts);
  }
}
