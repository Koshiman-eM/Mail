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
  /** 1 秒あたりのボラティリティ (対数収益率の標準偏差)。年率からは annualToSecSigma で換算 */
  sigma: number;
  spreadBps: number;
  baseVolume: number;
}

/** 年率ボラティリティ → 1 秒あたりの標準偏差 (365 日連続で動く合成市場として換算) */
export const annualToSecSigma = (annual: number): number => annual / Math.sqrt(365 * 86_400);

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
    mk("BTC/USDT", "crypto", "BTC", "USDT", 0.01, 0.0001, 5, 0.001, false, 65_000, annualToSecSigma(0.6), 1.5, 0.05),
    mk("ETH/USDT", "crypto", "ETH", "USDT", 0.01, 0.001, 5, 0.001, false, 3_200, annualToSecSigma(0.75), 2, 0.8),
    // PEPE は値動きの大きい暗号資産として crypto に分類する (ミーム専用の戦略・自動の meme 分類は廃止)
    mk("PEPE/USDT", "crypto", "PEPE", "USDT", 1e-9, 1, 5, 0.001, false, 0.000012, annualToSecSigma(1.6), 12, 5_000_000),
    mk("USD/JPY", "fx", "USD", "JPY", 0.001, 1, undefined, 0, true, 150, annualToSecSigma(0.1), 0.7, 1_000, { contractSize: 1 }),
    mk("AAPL", "stock", "AAPL", "USD", 0.01, 1, undefined, 0, true, 190, annualToSecSigma(0.3), 2, 100),
  ];
}

/**
 * レジーム。drift は「そのレジーム中の 1 秒あたりドリフト = sigma × driftSigmaMul」。
 * 0.004 は 1 日続いても日次ボラの 1 倍程度 (BTC 数%、FX 約 0.5%、株 約 2%) に収まる大きさ。
 * 上昇と下降は対称で、期待ドリフトはゼロ (効率的な市場に近づけ、戦略に人工的なエッジを与えない)。
 */
type Regime = { driftSigmaMul: number; volMul: number; revert: number };
const REGIMES: Regime[] = [
  { driftSigmaMul: 0.004, volMul: 1, revert: 0 }, // 上昇
  { driftSigmaMul: -0.004, volMul: 1, revert: 0 }, // 下降
  { driftSigmaMul: 0, volMul: 0.7, revert: 0.02 }, // レンジ
  { driftSigmaMul: 0, volMul: 1.8, revert: 0 }, // 高ボラ
];

/** バースト (値動きと出来高の同時急増): 1 秒あたりの発生確率・継続秒数・ボラ倍率・出来高倍率 */
const BURST_PROB = 1 / 1800;
const BURST_MIN_SEC = 20;
const BURST_SPAN_SEC = 100;
const BURST_VOL_MUL = 3;
const BURST_VOLUME_MUL = 2.5;

class Path {
  /** 1 秒刻みの価格 (index 0 = t0) */
  prices: number[];
  /** 1 秒刻みの出来高 (index 0 は平常値)。同じ秒の |リターン| と連動する */
  volumes: number[];
  /** 1 秒刻みの標準化リターン (現在の足の方向。板の弱い傾きに使う) */
  zs: number[];
  private rng: () => number;
  private regime = REGIMES[2];
  private anchor: number;
  private regimeLeft = 0;
  private burstLeft = 0;
  constructor(readonly spec: SymbolSpec, seed: number) {
    this.rng = mulberry32(seedOf(seed, spec.instrument.symbol));
    this.prices = [spec.startPrice];
    this.volumes = [spec.baseVolume * 0.1];
    this.zs = [0];
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
      // バースト: 同じ秒の値動きと出来高を同時に増やす (将来は予告しない)
      if (this.burstLeft <= 0 && this.rng() < BURST_PROB) this.burstLeft = BURST_MIN_SEC + Math.floor(this.rng() * BURST_SPAN_SEC);
      const burst = this.burstLeft > 0;
      if (burst) this.burstLeft--;
      const p = this.prices[this.prices.length - 1];
      const pull = this.regime.revert * Math.log(this.anchor / p);
      const z = this.gauss();
      const sig = this.spec.sigma * this.regime.volMul * (burst ? BURST_VOL_MUL : 1);
      const r = this.spec.sigma * this.regime.driftSigmaMul + pull + sig * z;
      this.prices.push(Math.max(p * Math.exp(r), this.spec.instrument.tickSize));
      this.zs.push(z);
      // 出来高: 基本ノイズ × (1 + |z|) × バースト。|リターン| が大きい秒ほど増える
      const noise = 0.3 + 0.7 * this.rng();
      this.volumes.push(this.spec.baseVolume * 0.1 * noise * (1 + 0.7 * Math.abs(z)) * (burst ? BURST_VOLUME_MUL : 1));
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
    this.priceAtIdx(p, idx);
    // 不均衡は主にノイズ。現在の足の方向 (確定済みの z) と弱く連動するだけで、将来の値動きとは無関係
    const tilt = 0.1 * Math.max(-2, Math.min(2, p.zs[idx] ?? 0));
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let i = 0; i < depth; i++) {
      bids.push([q.bid - i * tick, p.spec.baseVolume * (0.3 + hash01(symbol + "b", idx * 100 + i)) * (1 + tilt)]);
      asks.push([q.ask + i * tick, p.spec.baseVolume * (0.3 + hash01(symbol + "a", idx * 100 + i)) * (1 - tilt)]);
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
        size: p.volumes[i],
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
        vol += p.volumes[i];
      }
      out.push({ ts: b, open, high, low, close, volume: vol });
    }
    return out;
  }
}
