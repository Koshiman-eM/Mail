import { fetchJson, QUOTE_FETCH_OPTIONS, type FetchOptions } from "../../core/http";
import {
  systemClock, TIMEFRAME_MS, type Candle, type Clock, type Instrument, type MarketDataFeed, type Quote, type Timeframe,
} from "../../core/types";
import { CandleBuilder } from "../candles";

export const DEXSCREENER_URL = "https://api.dexscreener.com";

/** DexScreener にはローソク足 API が無いので、ポーリングした価格から足を組み立てる */
export class SnapshotCandleBuilder {
  private readonly builders = new Map<Timeframe, CandleBuilder>();
  constructor(timeframes: Timeframe[] = ["1m", "5m", "15m", "1h"]) {
    for (const tf of timeframes) this.builders.set(tf, new CandleBuilder(TIMEFRAME_MS[tf]));
  }
  push(ts: number, price: number, volume = 0): void {
    for (const b of this.builders.values()) b.push(ts, price, volume);
  }
  /** 未確定足を含む。末尾 limit 本 */
  candles(tf: Timeframe, limit: number): Candle[] {
    const b = this.builders.get(tf);
    if (!b) throw new Error(`未対応の時間足: ${tf}`);
    return b.all().slice(-limit);
  }
}

export interface PairStats {
  symbol: string;
  chainId: string;
  pairAddress: string;
  liquidityUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  volume5mUsd: number;
  txns24h: number;
  txns1h: number;
  txns5m: number;
  buys1h: number;
  sells1h: number;
  priceUsd: number;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  /** ペア作成からの経過時間 (時間)。作成時刻が不明なら undefined */
  ageHours?: number;
  priceChange1hPct?: number;
}

export interface DexScreenerFeedOptions {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** AMM のスプレッド/インパクトの想定 (bps)。DEX には bid/ask が無いため擬似的に付与 */
  assumedSpreadBps?: number;
  takerFeeRate?: number;
  timeframes?: Timeframe[];
  baseUrl?: string;
}

interface Registered {
  instrument: Instrument;
  chainId: string;
  pairAddress: string;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export class DexScreenerFeed implements MarketDataFeed {
  readonly venue = "dex";
  /** 公開 API の上限 (300 req/分) に収まる間隔 */
  readonly minIntervalMs = 250;
  private readonly reg = new Map<string, Registered>();
  private readonly builders = new Map<string, SnapshotCandleBuilder>();
  private readonly clock: Clock;

  constructor(private readonly o: DexScreenerFeedOptions = {}) {
    this.clock = o.clock ?? systemClock;
  }

  /** extra: 再試行回数・タイムアウトなどの上書き (気配取得は QUOTE_FETCH_OPTIONS) */
  private get<T>(path: string, extra: FetchOptions = {}): Promise<T> {
    const opts: FetchOptions = { ...extra, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) };
    return fetchJson<T>(`${this.o.baseUrl ?? DEXSCREENER_URL}${path}`, opts);
  }

  /** ペア情報 (API レスポンス) -> Instrument */
  pairToInstrument(p: any): Instrument {
    // 価格はクオート通貨建て (priceNative)。priceUsd は単位が違うので刻みの推定にも使わない
    const price = n(p.priceNative);
    // 価格の有効数字 4 桁程度を刻みにする
    const tick = price > 0 ? Number(`1e${Math.floor(Math.log10(price)) - 3}`) : 1e-12;
    const liquidityUsd = n(p.liquidity?.usd);
    return {
      symbol: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
      venue: `dex:${p.chainId}`,
      assetClass: "meme",
      baseCurrency: p.baseToken.symbol,
      quoteCurrency: p.quoteToken.symbol,
      tickSize: tick,
      lotSize: 1e-6,
      minQty: 1e-6,
      takerFeeRate: this.o.takerFeeRate ?? 0.003,
      makerFeeRate: this.o.takerFeeRate ?? 0.003,
      allowShort: false,
      meta: {
        chainId: p.chainId,
        pairAddress: p.pairAddress,
        dexId: p.dexId ?? "",
        liquidityUsd,
        ...(p.pairCreatedAt ? { pairCreatedAt: Number(p.pairCreatedAt) } : {}),
      },
    };
  }

  private register(p: any): Instrument {
    const instrument = this.pairToInstrument(p);
    this.reg.set(instrument.symbol, { instrument, chainId: p.chainId, pairAddress: p.pairAddress });
    if (!this.builders.has(instrument.symbol)) this.builders.set(instrument.symbol, new SnapshotCandleBuilder(this.o.timeframes));
    return instrument;
  }

  /** ペアを監視対象に登録する */
  async trackPair(chainId: string, pairAddress: string): Promise<Instrument> {
    const res = await this.get<{ pairs: any[] | null }>(`/latest/dex/pairs/${chainId}/${pairAddress}`);
    const p = res.pairs?.[0];
    if (!p) throw new Error(`DexScreener にペアがありません: ${chainId}/${pairAddress}`);
    return this.register(p);
  }

  /** 検索 (登録はしない)。流動性の大きい順 */
  async search(q: string): Promise<{ instrument: Instrument; liquidityUsd: number }[]> {
    const res = await this.get<{ pairs: any[] | null }>(`/latest/dex/search?q=${encodeURIComponent(q)}`);
    return (res.pairs ?? [])
      .map((p) => ({ instrument: this.pairToInstrument(p), liquidityUsd: n(p.liquidity?.usd) }))
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  }

  /** トークンアドレスからペア一覧 (/tokens/v1/{chainId}/{addresses}) */
  async fetchTokenPairs(chainId: string, addresses: string[]): Promise<Instrument[]> {
    const res = await this.get<any[]>(`/tokens/v1/${chainId}/${addresses.join(",")}`);
    return (Array.isArray(res) ? res : []).map((p) => this.pairToInstrument(p));
  }

  async listInstruments(): Promise<Instrument[]> {
    return [...this.reg.values()].map((r) => r.instrument);
  }

  private need(symbol: string): Registered {
    const r = this.reg.get(symbol);
    if (!r) throw new Error(`未登録の DEX 銘柄: ${symbol} (trackPair で登録してください)`);
    return r;
  }

  private async fetchPair(symbol: string, extra: FetchOptions = {}): Promise<any> {
    const r = this.need(symbol);
    const res = await this.get<{ pairs: any[] | null }>(`/latest/dex/pairs/${r.chainId}/${r.pairAddress}`, extra);
    const p = res.pairs?.[0];
    if (!p) throw new Error(`ペア情報が取得できません: ${symbol}`);
    return p;
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    // 5 秒ループの気配取得なので再試行を減らす (ペア登録・統計は既定のまま)
    const p = await this.fetchPair(symbol, QUOTE_FETCH_OPTIONS);
    // 流動性を Instrument.meta に反映 (USD 建てなので価格の有無と無関係)
    const r = this.need(symbol);
    r.instrument.meta = { ...r.instrument.meta, liquidityUsd: n(p.liquidity?.usd) };
    // 価格はクオート通貨建て (priceNative) だけを使う。priceUsd で代用すると単位が混ざるので、
    // priceNative が無いときはこの回の更新をスキップする (例外 → MarketHub は前回の気配を保持する)
    const price = n(p.priceNative);
    if (!(price > 0)) throw new Error(`priceNative が無いため価格の更新をスキップ: ${symbol}`);
    const half = ((this.o.assumedSpreadBps ?? 30) / 10_000) / 2;
    const ts = this.clock.now();
    this.builders.get(symbol)?.push(ts, price, 0);
    return { ts, bid: price * (1 - half), ask: price * (1 + half), last: price };
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    this.need(symbol);
    const arr = this.builders.get(symbol)!.candles(tf, limit);
    return since === undefined ? arr : arr.filter((c) => c.ts >= since);
  }

  /** 流動性・取引回数などのペア統計 (リスク管理の流動性チェック用) */
  async fetchPairStats(symbol: string): Promise<PairStats> {
    const p = await this.fetchPair(symbol);
    const r = this.need(symbol);
    const tx = (k: string) => n(p.txns?.[k]?.buys) + n(p.txns?.[k]?.sells);
    const created = p.pairCreatedAt ? Number(p.pairCreatedAt) : undefined;
    return {
      symbol,
      chainId: r.chainId,
      pairAddress: r.pairAddress,
      liquidityUsd: n(p.liquidity?.usd),
      volume24hUsd: n(p.volume?.h24),
      volume1hUsd: n(p.volume?.h1),
      volume5mUsd: n(p.volume?.m5),
      txns24h: tx("h24"),
      txns1h: tx("h1"),
      txns5m: tx("m5"),
      buys1h: n(p.txns?.h1?.buys),
      sells1h: n(p.txns?.h1?.sells),
      priceUsd: n(p.priceUsd),
      ...(p.fdv !== undefined ? { fdv: n(p.fdv) } : {}),
      ...(p.marketCap !== undefined ? { marketCap: n(p.marketCap) } : {}),
      ...(created !== undefined ? { pairCreatedAt: created, ageHours: (this.clock.now() - created) / 3_600_000 } : {}),
      ...(p.priceChange?.h1 !== undefined ? { priceChange1hPct: n(p.priceChange.h1) } : {}),
    };
  }
}
