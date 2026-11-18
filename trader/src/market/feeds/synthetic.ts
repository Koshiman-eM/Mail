import {
  systemClock, TIMEFRAME_MS, type AssetClass, type Candle, type Clock, type Instrument, type MarketDataFeed, type OrderBook, type Quote,
  type Timeframe, type TradePrint,
} from "../../core/types";

/** シード付き乱数 (mulberry32) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文字列+整数から [0,1) の決定論的ハッシュ */
function hash01(key: string, i: number): number {
  let h = 2166136261 ^ i;
  for (let k = 0; k < key.length; k++) h = Math.imul(h ^ key.charCodeAt(k), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const seedOf = (seed: number, s: string) => {
  let h = seed >>> 0;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619) >>> 0;
  return h;
};

interface SymbolSpec {
  instrument: Instrument;
  startPrice: number;
  /** 1 秒あたりのボラティリティ (対数収益率の標準偏差) */
  sigma: number;
  spreadBps: number;
  baseVolume: number;
}

export function defaultSyntheticSpecs(venue = "paper"): SymbolSpec[] {
  const mk = (
    symbol: string, assetClass: AssetClass, base: string, quote: string, tick: number, lot: number, minNotional: number | undefined,
    fee: number, allowShort: boolean, startPrice: number, sigma: number, spreadBps: number, baseVolume: number, extra: Partial<Instrument> = {},
  ): SymbolSpec => ({
    instrument: {
      symbol, venue, assetClass, baseCurrency: base, quoteCurrency: quote, tickSize: tick, lotSize: lot, minQty: lot,
      ...(minNotional !== undefined ? { minNotional } : {}), takerFeeRate: fee, makerFeeRate: fee * 0.8, allowShort, ...extra,
    },
    startPrice, sigma, spreadBps, baseVolume,
  });
  return [
    mk("BTC/USDT", "crypto", "BTC", "USDT", 0.01, 0.0001, 5, 0.001, false, 65_000, 0.0003, 1.5, 0.05),
    mk("ETH/USDT", "crypto", "ETH", "USDT", 0.01, 0.001, 5, 0.001, false, 3_200, 0.0004, 2, 0.8),
    mk("PEPE/USDT", "meme", "PEPE", "USDT", 1e-9, 1, 5, 0.001, false, 0.000012, 0.0009, 12, 5_000_000, { meta: { liquidityUsd: 2_000_000 } }),
    mk("USD/JPY", "fx", "USD", "JPY", 0.001, 1, undefined, 0, true, 150, 0.00005, 0.7, 1_000, { contractSize: 1 }),
    mk("AAPL", "stock", "AAPL", "USD", 0.01, 1, undefined, 0, true, 190, 0.00012, 2, 100),
  ];
}

type Regime = { drift: number; volMul: number; revert: number };
const REGIMES: Regime[] = [
  { drift: 0.00004, volMul: 1, revert: 0 }, // 上昇
  { drift: -0.00004, volMul: 1, revert: 0 }, // 下降
  { drift: 0, volMul: 0.6, revert: 0.02 }, // レンジ
  { drift: 0, volMul: 2.5, revert: 0 }, // 高ボラ
];

class Path {
  /** 1 秒刻みの価格 (index 0 = t0) */
  prices: number[];
  private rng: () => number;
  private regime = REGIMES[2];
  private anchor: number;
  private regimeLeft = 0;
  constructor(readonly spec: SymbolSpec, seed: number) {
    this.rng = mulberry32(seedOf(seed, spec.instrument.symbol));
    this.prices = [spec.startPrice];
    this.anchor = spec.startPrice;
  }
  private gauss(): number {
    const u = Math.max(this.rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng());
  }
  extendTo(idx: number): void {
    while (this.prices.length <= idx) {
      if (this.regimeLeft <= 0) {
        this.regime = REGIMES[Math.floor(this.rng() * REGIMES.length)];
        this.regimeLeft = 900 + Math.floor(this.rng() * 3600); // 15〜75 分でレジーム変化
        this.anchor = this.prices[this.prices.length - 1];
      }
      this.regimeLeft--;
      const p = this.prices[this.prices.length - 1];
      const pull = this.regime.revert * Math.log(this.anchor / p);
      const r = this.regime.drift + pull + this.spec.sigma * this.regime.volMul * this.gauss();
      this.prices.push(Math.max(p * Math.exp(r), this.spec.instrument.tickSize));
    }
  }
}

export interface SyntheticFeedOptions {
  seed?: number;
  clock?: Clock;
  venue?: string;
  specs?: SymbolSpec[];
  /** 履歴の長さ (既定 7 日) */
  historyMs?: number;
}

/** ネットワーク無しで動く合成フィード。同じ seed・同じ時刻なら同じ値を返す */
export class SyntheticFeed implements MarketDataFeed {
  readonly venue: string;
  readonly minIntervalMs = 0;
  private readonly clock: Clock;
  private readonly seed: number;
  private readonly paths = new Map<string, Path>();
  private readonly t0: number;
  private readonly historyMs: number;

  constructor(o: SyntheticFeedOptions = {}) {
    this.venue = o.venue ?? "paper";
    this.clock = o.clock ?? systemClock;
    this.seed = o.seed ?? 42;
    this.historyMs = o.historyMs ?? 7 * 86_400_000;
    this.t0 = Math.floor((this.clock.now() - this.historyMs) / 1000) * 1000;
    for (const s of o.specs ?? defaultSyntheticSpecs(this.venue)) this.paths.set(s.instrument.symbol, new Path(s, this.seed));
  }

  private path(symbol: string): Path {
    const p = this.paths.get(symbol);
    if (!p) throw new Error(`合成フィードに銘柄がありません: ${symbol}`);
    return p;
  }

  /** 時刻に対応する 1 秒ステップの index */
  private idxAt(ts: number): number {
    return Math.max(0, Math.floor((ts - this.t0) / 1000));
  }

  private priceAtIdx(p: Path, idx: number): number {
    p.extendTo(idx);
    return p.prices[idx];
  }

  async listInstruments(): Promise<Instrument[]> {
    return [...this.paths.values()].map((p) => ({ ...p.spec.instrument }));
  }

  async fetchQuote(symbol: string): Promise<Quote> {
    const p = this.path(symbol);
    const now = this.clock.now();
    const mid = this.priceAtIdx(p, this.idxAt(now));
    const half = (p.spec.spreadBps / 10_000 / 2) * mid;
    const tick = p.spec.instrument.tickSize;
    const bid = Math.max(tick, Math.floor((mid - half) / tick) * tick);
    const ask = Math.max(bid + tick, Math.ceil((mid + half) / tick) * tick);
    const sz = p.spec.baseVolume * (0.5 + hash01(symbol, this.idxAt(now)));
    return { ts: now, bid, ask, bidSize: sz, askSize: sz, last: mid };
  }

  async fetchOrderBook(symbol: string, depth = 10): Promise<OrderBook> {
    const q = await this.fetchQuote(symbol);
    const p = this.path(symbol);
    const tick = p.spec.instrument.tickSize;
    const idx = this.idxAt(q.ts);
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let i = 0; i < depth; i++) {
      bids.push([q.bid - i * tick, p.spec.baseVolume * (0.3 + hash01(symbol + "b", idx * 100 + i))]);
      asks.push([q.ask + i * tick, p.spec.baseVolume * (0.3 + hash01(symbol + "a", idx * 100 + i))]);
    }
    return { ts: q.ts, bids, asks };
  }

  async fetchPrints(symbol: string, limit = 100): Promise<TradePrint[]> {
    const p = this.path(symbol);
    const now = this.clock.now();
    const end = this.idxAt(now);
    const out: TradePrint[] = [];
    for (let i = Math.max(1, end - limit + 1); i <= end; i++) {
      const price = this.priceAtIdx(p, i);
      const prev = this.priceAtIdx(p, i - 1);
      out.push({
        ts: this.t0 + i * 1000,
        price,
        size: p.spec.baseVolume * 0.1 * (0.2 + hash01(symbol + "t", i)),
        side: price >= prev ? "buy" : "sell",
      });
    }
    return out;
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const p = this.path(symbol);
    const ms = TIMEFRAME_MS[tf];
    const now = this.clock.now();
    const lastBucket = Math.floor(now / ms) * ms;
    let first = lastBucket - (limit - 1) * ms;
    if (since !== undefined) first = Math.max(first, Math.ceil(since / ms) * ms);
    first = Math.max(first, Math.floor(this.t0 / ms) * ms);
    const endIdx = this.idxAt(now);
    const out: Candle[] = [];
    for (let b = first; b <= lastBucket; b += ms) {
      const i0 = Math.max(0, Math.floor((b - this.t0) / 1000));
      const i1 = Math.min(endIdx, Math.floor((b + ms - 1 - this.t0) / 1000));
      if (i1 < i0 || b + ms - 1 < this.t0) continue;
      let high = -Infinity, low = Infinity, vol = 0;
      const open = this.priceAtIdx(p, i0);
      let close = open;
      for (let i = i0; i <= i1; i++) {
        const px = this.priceAtIdx(p, i);
        high = Math.max(high, px);
        low = Math.min(low, px);
        close = px;
        vol += p.spec.baseVolume * 0.1 * (0.2 + hash01(symbol + "t", i));
      }
      out.push({ ts: b, open, high, low, close, volume: vol });
    }
    return out;
  }
}
