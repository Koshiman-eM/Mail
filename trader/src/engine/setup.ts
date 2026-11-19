/** 設定 (VENUES / WATCHLIST) から実行に必要な部品一式を組み立てる */
import { basename, dirname, extname, join } from "node:path";
import type { AiOptions } from "../core/ai";
import type { AppConfig } from "../core/config";
import { createLogger, type Logger } from "../core/logger";
import { withSimulatedShort } from "../core/short";
import {
  systemClock, TIMEFRAME_MS, type AssetClass, type Clock, type Instrument, type MarketDataFeed, type Store, type Strategy, type Timeframe,
} from "../core/types";
import { createBrokers, type BrokerSet } from "../execution/router";
import { createDefaultSources, IntelService } from "../intel/service";
import type { IntelSource } from "../intel/sources/common";
import { LearningService, type LearningServiceDeps } from "../learning/service";
import { AlpacaFeed } from "../market/feeds/alpaca";
import { CcxtFeed } from "../market/feeds/ccxt";
import { DexScreenerFeed } from "../market/feeds/dexscreener";
import { OandaFeed } from "../market/feeds/oanda";
import { SyntheticFeed } from "../market/feeds/synthetic";
import { MarketHub } from "../market/hub";
import { RiskManager } from "../risk/manager";
import { createStore } from "../storage";
import { ALL_STRATEGIES } from "../strategies/registry";
import { TradingEngine, type EngineOptions } from "./engine";
import { ClosedCandleCacheFeed } from "./feedCache";
import { createFxConverter, type FxConverter } from "./fx";
import { createParamValidator, createPriceAt, type ValidatorOptions } from "./learningHooks";

const ASSET_CLASSES: AssetClass[] = ["crypto", "meme", "fx", "stock"];
export const KNOWN_VENUES = ["synthetic", "ccxt", "oanda", "alpaca", "dex"] as const;
/** ccxt で WATCHLIST が空のときに探す既定銘柄 (存在するものを最大 3 つ) */
export const DEFAULT_CCXT_SYMBOLS = ["BTC/JPY", "ETH/JPY", "BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT"];
export const DEFAULT_OANDA_SYMBOLS = ["USD/JPY", "EUR/USD"];
export const DEFAULT_ALPACA_SYMBOLS = ["AAPL", "MSFT"];
/** 合成フィードの履歴 (中期戦略の 4h 足 80 本が揃う長さ) */
export const DEFAULT_SYNTHETIC_HISTORY_MS = 15 * 86_400_000;

export interface WatchEntry {
  /** synthetic / ccxt / ccxt:<id> / oanda / alpaca / dex */
  venue: string;
  symbol: string;
  assetClass?: AssetClass;
}

/** WATCHLIST ("venue|symbol|assetClass" のカンマ区切り) を解析する */
export function parseWatchlist(s: string): WatchEntry[] {
  const out: WatchEntry[] = [];
  for (const raw of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [venue, symbol, cls] = raw.split("|").map((x) => x.trim());
    if (!venue || !symbol) throw new Error(`WATCHLIST の形式が不正です: "${raw}" (venue|symbol|assetClass)`);
    if (cls && !ASSET_CLASSES.includes(cls as AssetClass)) throw new Error(`WATCHLIST の資産クラスが不正です: "${raw}" (${ASSET_CLASSES.join("/")})`);
    out.push({ venue: venue.toLowerCase(), symbol, ...(cls ? { assetClass: cls as AssetClass } : {}) });
  }
  return out;
}

/** VENUES を解析する (ccxt:<id> も可) */
export function parseVenues(s: string): string[] {
  const list = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const v of list) {
    const kind = v.split(":")[0];
    if (!(KNOWN_VENUES as readonly string[]).includes(kind)) throw new Error(`未知の VENUES: ${v} (${KNOWN_VENUES.join(", ")})`);
  }
  return list;
}

/** 監視銘柄の資産クラスに合う戦略の時間足の和集合 + 1m (短い順) */
export function hubTimeframesFor(instruments: Pick<Instrument, "assetClass">[], strategies: readonly Strategy[]): Timeframe[] {
  const classes = new Set(instruments.map((i) => i.assetClass));
  const tfs = new Set<Timeframe>(["1m"]);
  for (const s of strategies) {
    if (!s.assetClasses.some((c) => classes.has(c))) continue;
    for (const tf of [...s.timeframes, s.primaryTimeframe]) tfs.add(tf);
  }
  return [...tfs].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
}

/** 合成データ用の DB パス (<DB_PATH のベース名>-synthetic.db)。memory / :memory: はそのまま */
export function syntheticDbPath(dbPath: string): string {
  if (dbPath === "" || dbPath === "memory" || dbPath === ":memory:") return dbPath;
  const ext = extname(dbPath);
  return join(dirname(dbPath), `${basename(dbPath, ext)}-synthetic.db`);
}

/**
 * 実際に使う DB パス。VENUES が synthetic だけなら DB_PATH の代わりに syntheticDbPath を使う
 * (合成データの学習結果・追跡ポジションを実データ用の DB に混ぜない)。
 */
export function resolveDbPath(config: Pick<AppConfig, "env">): string {
  const venues = config.env.VENUES.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const syntheticOnly = venues.length > 0 && venues.every((v) => v === "synthetic");
  return syntheticOnly ? syntheticDbPath(config.env.DB_PATH) : config.env.DB_PATH;
}

/** createBrokers 用に VENUES を instrument.venue の表記へそろえる (ccxt → ccxt:<CCXT_EXCHANGE>) */
export function brokerVenues(venues: string[], ccxtExchange: string): string {
  return venues.map((v) => (v === "ccxt" ? `ccxt:${ccxtExchange}` : v)).join(",");
}

export interface RuntimeOptions {
  clock?: Clock;
  /** 省略時は createStore(resolveDbPath(config)) */
  store?: Store;
  /**
   * テスト用: 発注先を差し替える (Broker を実装した偽のブローカーで live の経路を試す)。
   * 実口座アダプターはここでは生成しない。mode はこの brokerSet.mode に従う。
   */
  brokerSet?: BrokerSet;
  /** 情報源 (省略時は既定の一式。[] で情報収集なし) */
  intelSources?: IntelSource[];
  /** 合成フィードのシード */
  seed?: number;
  syntheticHistoryMs?: number;
  /** null で AI を使わない */
  ai?: AiOptions | null;
  rng?: () => number;
  fetchImpl?: typeof fetch;
  /** テスト用: ccxt の feed 生成 */
  createCcxtFeed?: (exchangeId: string) => MarketDataFeed;
  /** feed と銘柄を直接指定する (指定時は VENUES / WATCHLIST を使わない。テスト・独自 feed 用) */
  markets?: { feed: MarketDataFeed; instruments: Instrument[] }[];
  strategies?: readonly Strategy[];
  learning?: Partial<Omit<LearningServiceDeps, "store" | "getStrategy" | "validate" | "priceAt" | "ai">>;
  /** パラメータ検証の設定の上書き (区間数・履歴の長さ・feed の差し替えなど) */
  validation?: Partial<Omit<ValidatorOptions, "hub" | "strategies" | "clock">>;
  engine?: EngineOptions;
  logger?: Logger;
}

export interface Runtime {
  config: AppConfig;
  clock: Clock;
  store: Store;
  hub: MarketHub;
  feeds: MarketDataFeed[];
  instruments: Instrument[];
  timeframes: Timeframe[];
  venues: string[];
  brokerSet: BrokerSet;
  risk: RiskManager;
  intel: IntelService;
  learning: LearningService;
  engine: TradingEngine;
  fx: FxConverter;
  ai?: AiOptions;
  dexFeed?: DexScreenerFeed;
  /** store を閉じる (エンジンは先に stop すること) */
  close(): void;
}

const withClass = (inst: Instrument, cls?: AssetClass): Instrument => (cls && cls !== inst.assetClass ? { ...inst, assetClass: cls } : inst);

/** VENUES と WATCHLIST から feed / instrument / hub / brokers / store / risk / intel / learning / engine を組み立てる */
export async function buildRuntime(config: AppConfig, opts: RuntimeOptions = {}): Promise<Runtime> {
  const log = opts.logger ?? createLogger("setup");
  const env = config.env;
  const clock = opts.clock ?? systemClock;
  const strategies = opts.strategies ?? ALL_STRATEGIES;
  const venues = parseVenues(env.VENUES);
  const watch = parseWatchlist(env.WATCHLIST);
  if (config.mode === "live" && !opts.markets && venues.includes("synthetic")) throw new Error("synthetic は paper 専用です (live では使えません)");

  const feeds: MarketDataFeed[] = [];
  const pairs: { inst: Instrument; feed: MarketDataFeed }[] = [];
  const add = (inst: Instrument, feed: MarketDataFeed) => {
    if (pairs.some((p) => p.inst.symbol === inst.symbol)) {
      log.warn("同じシンボルが複数の venue にあるため後のものを無視します", { symbol: inst.symbol, venue: inst.venue });
      return;
    }
    if (!feeds.includes(feed)) feeds.push(feed);
    pairs.push({ inst, feed });
  };
  const entriesFor = (pred: (v: string) => boolean) => watch.filter((w) => pred(w.venue));
  let dexFeed: DexScreenerFeed | undefined;
  const allTfs: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
  const getDex = () => (dexFeed ??= new DexScreenerFeed({ clock, timeframes: allTfs, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }));

  for (const m of opts.markets ?? []) for (const inst of m.instruments) add(inst, m.feed);

  for (const v of opts.markets ? [] : venues) {
    const kind = v.split(":")[0];
    if (kind === "synthetic") {
      const feed = new ClosedCandleCacheFeed(
        new SyntheticFeed({ seed: opts.seed ?? 42, clock, historyMs: opts.syntheticHistoryMs ?? DEFAULT_SYNTHETIC_HISTORY_MS }),
        { clock },
      );
      const list = await feed.listInstruments();
      const entries = entriesFor((x) => x === "synthetic" || x === "paper");
      if (entries.length === 0) list.forEach((i) => add(i, feed));
      for (const e of entries) {
        const inst = list.find((i) => i.symbol === e.symbol);
        if (inst) add(withClass(inst, e.assetClass), feed);
        else log.warn("合成フィードに無い銘柄を無視します", { symbol: e.symbol, available: list.map((i) => i.symbol) });
      }
    } else if (kind === "ccxt") {
      const id = v.includes(":") ? v.slice(v.indexOf(":") + 1) : env.CCXT_EXCHANGE;
      try {
        const feed = opts.createCcxtFeed?.(id) ?? CcxtFeed.create(id);
        const list = await feed.listInstruments();
        const bySym = new Map(list.map((i) => [i.symbol, i]));
        const entries = entriesFor((x) => x === "ccxt" || x === `ccxt:${id}`);
        const wanted = entries.length
          ? entries
          : DEFAULT_CCXT_SYMBOLS.filter((s) => bySym.has(s)).slice(0, 3).map((symbol) => ({ venue: v, symbol }) as WatchEntry);
        for (const e of wanted) {
          const inst = bySym.get(e.symbol);
          if (inst) add(withClass(inst, e.assetClass), feed);
          else log.warn("取引所に無い銘柄を無視します", { exchange: id, symbol: e.symbol });
        }
      } catch (e) {
        log.warn("ccxt の初期化に失敗したためスキップします", { exchange: id, error: e instanceof Error ? e.message : String(e) });
      }
    } else if (kind === "oanda") {
      if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) throw new Error("oanda: OANDA_API_TOKEN / OANDA_ACCOUNT_ID が必要です");
      const entries = entriesFor((x) => x === "oanda");
      const symbols = entries.length ? entries.map((e) => e.symbol) : DEFAULT_OANDA_SYMBOLS;
      try {
        const feed = new OandaFeed({
          token: env.OANDA_API_TOKEN, accountId: env.OANDA_ACCOUNT_ID, env: env.OANDA_ENV === "live" ? "live" : "practice", symbols,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        for (const inst of await feed.listInstruments()) add(withClass(inst, entries.find((e) => e.symbol === inst.symbol)?.assetClass), feed);
      } catch (e) {
        log.warn("OANDA の初期化に失敗したためスキップします", { error: e instanceof Error ? e.message : String(e) });
      }
    } else if (kind === "alpaca") {
      if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) throw new Error("alpaca: ALPACA_KEY_ID / ALPACA_SECRET_KEY が必要です");
      const entries = entriesFor((x) => x === "alpaca");
      const symbols = entries.length ? entries.map((e) => e.symbol) : DEFAULT_ALPACA_SYMBOLS;
      const feed = new AlpacaFeed({
        keyId: env.ALPACA_KEY_ID, secretKey: env.ALPACA_SECRET_KEY, symbols, clock,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      for (const inst of await feed.listInstruments()) add(withClass(inst, entries.find((e) => e.symbol === inst.symbol)?.assetClass), feed);
    } else if (kind === "dex") {
      const feed = getDex();
      for (const e of entriesFor((x) => x === "dex")) {
        const [chainId, pairAddress] = e.symbol.split(":");
        if (!chainId || !pairAddress) {
          log.warn("dex の銘柄は dex|<chainId>:<pairAddress>|meme の形式で指定してください", { symbol: e.symbol });
          continue;
        }
        try {
          add(withClass(await feed.trackPair(chainId, pairAddress), e.assetClass), feed);
        } catch (err) {
          log.warn("DEX ペアの登録に失敗", { symbol: e.symbol, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  if (env.AUTO_MEME_WATCH) {
    const feed = getDex();
    if (!feeds.includes(feed)) feeds.push(feed);
  }
  // paper の空売りの再現: 発注先の mode が paper で PAPER_SIMULATE_SHORT=true のときだけ、空売り不可の現物暗号資産に
  // simulatedShort を付ける (allowShort は書き換えない。live では付けず、付いていても canShort が live では無視する)
  const tradeMode = opts.brokerSet?.mode ?? config.mode;
  for (const p of pairs) p.inst = withSimulatedShort(p.inst, { mode: tradeMode, enabled: env.PAPER_SIMULATE_SHORT });
  const instruments = pairs.map((p) => p.inst);
  if (instruments.length === 0) throw new Error("監視銘柄がありません (VENUES / WATCHLIST を確認してください)");

  const timeframes = hubTimeframesFor(instruments, strategies);
  const hub = new MarketHub({ feeds, clock, timeframes, historyLimit: 300 });
  for (const p of pairs) hub.watch(p.inst, p.feed);

  const fx = createFxConverter({ baseCurrency: env.BASE_CURRENCY, getQuote: (s) => hub.latestQuote(s) });
  // mode は config (resolveMode の結果) のまま。VENUES の表記だけ instrument.venue にそろえる
  const brokerConfig: AppConfig = { ...config, env: { ...env, VENUES: brokerVenues(venues, env.CCXT_EXCHANGE) } };
  const brokerSet =
    opts.brokerSet ??
    createBrokers(brokerConfig, instruments, {
      clock,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      toAccount: (ccy) => fx.toAccount(ccy),
      quoteProvider: (s) => hub.latestQuote(s),
    });

  const store = opts.store ?? createStore(resolveDbPath(config));
  // リスク状態は実際の発注先の mode ごとに分ける (paper の基準で live の kill switch を誤作動させない)
  const risk = new RiskManager(config.risk, store, { mode: brokerSet.mode });
  const ai = opts.ai === null ? undefined : (opts.ai ?? (config.ai.enabled ? { apiKey: config.ai.apiKey, model: config.ai.model } : undefined));
  // 学習状態は実際の発注先の mode ごとに分ける (paper の理想的な約定で学んだ内容を live に持ち込まない)。
  // 初回起動時に旧キー (mode なし) から移行する: paper はコピー、live は初期状態から (src/learning/migration.ts)
  const learning: LearningService = new LearningService({
    ...(opts.learning ?? {}),
    store,
    mode: brokerSet.mode,
    getStrategy: (id) => strategies.find((s) => s.id === id),
    // 検証は feed から長い履歴を取得して行う (hub の直近の足だけでは短すぎる)。
    // 合成フィードはキャッシュ層 (直近 2000 本まで) を通さず内側から取る。DEX は履歴を持たないので検証に使わない
    validate: createParamValidator({
      hub, strategies, clock,
      feedFor: (inst) => {
        const f = pairs.find((p) => p.inst.symbol === inst.symbol)?.feed;
        if (!f || f instanceof DexScreenerFeed) return undefined;
        return f instanceof ClosedCandleCacheFeed ? f.inner : f;
      },
      briefsBetween: (since, until) => store.listBriefs?.({ since, until }) ?? [],
      intelInfluence: (cls): number => learning.intelInfluence(cls),
      minEdgeToCostRatio: config.risk.minEdgeToCostRatio,
      riskPerTrade: config.risk.riskPerTrade,
      maxPositionPct: config.risk.maxPositionPct,
      ...(opts.validation ?? {}),
    }),
    priceAt: createPriceAt(hub, clock),
    ...(ai ? { ai } : {}),
  });
  // 情報源の信頼度は学習側 (mode 別) の現在値を読む
  const intel = new IntelService({
    store,
    mode: brokerSet.mode,
    getReliability: () => learning.sourceReliability(),
    sources: opts.intelSources ?? createDefaultSources({ env: { NEWS_RSS_FEEDS: env.NEWS_RSS_FEEDS, CRYPTOPANIC_TOKEN: env.CRYPTOPANIC_TOKEN } }),
    ...(ai ? { ai } : {}),
  });
  const engine = new TradingEngine({
    config, store, hub, brokerSet, risk, intel, learning, strategies, clock, fx, timeframes,
    ...(ai ? { ai } : {}),
    ...(opts.rng ? { rng: opts.rng } : {}),
    ...(dexFeed ? { dexFeed } : {}),
    ...(opts.engine ? { options: opts.engine } : {}),
  });
  return {
    config, clock, store, hub, feeds, instruments, timeframes, venues, brokerSet, risk, intel, learning, engine, fx,
    ...(ai ? { ai } : {}),
    ...(dexFeed ? { dexFeed } : {}),
    close: () => store.close(),
  };
}
