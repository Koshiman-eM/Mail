/**
 * 実行に必要な部品一式 (hub / brokers / risk / intel / learning / engine) の組み立て (資産クラス・取引先によらない部分)。
 *
 * アプリ (trader・FX・株式) は RuntimeAssembly で次を渡す:
 * - markets: feed と銘柄 (取引先ごと)
 * - createLiveBrokers: live の発注先 (実口座アダプター。liveBrokerSet で venue → アダプターをまとめる)。
 *   無ければ live は起動しない (fail-closed)
 * - intelSources・strategies (省略時は構造フィルターを掛けた登録戦略)・calendar・holdingCost・venueLeverageCaps・periodic
 * 新規エントリーは必ず RiskManager.evaluateEntry を通る (エンジンの規則)。実弾の二重ロックは config.mode (resolveMode) のまま。
 */
import type { AiOptions } from "../core/ai";
import type { MarketCalendar } from "../core/calendar";
import type { AppConfig } from "../core/config";
import type { HoldingCostModel } from "../core/holdingCost";
import { createLogger, type Logger } from "../core/logger";
import { withSimulatedShort } from "../core/short";
import { systemClock, TIMEFRAME_MS, type Clock, type Instrument, type MarketDataFeed, type Quote, type Store, type Strategy, type Timeframe } from "../core/types";
import { createPaperBrokerSet, type BrokerDeps, type BrokerSet } from "../execution/brokerSet";
import { IntelService } from "../intel/service";
import type { IntelSource } from "../intel/sources/common";
import { LearningService, type LearningServiceDeps } from "../learning/service";
import { MarketHub } from "../market/hub";
import { RiskManager } from "../risk/manager";
import { createStore } from "../storage";
import { ALL_STRATEGIES, configuredStrategies } from "../strategies/registry";
import { observeOnlyWarnings } from "../strategies/observeOnly";
import { structureConfigWarnings, structureSettingsFromEnv } from "../structure/settings";
import { TradingEngine, type EngineOptions, type MarketExtras, type PeriodicTask } from "./engine";
import { ClosedCandleCacheFeed } from "./feedCache";
import { createFxConverter, type FxConverter } from "./fx";
import { createParamValidator, createPriceAt, type ValidatorOptions } from "./learningHooks";
import { limitOrdersFromEnv } from "./limitOrders";
import { thesisSettingsFromEnv } from "./thesis";
import { breakevenSettingsFromEnv } from "./breakeven";
import { reversalAppliesTo, reversalConfigWarnings, reversalSettingsFromEnv, reversalTimeframeFor, type ReversalSettings } from "./reversalExit";

/** live の発注先 (実口座アダプター) が無いアプリで live を起動しようとしたときの文言 */
export const NO_LIVE_BROKERS_MESSAGE = "live の発注先 (実口座アダプター) がありません";

export interface RuntimeMarket {
  feed: MarketDataFeed;
  instruments: Instrument[];
}

/** アプリが渡す部品 (資産クラス・取引先に固有のもの) */
export interface RuntimeAssembly {
  /** feed と銘柄 (同じシンボルが複数あれば後のものを無視する) */
  markets: RuntimeMarket[];
  /**
   * live の発注先を作る (liveBrokerSet で venue → 実口座アダプター。アダプターはコンストラクタで assertLive を呼ぶ)。
   * 無ければ live では起動しない (fail-closed)
   */
  createLiveBrokers?: (ctx: { config: AppConfig; instruments: Instrument[]; clock: Clock; fx: FxConverter; hub: MarketHub }) => BrokerSet;
  /** paper の PaperBroker の追加の設定 (成行の約定価格・成行だけの取引先など) */
  paperBroker?: BrokerDeps["paper"];
  /** 情報源 (省略時は情報収集なし) */
  intelSources?: IntelSource[];
  /** 戦略の一覧 (そのまま使う。構造フィルターは掛けない) */
  strategies?: readonly Strategy[];
  /**
   * 構造フィルター (STRUCTURE_MODE) を掛ける前の戦略の一覧 (省略時は登録戦略 ALL_STRATEGIES)。
   * FX・株式は selectStrategies / withAssetClasses で自分の資産クラスの一覧を作って渡す
   */
  strategyBase?: readonly Strategy[];
  /** 取引時間 (省略時は常に開いている) */
  calendar?: MarketCalendar;
  /** 建玉の保有コスト (省略時は再現した空売りの借入コスト) */
  holdingCost?: HoldingCostModel;
  /** 取引先ごとの実効レバレッジの上限 (RiskManager。省略時は判定しない) */
  venueLeverageCaps?: Record<string, number>;
  /** 定期の処理 (為替レート・銘柄情報の更新など) */
  periodic?: PeriodicTask[];
  /** 取引先ごとの追加の情報 (流動性・コスト・新規の停止) */
  marketExtras?: MarketExtras;
  /** hub の時間足を決めるときに加える資産クラス (後から銘柄が増える取引先用) */
  extraTimeframeClasses?: Instrument["assetClass"][];
  /** 時間足が決まったときに呼ぶ (feed に時間足を伝えるなど) */
  onTimeframes?: (timeframes: Timeframe[]) => void;
  /** hub に無い気配の取得元 (口座通貨への換算レートなど) */
  fallbackQuote?: (symbol: string) => Quote | undefined;
  /**
   * パラメータ検証の長い履歴を取る feed (undefined = 検証しない)。省略時は銘柄の feed
   * (ClosedCandleCacheFeed は内側の feed)
   */
  validationFeed?: (inst: Instrument, feed: MarketDataFeed) => MarketDataFeed | undefined;
  /** close で呼ぶ (feed の停止など。store は assembleRuntime が閉じる) */
  onClose?: () => void;
}

/** 組み立ての上書き (テスト・simulate) */
export interface AssembleOptions {
  clock?: Clock;
  /** 省略時は createStore(dbPath ?? DB_PATH) */
  store?: Store;
  dbPath?: string;
  /** テスト用: 発注先を差し替える (偽の live ブローカーで live の経路を試す)。mode はこの brokerSet.mode に従う */
  brokerSet?: BrokerSet;
  /** 情報源の上書き ([] で情報収集なし) */
  intelSources?: IntelSource[];
  /** null で AI を使わない */
  ai?: AiOptions | null;
  rng?: () => number;
  /** 戦略の一覧の上書き */
  strategies?: readonly Strategy[];
  learning?: Partial<Omit<LearningServiceDeps, "store" | "getStrategy" | "validate" | "priceAt" | "ai">>;
  /** パラメータ検証の設定の上書き */
  validation?: Partial<Omit<ValidatorOptions, "hub" | "strategies" | "clock">>;
  engine?: EngineOptions;
  logger?: Logger;
}

export interface Runtime<C extends AppConfig = AppConfig> {
  config: C;
  clock: Clock;
  store: Store;
  hub: MarketHub;
  feeds: MarketDataFeed[];
  instruments: Instrument[];
  timeframes: Timeframe[];
  brokerSet: BrokerSet;
  risk: RiskManager;
  intel: IntelService;
  learning: LearningService;
  engine: TradingEngine;
  fx: FxConverter;
  ai?: AiOptions;
  calendar?: MarketCalendar;
  /** store を閉じる (エンジンは先に stop すること) */
  close(): void;
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
    // 決済を自分で管理する戦略 (managesOwnExit) は転換で決済を使わないので、その時間足は要らない
    if (s.managesOwnExit !== true && reversalAppliesTo(reversal, s.id)) tfs.add(reversalTimeframeFor(reversal, s.primaryTimeframe));
  }
  return [...tfs].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
}

/**
 * 設定の警告 (相場構造・転換で決済・観測専用の戦略 id) を出し、戦略の一覧を決める
 * (opts / assembly の strategies があればそのまま。無ければ登録戦略に構造フィルターを掛けたもの)
 */
export function resolveStrategies(config: AppConfig, log: Logger, given?: readonly Strategy[], base?: readonly Strategy[]): readonly Strategy[] {
  const env = config.env;
  // 相場構造のフィルター (STRUCTURE_MODE) は戦略のラップで掛ける。エンジン・パラメータ検証・計画が同じラップ済みの一覧を使う
  const structureSettings = structureSettingsFromEnv(env);
  for (const w of structureConfigWarnings(structureSettings, ALL_STRATEGIES.map((x) => x.id))) log.warn(w);
  // 転換で決済 (REVERSAL_*): 未登録の戦略 id と、STRUCTURE_EXIT_ON_REVERSAL との併用 (重複) を警告する
  const reversalSettings = reversalSettingsFromEnv(env);
  const knownIds = [...new Set([...ALL_STRATEGIES.map((x) => x.id), ...(given ?? []).map((x) => x.id)])];
  for (const w of reversalConfigWarnings(reversalSettings, knownIds, env.STRUCTURE_EXIT_ON_REVERSAL === true)) log.warn(w);
  // 観測専用 (OBSERVE_ONLY_STRATEGIES): 廃止した戦略・未登録の id は警告する (集合の判定なので、残っていても何も起きない)
  // `<id>:<資産クラス>` の資産クラスが使えない指定も警告して無視する
  for (const w of observeOnlyWarnings("OBSERVE_ONLY_STRATEGIES", env.OBSERVE_ONLY_STRATEGIES, knownIds)) log.warn(w);
  return given ?? configuredStrategies(structureSettings, base);
}

/** アプリの部品 (assembly) とコアの部品から実行に必要な一式を組み立てる */
export async function assembleRuntime<C extends AppConfig>(config: C, assembly: RuntimeAssembly, opts: AssembleOptions = {}): Promise<Runtime<C>> {
  const log = opts.logger ?? createLogger("setup");
  const env = config.env;
  const clock = opts.clock ?? systemClock;
  const strategies = resolveStrategies(config, log, opts.strategies ?? assembly.strategies, assembly.strategyBase);
  const reversalSettings = reversalSettingsFromEnv(env);
  // live の発注先が無ければ、feed・DB に触れる前に起動を止める (fail-closed)。テストの偽の live ブローカー (opts.brokerSet) は通す
  if (config.mode === "live" && !opts.brokerSet && !assembly.createLiveBrokers) throw new Error(NO_LIVE_BROKERS_MESSAGE);

  const store = opts.store ?? createStore(opts.dbPath ?? env.DB_PATH);
  const tradeMode = opts.brokerSet?.mode ?? config.mode;

  const feeds: MarketDataFeed[] = [];
  const pairs: { inst: Instrument; feed: MarketDataFeed }[] = [];
  for (const m of assembly.markets) {
    for (const inst of m.instruments) {
      if (pairs.some((p) => p.inst.symbol === inst.symbol)) {
        log.warn("同じシンボルが複数の venue にあるため後のものを無視します", { symbol: inst.symbol, venue: inst.venue });
        continue;
      }
      if (!feeds.includes(m.feed)) feeds.push(m.feed);
      pairs.push({ inst, feed: m.feed });
    }
  }
  // paper の空売りの再現: 発注先の mode が paper で PAPER_SIMULATE_SHORT=true のときだけ、空売り不可の銘柄 (プロファイルが許すクラス) に
  // simulatedShort を付ける (allowShort は書き換えない。live では付けず、付いていても canShort が live では無視する)
  for (const p of pairs) p.inst = withSimulatedShort(p.inst, { mode: tradeMode, enabled: env.PAPER_SIMULATE_SHORT });
  const instruments = pairs.map((p) => p.inst);
  if (instruments.length === 0) throw new Error("監視銘柄がありません (VENUES / WATCHLIST を確認してください)");

  const tfInsts = [...instruments, ...(assembly.extraTimeframeClasses ?? []).map((assetClass) => ({ assetClass }))];
  const timeframes = hubTimeframesFor(tfInsts, strategies, reversalSettings);
  assembly.onTimeframes?.(timeframes);
  const hub = new MarketHub({ feeds, clock, timeframes, historyLimit: 300 });
  for (const p of pairs) hub.watch(p.inst, p.feed);

  const fx = createFxConverter({ baseCurrency: env.BASE_CURRENCY, getQuote: (s) => hub.latestQuote(s) ?? assembly.fallbackQuote?.(s) });
  const brokerSet =
    opts.brokerSet ??
    (config.mode === "live"
      ? assembly.createLiveBrokers!({ config, instruments, clock, fx, hub })
      : createPaperBrokerSet(config, instruments, {
          clock,
          toAccount: (ccy) => fx.toAccount(ccy),
          quoteProvider: (s) => hub.latestQuote(s),
          ...(assembly.paperBroker || assembly.holdingCost
            ? { paper: { ...(assembly.paperBroker ?? {}), ...(assembly.holdingCost ? { holdingCost: assembly.holdingCost } : {}) } }
            : {}),
        }));
  if (brokerSet.mode !== tradeMode) throw new Error(`発注先の mode (${brokerSet.mode}) が設定の mode (${tradeMode}) と一致しません`);

  // リスク状態は実際の発注先の mode ごとに分ける (paper の基準で live の kill switch を誤作動させない)
  const risk = new RiskManager(config.risk, store, {
    mode: brokerSet.mode,
    ...(assembly.venueLeverageCaps ? { venueLeverageCaps: assembly.venueLeverageCaps } : {}),
    ...(assembly.calendar ? { calendar: assembly.calendar } : {}),
  });
  const ai = opts.ai === null ? undefined : (opts.ai ?? (config.ai.enabled ? { apiKey: config.ai.apiKey, model: config.ai.model } : undefined));
  const validationFeed = assembly.validationFeed ?? ((_inst: Instrument, f: MarketDataFeed) => (f instanceof ClosedCandleCacheFeed ? f.inner : f));
  // 学習状態は実際の発注先の mode ごとに分ける (paper の理想的な約定で学んだ内容を live に持ち込まない)。
  // 初回起動時に旧キー (mode なし) から移行する: paper はコピー、live は初期状態から (src/learning/migration.ts)
  const learning: LearningService = new LearningService({
    ...(opts.learning ?? {}),
    store,
    mode: brokerSet.mode,
    getStrategy: (id) => strategies.find((s) => s.id === id),
    // 検証は feed から長い履歴を取得して行う (hub の直近の足だけでは短すぎる)
    validate: createParamValidator({
      hub, strategies, clock,
      feedFor: (inst) => {
        const f = pairs.find((p) => p.inst.symbol === inst.symbol)?.feed;
        return f ? validationFeed(inst, f) : undefined;
      },
      briefsBetween: (since, until) => store.listBriefs?.({ since, until }) ?? [],
      intelInfluence: (cls): number => learning.intelInfluence(cls),
      minEdgeToCostRatio: config.risk.minEdgeToCostRatio,
      riskPerTrade: config.risk.riskPerTrade,
      maxPositionPct: config.risk.maxPositionPct,
      // 指値 (maker) の前提を実運用 (LIMIT_ENTRY / LIMIT_TAKE_PROFIT。利確の指値は paper だけ) に合わせて検証する
      limitOrders: limitOrdersFromEnv(env, brokerSet.mode),
      // 最大保有 (MAX_HOLD_MINUTES) も実運用と同じ前提で検証する (0 = 無効。テンポはバックテストに渡さない)
      ...((env.MAX_HOLD_MINUTES ?? 0) > 0 ? { maxHoldMinutes: env.MAX_HOLD_MINUTES } : {}),
      // 読みの管理 (THESIS_*) も実運用と同じ規則で検証する
      thesis: thesisSettingsFromEnv(env),
      // 転換で決済 (REVERSAL_*) も実運用と同じ規則で検証する
      reversal: reversalSettings,
      // 建値ストップ (BREAKEVEN_TRIGGER_R) も実運用と同じ規則で検証する
      breakeven: breakevenSettingsFromEnv(env),
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
    sources: opts.intelSources ?? assembly.intelSources ?? [],
    ...(ai ? { ai } : {}),
  });
  const engineOpts: EngineOptions | undefined = assembly.holdingCost
    ? { ...(opts.engine ?? {}), shadow: { holdingCost: assembly.holdingCost, ...(opts.engine?.shadow ?? {}) } }
    : opts.engine;
  const periodic = assembly.periodic ?? [];
  const engine = new TradingEngine({
    config, store, hub, brokerSet, risk, intel, learning, strategies, clock, fx, timeframes,
    ...(ai ? { ai } : {}),
    ...(opts.rng ? { rng: opts.rng } : {}),
    ...(engineOpts ? { options: engineOpts } : {}),
    ...(periodic.length ? { periodic } : {}),
    ...(assembly.marketExtras ? { marketExtras: assembly.marketExtras } : {}),
    ...(assembly.calendar ? { calendar: assembly.calendar } : {}),
  });
  return {
    config, clock, store, hub, feeds, instruments, timeframes, brokerSet, risk, intel, learning, engine, fx,
    ...(ai ? { ai } : {}),
    ...(assembly.calendar ? { calendar: assembly.calendar } : {}),
    close: () => {
      assembly.onClose?.();
      store.close();
    },
  };
}
