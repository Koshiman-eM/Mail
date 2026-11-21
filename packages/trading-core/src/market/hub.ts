import { createLogger } from "../core/logger";
import {
  systemClock, TIMEFRAME_MS, type Candle, type Clock, type Instrument, type MarketDataFeed, type MarketView, type OrderBook, type Quote,
  type Timeframe, type TradePrint,
} from "../core/types";
import { aggregateCandles, CandleBuilder, closedCandles, mergeCandles } from "./candles";
import { defaultSleep } from "../core/util";

const log = createLogger("market-hub");

export interface MarketHubOptions {
  feeds: MarketDataFeed[];
  clock?: Clock;
  /** 保持する時間足 (既定 1m/5m/15m/1h) */
  timeframes?: Timeframe[];
  /** 初回取得する足の本数 */
  historyLimit?: number;
  /** 約定リングバッファの長さ */
  printsLimit?: number;
  /** 板を取得するか */
  withBook?: boolean;
  /** venue ごとの最小リクエスト間隔 (ms)。feed.minIntervalMs より優先 */
  minIntervalMs?: Record<string, number>;
  sleep?: (ms: number) => Promise<void>;
}

interface SymbolState {
  instrument: Instrument;
  feed: MarketDataFeed;
  quote?: Quote;
  book?: OrderBook;
  prints: TradePrint[];
  candles: Partial<Record<Timeframe, Candle[]>>;
  /** feed から取得できず quote から組み立てる時間足 */
  built: Map<Timeframe, CandleBuilder>;
  loaded: boolean;
  lastError?: string;
}

/**
 * feed が任意で実装する: 毎回更新で同じ (銘柄, 時間足) の足を取り直す最短間隔 (ms)。
 * 正の値を返す feed (例: ccxt の bitbank) だけ、hub は
 * - since (最後に持っている足の ts) を付けて差分だけ要求し、
 * - 間隔内は取得を見送って現在足を気配で更新する (足の境界をまたいだ直後は間隔に関係なく取り直す)。
 * 未実装 / 0 の feed は従来どおり毎回直近 5 本を取る。
 */
interface RefreshThrottledFeed {
  candleRefreshIntervalMs?(tf: Timeframe): number;
}

/**
 * feed が任意で実装する: 足を feed 自身が保持・組み立てている (Jupiter: ポーリングした価格の 1m 足と GeckoTerminal の履歴)。
 * true の feed は fetchCandles が手元の足を返すだけ (外部 API を呼ばない) なので、hub は
 * - 履歴の取得で空でも集約・気配からの組み立てに切り替えず (後から裏の取得で足が増える)、
 * - 毎回の更新で時間足ごとに全体 (最大 LOCAL_CANDLES_MAX 本) を取り直して置き換える
 *   (feed が後から埋めた出来高 (volumeKnown) も反映する。確定足の値を変えない約束は feed 側が守る)。
 */
interface LocalCandleFeed {
  readonly candlesAreLocal?: boolean;
}
const LOCAL_CANDLES_MAX = 2000;
const isLocalCandleFeed = (f: MarketDataFeed) => (f as LocalCandleFeed).candlesAreLocal === true;

/** 足の境界をまたいだ後、この時間内に取得した足は確定値でない可能性があるので取り直す */
const BOUNDARY_GRACE_MS = 10_000;

export class MarketHub {
  private readonly feeds: MarketDataFeed[];
  private readonly clock: Clock;
  private readonly tfs: Timeframe[];
  private readonly historyLimit: number;
  private readonly printsLimit: number;
  private readonly withBook: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly symbols = new Map<string, SymbolState>();
  private readonly lastCall = new Map<string, number>();

  constructor(private readonly o: MarketHubOptions) {
    this.feeds = o.feeds;
    this.clock = o.clock ?? systemClock;
    this.tfs = o.timeframes ?? ["1m", "5m", "15m", "1h"];
    this.historyLimit = o.historyLimit ?? 300;
    this.printsLimit = o.printsLimit ?? 500;
    this.withBook = o.withBook ?? true;
    this.sleep = o.sleep ?? defaultSleep;
  }

  private feedFor(inst: Instrument): MarketDataFeed {
    const f =
      this.feeds.find((x) => x.venue === inst.venue) ??
      this.feeds.find((x) => inst.venue.startsWith(`${x.venue}:`) || x.venue.startsWith(`${inst.venue}:`));
    if (!f) throw new Error(`venue ${inst.venue} に対応する feed がありません`);
    return f;
  }

  /** feed ごとの最小間隔を守る。呼び出し枠を先に予約するので並行呼び出しでも間隔が保たれる */
  private async gate(feed: MarketDataFeed): Promise<void> {
    const min = this.o.minIntervalMs?.[feed.venue] ?? (feed as { minIntervalMs?: number }).minIntervalMs ?? 0;
    if (min <= 0) return;
    const now = Date.now();
    const start = Math.max(now, (this.lastCall.get(feed.venue) ?? 0) + min);
    this.lastCall.set(feed.venue, start);
    if (start > now) await this.sleep(start - now);
  }

  /** 全 feed から銘柄一覧を取得 */
  async listInstruments(): Promise<Instrument[]> {
    const out: Instrument[] = [];
    for (const f of this.feeds) {
      await this.gate(f);
      out.push(...(await f.listInstruments()));
    }
    return out;
  }

  /** 監視対象に追加 (履歴は最初の poll / load で取得) */
  watch(instrument: Instrument, feed?: MarketDataFeed): void {
    if (this.symbols.has(instrument.symbol)) return;
    this.symbols.set(instrument.symbol, {
      instrument,
      feed: feed ?? this.feedFor(instrument),
      prints: [],
      candles: {},
      built: new Map(),
      loaded: false,
    });
  }

  /**
   * 監視から外す (Jupiter の自動探索で期限切れになった銘柄など)。外したら true。
   * 建玉・保留中の注文のある銘柄を外さないのは呼び出し側 (エンジン) の責任
   */
  unwatch(symbol: string): boolean {
    if (!this.symbols.delete(symbol)) return false;
    this.aggregated.delete(symbol);
    for (const k of [...this.lastCandleFetch.keys()]) if (k.startsWith(`${symbol}|`)) this.lastCandleFetch.delete(k);
    return true;
  }

  watched(): Instrument[] {
    return [...this.symbols.values()].map((s) => s.instrument);
  }

  instrument(symbol: string): Instrument | undefined {
    return this.symbols.get(symbol)?.instrument;
  }

  /** 初回: 履歴取得 */
  private async load(s: SymbolState): Promise<void> {
    const sym = s.instrument.symbol;
    const msOf = (tf: Timeframe) => TIMEFRAME_MS[tf];
    if (isLocalCandleFeed(s.feed)) {
      // 手元の足を持つ feed: 空でも集約・組み立てに切り替えない (裏の取得で後から足が増える)
      for (const tf of this.tfs) s.candles[tf] = await s.feed.fetchCandles(sym, tf, LOCAL_CANDLES_MAX);
      s.loaded = true;
      return;
    }
    for (const tf of [...this.tfs].sort((a, b) => msOf(a) - msOf(b))) {
      try {
        await this.gate(s.feed);
        const c = await s.feed.fetchCandles(sym, tf, this.historyLimit);
        if (c.length === 0) throw new Error("empty");
        s.candles[tf] = mergeCandles([], c);
        // 間引き対象の feed は、履歴取得を最初の「更新取得」とみなす (直後の poll で同じファイルを取り直さない)
        if (((s.feed as RefreshThrottledFeed).candleRefreshIntervalMs?.(tf) ?? 0) > 0) this.lastCandleFetch.set(`${sym}|${tf}`, this.clock.now());
      } catch {
        // feed が持たない足は 1m からの集約 (なければ quote から組み立て)
        const m1 = s.candles["1m"];
        if (tf !== "1m" && m1 && m1.length > 0 && msOf(tf) > msOf("1m")) {
          s.candles[tf] = aggregateCandles(m1, msOf(tf));
          const set = this.aggregated.get(sym) ?? new Set<Timeframe>();
          set.add(tf);
          this.aggregated.set(sym, set);
        } else {
          s.built.set(tf, new CandleBuilder(msOf(tf)));
          s.candles[tf] = [];
        }
      }
    }
    s.loaded = true;
  }

  /** 1 銘柄を更新。失敗は lastError に保持して握りつぶす (他銘柄の更新を止めない) */
  async pollSymbol(symbol: string): Promise<void> {
    const s = this.symbols.get(symbol);
    if (!s) throw new Error(`未登録の銘柄: ${symbol}`);
    try {
      if (!s.loaded) await this.load(s);
      await this.gate(s.feed);
      const q = await s.feed.fetchQuote(symbol);
      s.quote = q;
      const mid = (q.bid + q.ask) / 2;
      for (const [tf, b] of s.built) {
        b.push(q.ts, q.last ?? mid);
        s.candles[tf] = b.all();
      }
      if (this.withBook && s.feed.fetchOrderBook) {
        await this.gate(s.feed);
        s.book = await s.feed.fetchOrderBook(symbol);
      }
      if (s.feed.fetchPrints) {
        await this.gate(s.feed);
        const incoming = await s.feed.fetchPrints(symbol, 100);
        s.prints = mergePrints(s.prints, incoming, this.printsLimit);
      }
      if (isLocalCandleFeed(s.feed)) {
        // 手元の足を持つ feed: 全体を取り直して置き換える (外部 API は呼ばない)
        for (const tf of this.tfs) s.candles[tf] = await s.feed.fetchCandles(symbol, tf, LOCAL_CANDLES_MAX);
        s.lastError = undefined;
        return;
      }
      // feed から取得する足は直近数本を更新 (未確定足の確定を取り込む)
      for (const tf of this.tfs) {
        if (s.built.has(tf)) continue;
        const feedHasTf = (s.candles[tf]?.length ?? 0) > 0;
        if (!feedHasTf) continue;
        const m1 = s.candles["1m"];
        if (tf !== "1m" && m1 && !this.feedSupports(s, tf)) {
          s.candles[tf] = aggregateCandles(m1, TIMEFRAME_MS[tf]);
          continue;
        }
        const interval = (s.feed as RefreshThrottledFeed).candleRefreshIntervalMs?.(tf) ?? 0;
        if (interval > 0) {
          await this.refreshThrottled(s, tf, interval, q.ts, q.last ?? mid);
          continue;
        }
        await this.gate(s.feed);
        const recent = await s.feed.fetchCandles(symbol, tf, 5);
        s.candles[tf] = mergeCandles(s.candles[tf] ?? [], recent);
      }
      s.lastError = undefined;
    } catch (e) {
      s.lastError = e instanceof Error ? e.message : String(e);
      log.warn("poll 失敗", { symbol, error: s.lastError });
    }
  }

  /**
   * 間引き対象の feed の足更新。
   * 次をすべて満たすときは取得を見送り、現在足だけ気配で更新する:
   * - 前回取得から interval 未満
   * - 持っている最後の足がまだ形成中 (開始 + 足の長さ > now)。確定したら新しい足が始まっているので必ず取る
   * - 前回取得がその足の開始 + 猶予より後 (足が切り替わった直後の取得は前の足の確定値を含まないことがあるため)
   * 境界は取得した足の ts から求める (取引所の足が UTC 以外 (JST 等) にそろっていても正しく判定する)。
   * 取得するときは since = 最後に持っている足の ts で、そこから現在までの本数だけ要求する。
   */
  private async refreshThrottled(s: SymbolState, tf: Timeframe, interval: number, quoteTs: number, price: number): Promise<void> {
    const symbol = s.instrument.symbol;
    const ms = TIMEFRAME_MS[tf];
    const now = this.clock.now();
    const key = `${symbol}|${tf}`;
    const last = this.lastCandleFetch.get(key);
    const arr = s.candles[tf] ?? [];
    const cur = arr[arr.length - 1];
    if (last !== undefined && cur && now - last < interval && cur.ts + ms > now && last >= cur.ts + BOUNDARY_GRACE_MS) {
      // 現在足の区間内の気配なら高値・安値・終値を更新する。次回の取得で取引所の値に置き換わる
      if (Number.isFinite(price) && price > 0 && quoteTs >= cur.ts && quoteTs < cur.ts + ms) {
        const next = { ...cur, high: Math.max(cur.high, price), low: Math.min(cur.low, price), close: price };
        s.candles[tf] = [...arr.slice(0, -1), next];
      }
      return;
    }
    const since = arr.length ? arr[arr.length - 1].ts : undefined;
    const limit = since === undefined ? 5 : Math.max(5, Math.ceil((now - since) / ms) + 2);
    await this.gate(s.feed);
    const recent = await s.feed.fetchCandles(symbol, tf, limit, since);
    this.lastCandleFetch.set(key, now);
    s.candles[tf] = mergeCandles(arr, recent);
  }
  /** 間引き対象の (銘柄|時間足) ごとの最後の足取得時刻 (clock) */
  private readonly lastCandleFetch = new Map<string, number>();

  /** 履歴取得時に feed が直接返した時間足か (集約で作った足でないか) */
  private feedSupports(s: SymbolState, tf: Timeframe): boolean {
    return !this.aggregated.get(s.instrument.symbol)?.has(tf);
  }
  private readonly aggregated = new Map<string, Set<Timeframe>>();

  /**
   * 全監視銘柄を更新する。feed (venue) ごとに並列で、同じ feed の銘柄は順に取得する (レート制限のため)。
   * timeoutMs を指定すると、その時間で待つのをやめて戻る。終わらなかった venue の取得は裏で続け、
   * 次回の poll はその完了を待つ (同じ venue を二重に取得しない = 次回へ持ち越し)。
   * 戻り値の timedOut は時間内に終わらなかった venue、timedOutSymbols はその venue の銘柄
   * (エンジンはそのティックの新規エントリーの対象から外す)。
   */
  async poll(opts: { timeoutMs?: number } = {}): Promise<{ timedOut: string[]; timedOutSymbols: string[] }> {
    const byFeed = new Map<MarketDataFeed, string[]>();
    for (const [symbol, s] of this.symbols) {
      const list = byFeed.get(s.feed) ?? [];
      list.push(symbol);
      byFeed.set(s.feed, list);
    }
    const done = new Set<MarketDataFeed>();
    const tasks: Promise<void>[] = [];
    for (const [feed, symbols] of byFeed) {
      let p = this.inflight.get(feed);
      if (!p) {
        const run = (async () => {
          // 取得中に監視から外した銘柄 (unwatch) は飛ばす
          for (const symbol of symbols) if (this.symbols.has(symbol)) await this.pollSymbol(symbol);
        })().catch((e) => log.warn("poll 失敗", { venue: feed.venue, error: e instanceof Error ? e.message : String(e) }));
        p = run.finally(() => {
          if (this.inflight.get(feed) === p) this.inflight.delete(feed);
        });
        this.inflight.set(feed, p);
      }
      tasks.push(p.then(() => void done.add(feed)));
    }
    const all = Promise.all(tasks).then(() => undefined);
    const timeoutMs = opts.timeoutMs;
    if (timeoutMs === undefined || !(timeoutMs > 0)) {
      await all;
      return { timedOut: [], timedOutSymbols: [] };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    if (timer) clearTimeout(timer);
    const late = [...byFeed.keys()].filter((f) => !done.has(f));
    const timedOut = late.map((f) => f.venue);
    const timedOutSymbols = late.flatMap((f) => byFeed.get(f) ?? []);
    if (timedOut.length) log.warn("poll が時間内に終わらない venue を次回へ持ち越します", { venues: timedOut, timeoutMs });
    return { timedOut, timedOutSymbols };
  }
  /** 取得中の venue (feed) ごとの poll */
  private readonly inflight = new Map<MarketDataFeed, Promise<void>>();

  /** 最後の poll が失敗した銘柄のエラー (成功すれば消える)。エンジンはこの銘柄の新規エントリーを止める */
  lastError(symbol: string): string | undefined {
    return this.symbols.get(symbol)?.lastError;
  }

  /** 保持している時間足 (短い順) */
  timeframes(): Timeframe[] {
    return [...this.tfs].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
  }

  /** 表示用のローソク足 (形成中の足を含む・昇順・直近 limit 本のコピー)。未登録の銘柄・時間足は undefined */
  chartCandles(symbol: string, tf: Timeframe, limit = 200): Candle[] | undefined {
    const s = this.symbols.get(symbol);
    if (!s || !this.tfs.includes(tf)) return undefined;
    return (s.candles[tf] ?? []).slice(-Math.max(1, limit)).map((c) => ({ ...c }));
  }

  latestQuote(symbol: string): Quote | undefined {
    return this.symbols.get(symbol)?.quote;
  }

  /** 戦略へ渡す視点。candles は確定足のみ・昇順。quote 未取得なら undefined */
  getView(symbol: string, now: number = this.clock.now()): MarketView | undefined {
    const s = this.symbols.get(symbol);
    if (!s || !s.quote) return undefined;
    const candles: Partial<Record<Timeframe, Candle[]>> = {};
    for (const tf of this.tfs) {
      const c = s.candles[tf];
      if (c && c.length) candles[tf] = closedCandles(c, tf, now);
    }
    return {
      instrument: s.instrument,
      now,
      quote: s.quote,
      ...(s.book ? { book: s.book } : {}),
      ...(s.prints.length ? { prints: s.prints.slice() } : {}),
      candles,
    };
  }
}

function mergePrints(base: TradePrint[], incoming: TradePrint[], max: number): TradePrint[] {
  const seen = new Set(base.map((p) => `${p.ts}|${p.price}|${p.size}|${p.side}`));
  const out = base.slice();
  for (const p of incoming) {
    const k = `${p.ts}|${p.price}|${p.size}|${p.side}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.length > max ? out.slice(out.length - max) : out;
}
