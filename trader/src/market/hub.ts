import { createLogger } from "../core/logger";
import {
  systemClock, TIMEFRAME_MS, type Candle, type Clock, type Instrument, type MarketDataFeed, type MarketView, type OrderBook, type Quote,
  type Timeframe, type TradePrint,
} from "../core/types";
import { aggregateCandles, CandleBuilder, closedCandles, mergeCandles } from "./candles";

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

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    for (const tf of [...this.tfs].sort((a, b) => msOf(a) - msOf(b))) {
      try {
        await this.gate(s.feed);
        const c = await s.feed.fetchCandles(sym, tf, this.historyLimit);
        if (c.length === 0) throw new Error("empty");
        s.candles[tf] = mergeCandles([], c);
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
          for (const symbol of symbols) await this.pollSymbol(symbol);
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
