/**
 * ポーリングした価格 (Jupiter Price V3) から 1m の OHLC 足を組み立てる。Jupiter には OHLCV の API が無いため。
 *
 * - 出来高は分からないので volume は 0、`volumeKnown: false` を付ける (GeckoTerminal の足で埋めた分は true)。
 *   出来高を使う戦略は劣化する・使えない (報告を参照)。
 * - 足の区切りは UTC の 1 分単位 (src/indicators/resample.ts の bucketStart と同じ)。過去の時刻の価格 (今の足より古い) は捨てる。
 * - 空白 (価格の取れなかった分): 直前の終値で横ばいの足 (O=H=L=C=直前の終値、`filled: true`、samples 0) を差し込む (carry forward)。
 *   本数で数える指標 (ATR・RSI・ブレイクの本数) が空白でずれないように 1m の系列を連続にするため。
 *   ただし埋めるのは実データの足の後ろの最大 `maxFillBars` 本 (既定 30 本 = 30 分) まで。それより長い空白の残りは埋めない
 *   (ポーリングが止まっていた = データが古い。横ばいの足を長く作るとボラティリティを過小に見せる。resample.ts も空白は埋めない)。
 *   最後の実データの足の後ろも、確定した分だけ同じ規則で埋める (それより先は足を作らない = feed が止まったと分かる)。
 *   空白の中と末尾で規則が同じなので、後から次の価格が来ても一度返した埋めた足は変わらない (リペイントしない)。
 * - 上位足 (5m/15m/1h/4h) は src/indicators/resample.ts の resample で作る (確定したバケットだけ・データ途中から始まる先頭のバケットは捨てる)。
 *   各上位足には、中の 1m がすべて埋めた足なら filled、1 本でも出来高不明なら volumeKnown: false、samples は合計を付ける。
 * - 確定足だけを返すのが既定 (戦略に渡すのは確定足だけ)。
 */
import { bucketStart, resample, type ResampleOptions } from "../../indicators/resample";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "../../core/types";

export interface PolledCandle extends Candle {
  /** 出来高が分かっているか (ポーリングで作った足は false = volume は 0) */
  volumeKnown: boolean;
  /** 価格が 1 件も無く、直前の終値で埋めた足 */
  filled: boolean;
  /** 足の中で受け取った価格の件数 (埋めた足・外部の足は 0) */
  samples: number;
}

/** 価格のポーリングで作れる時間足 */
export const POLLED_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const satisfies readonly Timeframe[];
export type PolledTimeframe = (typeof POLLED_TIMEFRAMES)[number];

export const DEFAULT_MAX_FILL_BARS = 30;
export const DEFAULT_MAX_POLLED_CANDLES = 2000;

/**
 * 足の空白を直前の終値で埋める (実データの足の後ろに最大 maxFillBars 本まで。それより先は空白のまま)。
 * untilTs があれば、その時刻までに確定した足まで末尾も同じ規則で埋める
 */
export function fillGaps(candles: readonly PolledCandle[], tfMs: number, maxFillBars = DEFAULT_MAX_FILL_BARS, untilTs?: number): PolledCandle[] {
  const out: PolledCandle[] = [];
  const maxFill = Math.max(0, Math.floor(maxFillBars));
  const flat = (ts: number, price: number): PolledCandle => ({
    ts, open: price, high: price, low: price, close: price, volume: 0, volumeKnown: false, filled: true, samples: 0,
  });
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prev = out[out.length - 1];
    if (prev) {
      const missing = Math.round((c.ts - prev.ts) / tfMs) - 1;
      // 空白の先頭から最大 maxFill 本まで (末尾の埋め方と同じ規則なので、後から次の足が来ても埋めた足は変わらない)
      for (let k = 1; k <= Math.min(missing, maxFill); k++) out.push(flat(prev.ts + k * tfMs, prev.close));
    }
    out.push({ ...c });
  }
  if (untilTs !== undefined && out.length > 0) {
    const last = out[out.length - 1];
    // 最後の実データの足 (埋めた足の手前) から数えて maxFill 本まで
    let lastReal = out.length - 1;
    while (lastReal > 0 && out[lastReal].filled) lastReal--;
    const already = out.length - 1 - lastReal;
    for (let k = 1; already + k <= maxFill; k++) {
      const ts = last.ts + k * tfMs;
      if (ts + tfMs > untilTs) break; // 確定した足だけ
      out.push(flat(ts, last.close));
    }
  }
  return out;
}

export interface PolledCandleBuilderOptions {
  /** 足の長さ (既定 1m) */
  tf?: Timeframe;
  /** 保持する本数 (既定 2000 = hub と同じ) */
  maxCandles?: number;
  /** 埋める空白の上限 (本、既定 30) */
  maxFillBars?: number;
}

/** 1 銘柄の価格から足を組み立てる。push の時刻は昇順の想定 (今の足より古い価格は捨てる) */
export class PolledCandleBuilder {
  readonly tf: Timeframe;
  readonly tfMs: number;
  private readonly max: number;
  private readonly maxFill: number;
  /** 価格のあった足・外部から入れた足だけ (埋めた足は持たない。昇順) */
  private bars: PolledCandle[] = [];

  constructor(o: PolledCandleBuilderOptions = {}) {
    this.tf = o.tf ?? "1m";
    this.tfMs = TIMEFRAME_MS[this.tf];
    this.max = Math.max(10, Math.floor(o.maxCandles ?? DEFAULT_MAX_POLLED_CANDLES));
    this.maxFill = Math.max(0, Math.floor(o.maxFillBars ?? DEFAULT_MAX_FILL_BARS));
  }

  /** 価格を 1 件入れる。使ったら true (価格が正の有限数でない・時刻が今の足より古いと false) */
  push(ts: number, price: number): boolean {
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return false;
    const b = Math.floor(ts / this.tfMs) * this.tfMs;
    const last = this.bars[this.bars.length - 1];
    if (last && b < last.ts) return false;
    if (last && last.ts === b) {
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.close = price;
      last.samples++;
      return true;
    }
    this.bars.push({ ts: b, open: price, high: price, low: price, close: price, volume: 0, volumeKnown: false, filled: false, samples: 1 });
    if (this.bars.length > this.max) this.bars.splice(0, this.bars.length - this.max);
    return true;
  }

  /**
   * 過去の足 (GeckoTerminal の OHLCV など。同じ時間足・ms・昇順でなくてもよい) を入れる。
   * すでにある足 (ポーリングで作った足) は上書きしない。volumeKnown は外部の足の出来高が本物なら true
   */
  seed(candles: readonly Candle[], volumeKnown = true): number {
    const have = new Set(this.bars.map((c) => c.ts));
    let added = 0;
    for (const c of candles) {
      if (!Number.isFinite(c.ts) || c.ts % this.tfMs !== 0 || have.has(c.ts)) continue;
      if (![c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0)) continue;
      have.add(c.ts);
      this.bars.push({
        ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close,
        volume: Number.isFinite(c.volume) && c.volume >= 0 ? c.volume : 0,
        volumeKnown: volumeKnown && Number.isFinite(c.volume), filled: false, samples: 0,
      });
      added++;
    }
    this.bars.sort((a, b) => a.ts - b.ts);
    if (this.bars.length > this.max) this.bars.splice(0, this.bars.length - this.max);
    return added;
  }

  /** 保持している足の数 (埋めた足を除く) */
  get size(): number {
    return this.bars.length;
  }

  /** 最後に価格を受け取った足 (埋めた足を除く) */
  lastBar(): PolledCandle | undefined {
    const l = this.bars[this.bars.length - 1];
    return l ? { ...l } : undefined;
  }

  /**
   * 空白を埋めた足 (昇順)。既定は now の時点の確定足だけ。includeForming なら形成中の足 (価格があれば) も含める。
   * 末尾は確定した分だけ最大 maxFillBars 本まで埋める
   */
  candles(now: number, o: { includeForming?: boolean } = {}): PolledCandle[] {
    const closed = this.bars.filter((c) => c.ts + this.tfMs <= now);
    const filled = fillGaps(closed, this.tfMs, this.maxFill, now);
    const out = filled.length > this.max ? filled.slice(filled.length - this.max) : filled;
    if (o.includeForming) {
      const last = this.bars[this.bars.length - 1];
      // 確定した空白は上の fillGaps (untilTs = now) が埋め済み。残る空白は上限を超えた分なので埋めない
      if (last && last.ts + this.tfMs > now && last.ts <= now) out.push({ ...last });
    }
    return out;
  }
}

/**
 * 1m の足 (PolledCandle) を上位足へ集める。OHLCV は src/indicators/resample.ts の resample (確定したバケットだけ・
 * データ途中から始まる先頭のバケットは捨てる)。フラグは中の 1m から作る
 */
export function resamplePolled(c1m: readonly PolledCandle[], to: Timeframe, opts: ResampleOptions & { from?: Timeframe } = {}): PolledCandle[] {
  const from = opts.from ?? "1m";
  if (to === from) return c1m.map((c) => ({ ...c }));
  const bars = resample(c1m, from, to, opts);
  const flags = new Map<number, { filled: boolean; volumeKnown: boolean; samples: number }>();
  for (const c of c1m) {
    const b = bucketStart(c.ts, to);
    const f = flags.get(b);
    if (!f) flags.set(b, { filled: c.filled, volumeKnown: c.volumeKnown, samples: c.samples });
    else {
      f.filled = f.filled && c.filled;
      f.volumeKnown = f.volumeKnown && c.volumeKnown;
      f.samples += c.samples;
    }
  }
  return bars.map((c) => {
    const f = flags.get(c.ts) ?? { filled: false, volumeKnown: false, samples: 0 };
    return { ...c, ...f };
  });
}

/** 確定足を時間足で返す (1m はそのまま、ほかは集約)。limit があれば末尾の limit 本 */
export function polledCandlesFor(builder: PolledCandleBuilder, tf: Timeframe, now: number, limit?: number): PolledCandle[] {
  const base = builder.candles(now);
  const out = tf === builder.tf ? base : resamplePolled(base, tf, { from: builder.tf, now });
  return limit !== undefined ? out.slice(-Math.max(1, Math.floor(limit))) : out;
}

/** 複数の銘柄 (mint) の PolledCandleBuilder をまとめる */
export class PolledCandleStore {
  private readonly builders = new Map<string, PolledCandleBuilder>();
  constructor(private readonly o: PolledCandleBuilderOptions = {}) {}

  builder(mint: string): PolledCandleBuilder {
    let b = this.builders.get(mint);
    if (!b) {
      b = new PolledCandleBuilder(this.o);
      this.builders.set(mint, b);
    }
    return b;
  }

  has(mint: string): boolean {
    return this.builders.has(mint);
  }

  /** fetchPrices の結果 (mint → { usd, ts }) をまとめて入れる。使った件数を返す */
  pushPrices(prices: ReadonlyMap<string, { usd: number; ts: number }>): number {
    let n = 0;
    for (const [mint, p] of prices) if (this.builder(mint).push(p.ts, p.usd)) n++;
    return n;
  }

  candles(mint: string, tf: Timeframe, now: number, limit?: number): PolledCandle[] {
    const b = this.builders.get(mint);
    return b ? polledCandlesFor(b, tf, now, limit) : [];
  }

  /** 監視から外した銘柄を捨てる */
  delete(mint: string): void {
    this.builders.delete(mint);
  }

  mints(): string[] {
    return [...this.builders.keys()];
  }
}
