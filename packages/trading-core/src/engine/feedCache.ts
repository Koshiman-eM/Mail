import { mergeCandles } from "../market/candles";
import {
  systemClock, TIMEFRAME_MS, type Candle, type Clock, type Instrument, type MarketDataFeed, type OrderBook, type Quote, type Timeframe,
  type TradePrint,
} from "../core/types";

/**
 * 確定足をキャッシュする feed ラッパー (合成フィードの高速化用)。
 * - 確定足は変わらない前提で、新しい足が確定したときだけ内側の feed へ問い合わせる。
 * - 未確定足は返さない (MarketHub は確定足しか戦略へ渡さないので結果は変わらない)。
 * 合成フィードは上位足 (1d など) の計算が重いため、シミュレーションの速度を大きく改善する。
 * 実取引所は直近足の確定が遅れることがあるので、合成フィード以外には使わない。
 */
export class ClosedCandleCacheFeed implements MarketDataFeed {
  readonly venue: string;
  readonly minIntervalMs: number;
  private readonly cache = new Map<string, Candle[]>();
  /** 内側の feed がこれより古い足を持たないと分かったキー (履歴の先頭まで取得済み) */
  private readonly exhausted = new Set<string>();
  private readonly clock: Clock;
  private readonly max: number;
  fetchOrderBook?: (symbol: string, depth?: number) => Promise<OrderBook>;
  fetchPrints?: (symbol: string, limit?: number) => Promise<TradePrint[]>;

  constructor(
    readonly inner: MarketDataFeed,
    opts: { clock?: Clock; maxCandles?: number } = {},
  ) {
    this.venue = inner.venue;
    this.minIntervalMs = (inner as { minIntervalMs?: number }).minIntervalMs ?? 0;
    this.clock = opts.clock ?? systemClock;
    this.max = opts.maxCandles ?? 2000;
    if (inner.fetchOrderBook) this.fetchOrderBook = (s, d) => inner.fetchOrderBook!(s, d);
    if (inner.fetchPrints) this.fetchPrints = (s, l) => inner.fetchPrints!(s, l);
  }

  listInstruments(): Promise<Instrument[]> {
    return this.inner.listInstruments();
  }

  fetchQuote(symbol: string): Promise<Quote> {
    return this.inner.fetchQuote(symbol);
  }

  async fetchCandles(symbol: string, tf: Timeframe, limit: number, since?: number): Promise<Candle[]> {
    const ms = TIMEFRAME_MS[tf];
    const now = this.clock.now();
    const closed = (c: Candle) => c.ts + ms <= now;
    /** 直近の確定足の開始時刻 */
    const lastClosed = Math.floor(now / ms) * ms - ms;
    const key = `${symbol}|${tf}`;
    let arr = this.cache.get(key) ?? [];
    const wantFrom = since ?? lastClosed - (Math.max(1, limit) - 1) * ms;

    if (arr.length === 0 || (wantFrom < arr[0].ts && !this.exhausted.has(key))) {
      // 初回 (またはキャッシュより古い範囲): 未確定足の分を 1 本多めに取る
      const fresh = await this.inner.fetchCandles(symbol, tf, limit + 1, since);
      // 要求より少なければ履歴の先頭に達している (以後は古い範囲を取り直さない)
      if (since === undefined && fresh.length < limit + 1) this.exhausted.add(key);
      arr = mergeCandles(arr, fresh.filter(closed), this.max);
    } else if (arr[arr.length - 1].ts < lastClosed) {
      // 新しく確定した足だけ取る
      const lastTs = arr[arr.length - 1].ts;
      const missing = Math.round((lastClosed - lastTs) / ms);
      const fresh = await this.inner.fetchCandles(symbol, tf, missing + 1, lastTs + ms);
      arr = mergeCandles(arr, fresh.filter(closed), this.max);
    }
    this.cache.set(key, arr);
    const out = since !== undefined ? arr.filter((c) => c.ts >= since) : arr;
    return out.slice(-Math.max(1, limit)).map((c) => ({ ...c }));
  }
}
