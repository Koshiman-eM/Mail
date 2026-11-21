/** 設定 (VENUES / WATCHLIST) から実行に必要な部品一式を組み立てる */
import { basename, dirname, extname, join } from "node:path";
import type { AiOptions } from "../core/ai";
import type { AppConfig } from "../core/config";
import { createLogger, type Logger } from "../core/logger";
import { withSimulatedShort } from "../core/short";
import {
  systemClock, TIMEFRAME_MS, type AssetClass, type Clock, type Instrument, type MarketDataFeed, type Store, type Strategy, type Timeframe,
} from "../core/types";
import { createBrokers, LIVE_UNSUPPORTED_MESSAGE, type BrokerSet } from "../execution/router";
import { createDefaultSources, IntelService } from "../intel/service";
import type { IntelSource } from "../intel/sources/common";
import { LearningService, type LearningServiceDeps } from "../learning/service";
import { CcxtFeed } from "../market/feeds/ccxt";
import { SyntheticFeed } from "../market/feeds/synthetic";
import { MarketHub } from "../market/hub";
import { RiskManager } from "../risk/manager";
import { createStore } from "../storage";
import { ALL_STRATEGIES, configuredStrategies } from "../strategies/registry";
import { strategyIdListWarnings } from "../strategies/retired";
import { structureConfigWarnings, structureSettingsFromEnv } from "../structure/settings";
import { TradingEngine, type EngineOptions } from "./engine";
import { ClosedCandleCacheFeed } from "./feedCache";
import { createFxConverter, type FxConverter } from "./fx";
import { createParamValidator, createPriceAt, type ValidatorOptions } from "./learningHooks";
import { limitOrdersFromEnv } from "./limitOrders";
import { thesisSettingsFromEnv } from "./thesis";
import {
  reversalAppliesTo, reversalConfigWarnings, reversalSettingsFromEnv, reversalTimeframeFor, type ReversalSettings,
} from "./reversalExit";

const ASSET_CLASSES: AssetClass[] = ["crypto", "meme"];
/** 廃止した資産クラス (FX・株式)。WATCHLIST に残っていても起動を止めず、警告してその銘柄を無視する */
const REMOVED_ASSET_CLASSES = ["fx", "stock"] as const;
export const KNOWN_VENUES = ["synthetic", "ccxt"] as const;
/**
 * 廃止した取引先 (GMOコイン・OANDA・Alpaca・DEX)。VENUES / WATCHLIST に残っていても起動を止めず、警告して無視する
 * (古い .env のままサーバーを再起動しても落ちないように)
 */
const REMOVED_VENUES = ["gmo", "oanda", "alpaca", "dex"] as const;
/** ccxt で WATCHLIST が空のときに探す既定銘柄 (存在するものを最大 3 つ) */
export const DEFAULT_CCXT_SYMBOLS = ["BTC/JPY", "ETH/JPY", "BTC/USDT", "ETH/USDT", "SOL/USDT", "DOGE/USDT"];
/** 合成フィードの履歴 (上位足の 4h 足 (pullback_15m・構造フィルターの MTF) が十分に揃う長さ) */
export const DEFAULT_SYNTHETIC_HISTORY_MS = 15 * 86_400_000;

export interface WatchEntry {
  /** synthetic / ccxt / ccxt:<id> */
  venue: string;
  symbol: string;
  assetClass?: AssetClass;
}

/**
 * WATCHLIST ("venue|symbol|assetClass" のカンマ区切り) を解析する。
 * 廃止した資産クラス (fx / stock) の銘柄は warn に知らせて除く (起動は止めない)。それ以外の未知のクラスは書き間違いとして起動を止める
 */
export function parseWatchlist(s: string, warn?: (message: string) => void): WatchEntry[] {
  const out: WatchEntry[] = [];
  for (const raw of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [venue, symbol, cls] = raw.split("|").map((x) => x.trim());
    if (!venue || !symbol) throw new Error(`WATCHLIST の形式が不正です: "${raw}" (venue|symbol|assetClass)`);
    if (cls && (REMOVED_ASSET_CLASSES as readonly string[]).includes(cls.toLowerCase())) {
      warn?.(`WATCHLIST の "${raw}" は廃止した資産クラス (${cls}) のため無視します (使える資産クラス: ${ASSET_CLASSES.join("/")}。.env から外してください)`);
      continue;
    }
    if (cls && !ASSET_CLASSES.includes(cls as AssetClass)) throw new Error(`WATCHLIST の資産クラスが不正です: "${raw}" (${ASSET_CLASSES.join("/")})`);
    out.push({ venue: venue.toLowerCase(), symbol, ...(cls ? { assetClass: cls as AssetClass } : {}) });
  }
  return out;
}

/** 廃止した取引先 (gmo / oanda / alpaca / dex。ccxt:<id> の形も) か */
export const isRemovedVenue = (v: string) => (REMOVED_VENUES as readonly string[]).includes(v.split(":")[0]);

/**
 * VENUES を解析する (ccxt:<id> も可)。廃止した取引先 (gmo / oanda / alpaca / dex) は warn に知らせて一覧から除く (起動は止めない)。
 * それ以外の未知の値は書き間違いとして起動を止める
 */
export function parseVenues(s: string, warn?: (message: string) => void): string[] {
  const list = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const removed = list.filter(isRemovedVenue);
  for (const v of list) {
    const kind = v.split(":")[0];
    if (!isRemovedVenue(v) && !(KNOWN_VENUES as readonly string[]).includes(kind)) throw new Error(`未知の VENUES: ${v} (${KNOWN_VENUES.join(", ")})`);
  }
  if (removed.length > 0) {
    warn?.(`VENUES の ${removed.join(", ")} は廃止した取引先のため無視します (使える取引先: ${KNOWN_VENUES.join(", ")}。.env から外してください)`);
  }
  return list.filter((v) => !isRemovedVenue(v));
}

/**
 * 実際に使う取引先。parseVenues の結果が空で、廃止した取引先 (gmo など) だけが書かれていたときは、
 * 古い .env のまま paper が起動できなくならないように ccxt (CCXT_EXCHANGE、既定 bitbank) の相場で動かす (warn に知らせる)
 */
export function effectiveVenues(s: string, warn?: (message: string) => void): string[] {
  const list = parseVenues(s, warn);
  if (list.length > 0) return list;
  const removed = s.split(",").map((x) => x.trim().toLowerCase()).filter(isRemovedVenue);
  if (removed.length === 0) return list;
  warn?.(`VENUES に使える取引先が無いため ccxt (CCXT_EXCHANGE) の相場で動かします (VENUES=${removed.join(",")} は廃止。.env の VENUES を ccxt にしてください)`);
  return ["ccxt"];
}

/**
 * live の発注先 (実口座アダプター) はまだ無い (GMOコインは廃止。Jupiter の実弾は次の段階で実装予定)。
 * mode が live なら常に起動を止める (fail-closed)。ccxt・synthetic は相場の取得と paper 用で、live の発注はできない
 */
export function assertLiveSupported(mode: "paper" | "live"): void {
  if (mode === "live") throw new Error(LIVE_UNSUPPORTED_MESSAGE);
}

/**
 * 監視銘柄の資産クラスに合う戦略の時間足の和集合 + 1m (短い順)。
 * reversal (転換で決済) を渡すと、対象の戦略の判定用の時間足 (REVERSAL_EXIT_TF=lower なら主時間足の 1 つ下) も加える
 * (保有中の建玉の判定に使う。hub は監視銘柄すべてで同じ時間足を取得するので、建玉のある銘柄でも必ず手に入る)
 */
export function hubTimeframesFor(
  instruments: Pick<Instrument, "assetClass">[], strategies: readonly Strategy[], reversal?: ReversalSettings,
): Timeframe[] {
  const classes = new Set(instruments.map((i) => i.assetClass));
  const tfs = new Set<Timeframe>(["1m"]);
  for (const s of strategies) {
    if (!s.assetClasses.some((c) => classes.has(c))) continue;
    for (const tf of [...s.timeframes, s.primaryTimeframe]) tfs.add(tf);
    if (reversalAppliesTo(reversal, s.id)) tfs.add(reversalTimeframeFor(reversal, s.primaryTimeframe));
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
  /** store を閉じる (エンジンは先に stop すること) */
  close(): void;
}

const withClass = (inst: Instrument, cls?: AssetClass): Instrument => (cls && cls !== inst.assetClass ? { ...inst, assetClass: cls } : inst);

/** VENUES と WATCHLIST から feed / instrument / hub / brokers / store / risk / intel / learning / engine を組み立てる */
export async function buildRuntime(config: AppConfig, opts: RuntimeOptions = {}): Promise<Runtime> {
  const log = opts.logger ?? createLogger("setup");
  const env = config.env;
  const clock = opts.clock ?? systemClock;
  // 相場構造のフィルター (STRUCTURE_MODE) は戦略のラップで掛ける。エンジン・パラメータ検証・計画が同じラップ済みの一覧を使う。
  // opts.strategies を渡したときはそのまま使う (テスト・独自の一覧)
  const structureSettings = structureSettingsFromEnv(env);
  for (const w of structureConfigWarnings(structureSettings, ALL_STRATEGIES.map((x) => x.id))) log.warn(w);
  // 転換で決済 (REVERSAL_*): 未登録の戦略 id と、STRUCTURE_EXIT_ON_REVERSAL との併用 (重複) を警告する
  const reversalSettings = reversalSettingsFromEnv(env);
  const knownIds = [...new Set([...ALL_STRATEGIES.map((x) => x.id), ...(opts.strategies ?? []).map((x) => x.id)])];
  for (const w of reversalConfigWarnings(reversalSettings, knownIds, env.STRUCTURE_EXIT_ON_REVERSAL === true)) log.warn(w);
  // 観測専用 (OBSERVE_ONLY_STRATEGIES): 廃止した戦略・未登録の id は警告する (集合の判定なので、残っていても何も起きない)
  for (const w of strategyIdListWarnings("OBSERVE_ONLY_STRATEGIES", env.OBSERVE_ONLY_STRATEGIES, knownIds)) log.warn(w);
  const strategies = opts.strategies ?? configuredStrategies(structureSettings);
  // live の発注先はまだ無いので、live では feed・DB に触れる前に起動を止める (fail-closed)。
  // テストで偽の live ブローカー (opts.brokerSet) を渡したときだけ live の経路を組み立てる (実口座アダプターは生成しない)
  if (config.mode === "live" && !opts.brokerSet) assertLiveSupported(config.mode);
  const venues = effectiveVenues(env.VENUES, (m) => log.warn(m));
  const watch = parseWatchlist(env.WATCHLIST, (m) => log.warn(m)).filter((w) => {
    if (!isRemovedVenue(w.venue)) return true;
    log.warn("廃止した取引先の WATCHLIST の銘柄を無視します", { venue: w.venue, symbol: w.symbol });
    return false;
  });
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
    }
  }
  // paper の空売りの再現: 発注先の mode が paper で PAPER_SIMULATE_SHORT=true のときだけ、空売り不可の現物暗号資産に
  // simulatedShort を付ける (allowShort は書き換えない。live では付けず、付いていても canShort が live では無視する)
  const tradeMode = opts.brokerSet?.mode ?? config.mode;
  for (const p of pairs) p.inst = withSimulatedShort(p.inst, { mode: tradeMode, enabled: env.PAPER_SIMULATE_SHORT });
  const instruments = pairs.map((p) => p.inst);
  if (instruments.length === 0) throw new Error("監視銘柄がありません (VENUES / WATCHLIST を確認してください)");

  const timeframes = hubTimeframesFor(instruments, strategies, reversalSettings);
  const hub = new MarketHub({ feeds, clock, timeframes, historyLimit: 300 });
  for (const p of pairs) hub.watch(p.inst, p.feed);

  const fx = createFxConverter({ baseCurrency: env.BASE_CURRENCY, getQuote: (s) => hub.latestQuote(s) });
  // mode は config (resolveMode の結果) のまま。live の発注先は無い (上の assertLiveSupported。createBrokers も live を拒否する)
  const brokerSet =
    opts.brokerSet ??
    createBrokers(config, instruments, {
      clock,
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
    // 合成フィードはキャッシュ層 (直近 2000 本まで) を通さず内側から取る
    validate: createParamValidator({
      hub, strategies, clock,
      feedFor: (inst) => {
        const f = pairs.find((p) => p.inst.symbol === inst.symbol)?.feed;
        if (!f) return undefined;
        return f instanceof ClosedCandleCacheFeed ? f.inner : f;
      },
      briefsBetween: (since, until) => store.listBriefs?.({ since, until }) ?? [],
      intelInfluence: (cls): number => learning.intelInfluence(cls),
      minEdgeToCostRatio: config.risk.minEdgeToCostRatio,
      riskPerTrade: config.risk.riskPerTrade,
      maxPositionPct: config.risk.maxPositionPct,
      // 指値 (maker) の前提を実運用 (LIMIT_ENTRY / LIMIT_TAKE_PROFIT。利確の指値は paper だけ) に合わせて検証する
      limitOrders: limitOrdersFromEnv(config.env, brokerSet.mode),
      // 最大保有 (MAX_HOLD_MINUTES) も実運用と同じ前提で検証する (0 = 無効。テンポはバックテストに渡さない)
      ...((config.env.MAX_HOLD_MINUTES ?? 0) > 0 ? { maxHoldMinutes: config.env.MAX_HOLD_MINUTES } : {}),
      // 読みの管理 (THESIS_*) も実運用と同じ規則で検証する
      thesis: thesisSettingsFromEnv(config.env),
      // 転換で決済 (REVERSAL_*) も実運用と同じ規則で検証する
      reversal: reversalSettings,
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
    ...(opts.engine ? { options: opts.engine } : {}),
  });
  return {
    config, clock, store, hub, feeds, instruments, timeframes, venues, brokerSet, risk, intel, learning, engine, fx,
    ...(ai ? { ai } : {}),
    close: () => store.close(),
  };
}
