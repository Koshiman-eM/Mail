import type { AiOptions } from "../core/ai";
import { createLogger } from "../core/logger";
import type {
  AssetClass,
  CauseCode,
  Horizon,
  Lesson,
  ParamAdjustment,
  Params,
  RegimeLabel,
  ShadowTradeRecord,
  SourceReliability,
  Store,
  Strategy,
  TradeAttribution,
  TradeRecord,
} from "../core/types";
import { armKey, StrategyAllocator, type AllocatorOptions, type ArmSnapshot, type Rng } from "./allocator";
import { attributeTrade } from "./attribution";
import { DEFAULT_POST_EXIT_HORIZON_MS, fillPostExitMoves, type PriceAt } from "./journal";
import { NewsOutcomeTracker, type NewsCheckOptions, type NewsCheckSummary } from "./newsCheck";
import { reflect, type ReflectionResult } from "./reflection";
import { SourceReliabilityTracker, type ReliabilityOptions } from "./reliability";
import { shadowCountersKey, shadowOpenKey, summarizeShadowTrades, sumShadowCounters, type ShadowCounters, type ShadowSummary } from "./shadow";
import { ParamTuner, type ParamValidator, type TunerOptions } from "./tuner";

const log = createLogger("learning");

/** 学習に必要な戦略情報 (Strategy をそのまま渡せる) */
export type StrategyInfo = Pick<Strategy, "defaultParams" | "paramBounds"> & { regimes?: RegimeLabel[] };

export interface LearningServiceDeps {
  store: Store;
  /** strategyId → 戦略情報 (defaultParams / paramBounds / regimes)。未知なら undefined */
  getStrategy?: (strategyId: string) => StrategyInfo | undefined;
  /** strategyId → 適合レジーム (getStrategy の regimes より優先) */
  strategyRegimes?: Record<string, RegimeLabel[]>;
  /** パラメータ候補のバックテスト検証 (無ければ調整は "proposed" のまま適用しない) */
  validate?: ParamValidator;
  /** Claude API (キー空ならルールベース) */
  ai?: AiOptions;
  /** 任意時刻の価格 (エグジット後の値動きの計測用) */
  priceAt?: PriceAt;
  postExitHorizonMs?: Partial<Record<Horizon, number>>;
  /** tuner 実行間隔 (既定 1 時間) */
  tuneEveryMs?: number;
  /** 振り返り間隔 (既定 24 時間) */
  reflectEveryMs?: number;
  /** 振り返りの対象期間 (既定 7 日) */
  reflectWindowMs?: number;
  allocator?: Partial<AllocatorOptions>;
  reliability?: Partial<ReliabilityOptions>;
  tuner?: Partial<TunerOptions>;
  /** ニュースと値動きの答え合わせ */
  newsCheck?: Partial<NewsCheckOptions>;
  /** 決済済みの仮想トレードを残す期間 (既定 30 日。periodic で古いものを消す) */
  shadowRetentionMs?: number;
}

export interface PeriodicResult {
  postExitFilled: number;
  reattributed: number;
  reverted: ParamAdjustment[];
  adjustments: ParamAdjustment[];
  reflection?: ReflectionResult;
  skipped?: boolean;
}

export interface CauseSummary {
  trades: number;
  outcomes: Record<TradeAttribution["outcome"], number>;
  /** 要因コード別の件数 */
  all: Partial<Record<CauseCode, number>>;
  loss: Partial<Record<CauseCode, number>>;
  win: Partial<Record<CauseCode, number>>;
  /** 要因コード別の重み合計 */
  weighted: Partial<Record<CauseCode, number>>;
}

export interface LearningSnapshot {
  generatedAt: number;
  arms: ArmSnapshot[];
  lessons: Lesson[];
  adjustments: ParamAdjustment[];
  sources: Record<string, SourceReliability>;
  intelInfluence: Record<AssetClass, number>;
  causes: CauseSummary;
  /** 見送ったシグナルの答え合わせ (仮想トレード) */
  shadow: ShadowSummary;
  /** ニュースと値動きの答え合わせ */
  news: NewsCheckSummary;
}

const ASSET_CLASSES: AssetClass[] = ["crypto", "meme", "fx", "stock"];
const LAST_TUNE_KEY = "learning:lastTune";
const LAST_REFLECT_KEY = "learning:lastReflect";
const LAST_FILL_KEY = "learning:lastPostExitFill";
const MODES = ["paper", "live"] as const;

/**
 * 学習の窓口。
 * - onTradeClosed: 要因分析の保存 → アロケーター更新 → 情報源信頼度更新 → 監査ログ
 * - onShadowClosed: 見送ったシグナルの仮想トレードの保存 → アロケーターの重み付き更新 (既定 0.25)
 * - news: ニュースと値動きの答え合わせ (情報源の信頼度を重み 0.3 で更新。エンジンが ingest / evaluate を呼ぶ)
 * - periodic: エグジット後の値動きの補完 (と再分析) → 適用済み調整の事後評価 → tuner → 振り返り
 * - snapshot: ダッシュボード/レポート用の要約
 */
export class LearningService {
  readonly store: Store;
  readonly allocator: StrategyAllocator;
  readonly reliability: SourceReliabilityTracker;
  readonly tuner: ParamTuner;
  readonly news: NewsOutcomeTracker;
  private readonly deps: LearningServiceDeps;
  private running = false;

  constructor(deps: LearningServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.allocator = new StrategyAllocator(deps.store, deps.allocator);
    this.reliability = new SourceReliabilityTracker(deps.store, deps.reliability);
    this.news = new NewsOutcomeTracker(deps.store, this.reliability, deps.newsCheck);
    this.tuner = new ParamTuner({
      store: deps.store,
      getStrategy: (id) => deps.getStrategy?.(id),
      validate: deps.validate,
      strategyRegimes: deps.strategyRegimes,
      options: deps.tuner,
    });
  }

  private regimesFor(strategyId: string): Record<string, RegimeLabel[]> | undefined {
    const r = this.deps.strategyRegimes?.[strategyId] ?? this.deps.getStrategy?.(strategyId)?.regimes;
    return r ? { [strategyId]: r } : undefined;
  }

  attribute(trade: TradeRecord, now?: number): TradeAttribution {
    return attributeTrade(trade, { strategyRegimes: this.regimesFor(trade.strategyId), now });
  }

  /** 決済時に呼ぶ。同じトレードを二重に学習しない (2 回目は分析の返却のみ) */
  onTradeClosed(trade: TradeRecord): TradeAttribution {
    const existing = this.store.getAttribution(trade.id);
    this.store.saveTrade(trade);
    if (existing) return existing;
    const att = this.attribute(trade);
    this.store.saveAttribution(att);
    const arm = this.allocator.update(trade);
    const sources = this.reliability.update(trade);
    this.store.audit({
      ts: trade.exitTs,
      type: "learning.trade_closed",
      data: {
        tradeId: trade.id,
        strategyId: trade.strategyId,
        symbol: trade.symbol,
        outcome: att.outcome,
        rMultiple: trade.rMultiple,
        causes: att.causes.map((c) => ({ code: c.code, weight: Number(c.weight.toFixed(3)) })),
        arm: arm.key,
        armWeight: this.allocator.weight(arm.key),
        sources,
      },
    });
    return att;
  }

  /**
   * 仮想トレード (見送ったシグナル) の決済時に呼ぶ。保存 → 同じ腕を重み shadowWeight で更新。
   * 監視をやめて捨てたもの (unwatched) は学習に使わない。ParamTuner・要因分析には使わない
   */
  onShadowClosed(t: ShadowTradeRecord): void {
    if (t.exitReason === "unwatched") return;
    this.store.saveShadowTrade(t);
    this.allocator.updateShadow(t);
  }

  /** 見送ったシグナルの答え合わせの集計 (既定は直近 30 日) */
  shadowSummary(opts: { now?: number; windowMs?: number } = {}): ShadowSummary {
    const now = opts.now ?? Date.now();
    const since = now - (opts.windowMs ?? 30 * 86_400_000);
    const open = MODES.reduce((n, m) => n + (this.store.kvGet<unknown[]>(shadowOpenKey(m))?.length ?? 0), 0);
    const counters = sumShadowCounters(MODES.map((m) => this.store.kvGet<Partial<ShadowCounters>>(shadowCountersKey(m))));
    return summarizeShadowTrades(this.store.listShadowTrades({ since }), { open, counters, since });
  }

  newsSummary(): NewsCheckSummary {
    return this.news.summary();
  }

  /** 定期処理 (学習ループから呼ぶ)。同時実行はスキップ */
  async periodic(now: number): Promise<PeriodicResult> {
    if (this.running) return { postExitFilled: 0, reattributed: 0, reverted: [], adjustments: [], skipped: true };
    this.running = true;
    try {
      const res: PeriodicResult = { postExitFilled: 0, reattributed: 0, reverted: [], adjustments: [] };

      // 1. エグジット後の値動きを補完し、要因分析をやり直す (stop_too_tight / early_exit はこれに依存)
      if (this.deps.priceAt) {
        const horizons = { ...DEFAULT_POST_EXIT_HORIZON_MS, ...this.deps.postExitHorizonMs };
        const maxH = Math.max(...Object.values(horizons));
        const lastFill = this.store.kvGet<number>(LAST_FILL_KEY);
        // 前回の補完以降 + 最長 horizon 分 (未補完分の再試行) だけを見る
        const since = lastFill !== undefined ? lastFill - 2 * maxH : now - this.tuner.opts.lookbackMs;
        const filled = fillPostExitMoves(this.store, this.deps.priceAt, horizons, { now, since });
        res.postExitFilled = filled.length;
        for (const t of filled) {
          const prev = this.store.getAttribution(t.id);
          this.store.saveAttribution(this.attribute(t, prev?.createdAt));
          res.reattributed++;
        }
        this.store.kvSet(LAST_FILL_KEY, now);
      }

      // 1b. 古い仮想トレードを消す (集計は直近だけを見る)
      this.store.pruneShadowTrades(now - (this.deps.shadowRetentionMs ?? 30 * 86_400_000));

      // 2. 適用済み調整の事後評価 (悪化していれば元に戻す)
      res.reverted = this.tuner.reviewApplied(now);

      // 3. tuner
      const lastTune = this.store.kvGet<number>(LAST_TUNE_KEY);
      if (lastTune === undefined || now - lastTune >= (this.deps.tuneEveryMs ?? 3_600_000)) {
        res.adjustments.push(...(await this.tuner.run(now)));
        this.store.kvSet(LAST_TUNE_KEY, now);
      }

      // 4. 振り返り (提案は tuner の検証経路を通す)
      const lastReflect = this.store.kvGet<number>(LAST_REFLECT_KEY);
      if (lastReflect === undefined || now - lastReflect >= (this.deps.reflectEveryMs ?? 86_400_000)) {
        const reflection = await reflect({
          store: this.store,
          now,
          windowMs: this.deps.reflectWindowMs ?? 7 * 86_400_000,
          ai: this.deps.ai,
          strategyRegimes: this.deps.strategyRegimes,
          getStrategy: this.deps.getStrategy ? (id) => this.deps.getStrategy!(id) : undefined,
        });
        res.reflection = reflection;
        for (const p of reflection.proposals) {
          const adj = await this.tuner.propose(p, now);
          if (adj) res.adjustments.push(adj);
        }
        this.store.kvSet(LAST_REFLECT_KEY, now);
      }
      return res;
    } catch (e) {
      log.error("学習の定期処理に失敗", { error: String(e) });
      throw e;
    } finally {
      this.running = false;
    }
  }

  /** 腕の配分倍率 (探索込み)。エンジンがリスク予算に掛ける */
  armWeight(strategyId: string, regime: RegimeLabel, assetClass: AssetClass, rng?: Rng): number {
    return this.allocator.explorationWeight(armKey(strategyId, regime, assetClass), rng);
  }

  /** 学習済みの現行パラメータ (未知の戦略は undefined) */
  paramsFor(strategyId: string, assetClass: AssetClass): Params | undefined {
    const info = this.deps.getStrategy?.(strategyId);
    return info ? this.tuner.currentParams(strategyId, assetClass, info.defaultParams) : undefined;
  }

  intelInfluence(assetClass: AssetClass): number {
    return this.reliability.intelInfluence(assetClass);
  }

  sourceReliability(): Record<string, SourceReliability> {
    return this.reliability.all();
  }

  /** 要因の集計 */
  causeSummary(since?: number): CauseSummary {
    const sum: CauseSummary = { trades: 0, outcomes: { win: 0, loss: 0, breakeven: 0 }, all: {}, loss: {}, win: {}, weighted: {} };
    for (const a of this.store.listAttributions(since)) {
      sum.trades++;
      sum.outcomes[a.outcome]++;
      for (const c of a.causes) {
        sum.all[c.code] = (sum.all[c.code] ?? 0) + 1;
        sum.weighted[c.code] = (sum.weighted[c.code] ?? 0) + c.weight;
        if (a.outcome === "loss") sum.loss[c.code] = (sum.loss[c.code] ?? 0) + 1;
        if (a.outcome === "win") sum.win[c.code] = (sum.win[c.code] ?? 0) + 1;
      }
    }
    return sum;
  }

  /** ダッシュボード/レポート用の要約 */
  snapshot(opts: { now?: number; causeWindowMs?: number; shadowWindowMs?: number; lessonLimit?: number; adjustmentLimit?: number } = {}): LearningSnapshot {
    const now = opts.now ?? Date.now();
    return {
      generatedAt: now,
      arms: this.allocator.snapshot(),
      lessons: this.store.listLessons({ status: "active", limit: opts.lessonLimit ?? 20 }),
      adjustments: this.store.listAdjustments().slice(-(opts.adjustmentLimit ?? 20)),
      sources: this.reliability.all(),
      intelInfluence: Object.fromEntries(ASSET_CLASSES.map((c) => [c, this.reliability.intelInfluence(c)])) as Record<AssetClass, number>,
      causes: this.causeSummary(now - (opts.causeWindowMs ?? 30 * 86_400_000)),
      shadow: this.shadowSummary({ now, windowMs: opts.shadowWindowMs }),
      news: this.newsSummary(),
    };
  }
}
