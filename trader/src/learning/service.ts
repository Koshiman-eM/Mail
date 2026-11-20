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
  TradingMode,
} from "../core/types";
import { armKey, StrategyAllocator, type AllocatorOptions, type ArmSnapshot, type ArmUpdate, type Rng } from "./allocator";
import { attributeTrade } from "./attribution";
import { DEFAULT_POST_EXIT_HORIZON_MS, fillPostExitMoves, type PriceAt } from "./journal";
import { loadForecastSummary, type ForecastSummary, type ForecastTracker } from "./forecast";
import { lastPostExitFillKey, lastReflectKey, lastTuneKey, migrateLearningModeSplit } from "./migration";
import { NewsOutcomeTracker, type NewsCheckOptions, type NewsCheckSummary } from "./newsCheck";
import { DEFAULT_INFLUENCE_SHADOW_WEIGHT, observeInfluenceWeighted } from "./influence";
import { reflect, type ReflectionResult } from "./reflection";
import { SourceReliabilityTracker, type ReliabilityOptions } from "./reliability";
import { isHaltShadowReason, isObserveOnlyShadowReason, shadowCountersKey, shadowOpenKey, summarizeShadowTrades, sumShadowCounters, type ShadowCounters, type ShadowSummary } from "./shadow";
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
  /** パラメータ候補の検証 (長い履歴を区間に分けたバックテスト)。無ければ規則による調整はせず、提案は "proposed" のまま適用しない */
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
  /** direction_bias で止めたシグナルの仮想トレードを情報の効き具合 (intelInfluence) に入れる重み (既定 0.25。0 で無効) */
  influenceShadowWeight?: number;
  /** 運用ログ系の保持期間 (既定: audit/intel/briefs/plans 30 日、equity 180 日) */
  operationalRetention?: { auditMs?: number; intelMs?: number; briefsMs?: number; plansMs?: number; equityMs?: number };
  /**
   * 学習状態 (腕・パラメータ・調整履歴・情報源の信頼度・ニュースの答え合わせ) の mode。省略時は paper。
   * 値動きの予想の集計 (エンジンが attachForecast していないとき) もこの mode を読む (省略時は記録の多い方)
   */
  mode?: TradingMode;
}

export interface PeriodicResult {
  postExitFilled: number;
  reattributed: number;
  /** エグジット後の値動きの補完で情報源の信頼度を直したトレードの数 */
  reliabilityRevised?: number;
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
  /** 値動きの予想の答え合わせ */
  forecast: ForecastSummary;
}

const ASSET_CLASSES: AssetClass[] = ["crypto", "meme", "fx", "stock"];
const MODES = ["paper", "live"] as const;

/**
 * 学習の窓口。
 * - onTradeClosed: 要因分析の保存 → アロケーター更新 → 情報源信頼度更新 → 監査ログ
 * - onShadowClosed: 見送ったシグナルの仮想トレードの保存 → アロケーターの重み付き更新 (既定 0.25)
 * - news: ニュースと値動きの答え合わせ (情報源の信頼度を重み 0.3 で更新。エンジンが ingest / evaluate を呼ぶ)
 * - periodic: エグジット後の値動きの補完 (と再分析) → 適用済み調整の事後評価 → tuner → 振り返り
 * - snapshot: ダッシュボード/レポート用の要約
 * 学習状態は mode 別のキーに保存する (paper の理想的な約定で学んだ内容を live に持ち込まない)。
 * 起動時に旧キー (mode なし) からの移行を 1 回だけ行う (migration.ts)。
 */
export class LearningService {
  readonly store: Store;
  readonly allocator: StrategyAllocator;
  readonly reliability: SourceReliabilityTracker;
  readonly tuner: ParamTuner;
  readonly news: NewsOutcomeTracker;
  /** 学習状態の mode */
  readonly mode: TradingMode;
  private readonly deps: LearningServiceDeps;
  private running = false;
  /** エンジンが持つ値動きの予想 (無ければ kv から読む) */
  private forecastTracker?: ForecastTracker;

  constructor(deps: LearningServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.mode = deps.mode ?? "paper";
    // 部品が状態を読み込む前に旧キーからの移行を済ませる (2 回目以降は何もしない)
    migrateLearningModeSplit(deps.store, this.mode);
    this.allocator = new StrategyAllocator(deps.store, deps.allocator, this.mode);
    this.reliability = new SourceReliabilityTracker(deps.store, deps.reliability, this.mode);
    this.news = new NewsOutcomeTracker(deps.store, this.reliability, deps.newsCheck, this.mode);
    this.tuner = new ParamTuner({
      mode: this.mode,
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
    // 推定約定の取引は学習に使わない (呼び出し側でも除外しているが念のため)
    if (trade.estimated) return this.attribute(trade);
    const att = this.attribute(trade);
    this.store.saveAttribution(att);
    const arm = this.allocator.update(trade);
    this.auditArmTransition(arm, trade.exitTs, { tradeId: trade.id, source: "trade" });
    // paper で再現した空売り (simulatedShort) は情報源の信頼度・情報の効き具合を更新しない
    // (live で実行できない取引の結果を、買いの判断に使う情報の重みに混ぜない。腕は方向別のキーで学習済み)
    const sources = trade.simulatedShort ? [] : this.reliability.update(trade);
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
        ...(trade.simulatedShort ? { simulatedShort: true } : {}),
        sources,
      },
    });
    return att;
  }

  /**
   * 仮想トレード (見送ったシグナル) の決済時に呼ぶ。保存 → 同じ腕を重み shadowWeight で更新。
   * 監視をやめて捨てたもの (unwatched) は学習に使わない。ParamTuner・要因分析には使わない。
   * 次のものは保存だけして腕の更新には使わない:
   * - 新規停止中 (halted / kill switch / 日次停止 / 状態不明の注文による一時停止) に記録したもの (isHaltShadowReason)
   * - 別の mode の仮想トレード
   * - 戦略がコストで見送ったシグナル (strategy_filter:*。測定専用, isObserveOnlyShadowReason)
   * 有効な腕では配分倍率にだけ効き、無効化中の腕では回復の判定にも使う (allocator)。
   * 計画の片側バイアスで止めたもの (reason "direction_bias") は、エントリー時の情報バイアス
   * (opts.intelSentiment。エンジンが記録時に覚えておく) があれば、情報の効き具合にも重み influenceShadowWeight で入れる
   */
  onShadowClosed(t: ShadowTradeRecord, opts: { intelSentiment?: number } = {}): void {
    if (t.exitReason === "unwatched") return;
    this.store.saveShadowTrade(t);
    if (t.mode !== undefined && t.mode !== this.mode) return;
    if (isHaltShadowReason(t.reason)) return;
    // 戦略自身がコストで落としたシグナルは、取る前提のシグナルではないので腕の配分に混ぜない。測定専用
    if (isObserveOnlyShadowReason(t.reason)) return;
    const arm = this.allocator.updateShadow(t);
    this.auditArmTransition(arm, t.exitTs, { shadowId: t.id, source: "shadow", reason: t.reason });
    const w = this.deps.influenceShadowWeight ?? DEFAULT_INFLUENCE_SHADOW_WEIGHT;
    // paper で再現した空売りの仮想トレードは情報の効き具合に入れない (腕は方向別のキーで学習済み。onTradeClosed と同じ理由)
    if (t.reason === "direction_bias" && !t.simulatedShort && w > 0 && typeof opts.intelSentiment === "number" && Number.isFinite(opts.intelSentiment)) {
      // 決済済みトレードの更新 (reliability.updateInfluence) と同じ尺度: x = 情報バイアス × 取引方向、y = R (仮想は純 R)
      const dir = t.direction === "long" ? 1 : -1;
      observeInfluenceWeighted(this.store, this.mode, this.reliability.opts, t.assetClass, opts.intelSentiment * dir, t.netR, w, t.exitTs);
    }
  }

  /** 腕の無効化・回復を監査ログに残す */
  private auditArmTransition(arm: ArmUpdate, ts: number, extra: Record<string, unknown>): void {
    if (!arm.transition) return;
    const r3 = (x: number | undefined) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(3)) : x);
    this.store.audit({
      ts,
      type: arm.transition === "disabled" ? "learning.arm_disabled" : "learning.arm_recovered",
      data: {
        arm: arm.key,
        n: arm.n,
        realN: arm.realN,
        realMeanR: r3(arm.realMeanR),
        // 回復直後は実取引の統計を数え直すので上側信頼限界は +∞ (JSON で null になるため載せない)
        ...(Number.isFinite(this.allocator.upperConfidenceR(arm.key)) ? { upperR: r3(this.allocator.upperConfidenceR(arm.key)) } : {}),
        ...(arm.transition === "disabled" ? { recoveryR: r3(arm.recMeanR), disableCount: arm.disableCount } : { disabledAt: arm.disabledAt }),
        shadowN: arm.shadowN ?? 0,
        ...extra,
      },
    });
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

  /** エンジンの値動きの予想を集計の対象にする (予想・判定・取引への反映はエンジンが行う) */
  attachForecast(t: ForecastTracker | undefined): void {
    this.forecastTracker = t;
  }

  /** 値動きの予想の答え合わせの集計 (直近 30 日)。ニュースの重みは情報源の信頼度とは別の指標 (重複して更新しない) */
  forecastSummary(now: number = Date.now()): ForecastSummary {
    return this.forecastTracker ? this.forecastTracker.summary(now) : loadForecastSummary(this.store, now, this.deps.mode);
  }

  private lastOperationalPrune = 0;

  /** 運用ログの剪定 (1 時間に 1 回まで。失敗しても学習の定期処理は止めない) */
  private pruneOperational(now: number): void {
    if (now - this.lastOperationalPrune < 3_600_000) return;
    this.lastOperationalPrune = now;
    const r = this.deps.operationalRetention ?? {};
    const DAY = 86_400_000;
    try {
      this.store.pruneOperational({
        audit: now - (r.auditMs ?? 30 * DAY),
        intel: now - (r.intelMs ?? 30 * DAY),
        briefs: now - (r.briefsMs ?? 30 * DAY),
        plans: now - (r.plansMs ?? 30 * DAY),
        equity: now - (r.equityMs ?? 180 * DAY),
      });
    } catch (e) {
      log.warn("運用ログの剪定に失敗 (学習は継続)", { error: e instanceof Error ? e.message : String(e) });
    }
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
        const lastFill = this.store.kvGet<number>(lastPostExitFillKey(this.mode));
        // 前回の補完以降 + 最長 horizon 分 (未補完分の再試行) だけを見る
        const since = lastFill !== undefined ? lastFill - 2 * maxH : now - this.tuner.opts.lookbackMs;
        const filled = fillPostExitMoves(this.store, this.deps.priceAt, horizons, { now, since });
        res.postExitFilled = filled.length;
        for (const t of filled) {
          const prev = this.store.getAttribution(t.id);
          this.store.saveAttribution(this.attribute(t, prev?.createdAt));
          res.reattributed++;
          // 情報源の信頼度: 決済時の更新をエグジット後の値動きで差分だけ直す (決済時の記録が無ければ何もしない = 二重に数えない)
          if (!t.estimated && !t.simulatedShort && (t.mode === undefined || t.mode === this.mode)) {
            try {
              if (this.reliability.reviseWithPostExit(t, now).length > 0) res.reliabilityRevised = (res.reliabilityRevised ?? 0) + 1;
            } catch (e) {
              log.warn("情報源の信頼度の補正に失敗 (学習は継続)", { tradeId: t.id, error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
        this.store.kvSet(lastPostExitFillKey(this.mode), now);
      }

      // 1b. 古い仮想トレードを消す (集計は直近だけを見る)
      this.store.pruneShadowTrades(now - (this.deps.shadowRetentionMs ?? 30 * 86_400_000));
      // 1c. 運用ログ系 (監査・ニュース・ブリーフ・計画・資産推移) の古い行を消す。学習データは消さない
      this.pruneOperational(now);

      // 2. 適用済み調整の事後評価 (悪化していれば元に戻す)
      res.reverted = this.tuner.reviewApplied(now);

      // 3. tuner
      const lastTune = this.store.kvGet<number>(lastTuneKey(this.mode));
      if (lastTune === undefined || now - lastTune >= (this.deps.tuneEveryMs ?? 3_600_000)) {
        res.adjustments.push(...(await this.tuner.run(now)));
        this.store.kvSet(lastTuneKey(this.mode), now);
      }

      // 4. 振り返り (提案は tuner の検証経路を通す)
      const lastReflect = this.store.kvGet<number>(lastReflectKey(this.mode));
      if (lastReflect === undefined || now - lastReflect >= (this.deps.reflectEveryMs ?? 86_400_000)) {
        const reflection = await reflect({
          store: this.store,
          now,
          mode: this.mode,
          windowMs: this.deps.reflectWindowMs ?? 7 * 86_400_000,
          ai: this.deps.ai,
          strategyRegimes: this.deps.strategyRegimes,
          getStrategy: this.deps.getStrategy ? (id) => this.deps.getStrategy!(id) : undefined,
        });
        res.reflection = reflection;
        for (const p of reflection.proposals) {
          // 振り返りの対象期間 = 提案の判断に使った期間。事後評価の比較対象はこれより前の取引にする (tuner.propose)
          const adj = await this.tuner.propose(p, now, { decisionFrom: now - (this.deps.reflectWindowMs ?? 7 * 86_400_000) });
          if (adj) res.adjustments.push(adj);
        }
        this.store.kvSet(lastReflectKey(this.mode), now);
      }
      return res;
    } catch (e) {
      log.error("学習の定期処理に失敗", { error: String(e) });
      throw e;
    } finally {
      this.running = false;
    }
  }

  /**
   * 腕の配分倍率 (探索込み)。エンジンがエントリー時にリスク予算に掛ける (無効化中の腕は exploreProb で探索)。
   * simulatedShort: paper で再現した空売りの腕 (…|short)
   */
  armWeight(strategyId: string, regime: RegimeLabel, assetClass: AssetClass, rng?: Rng, simulatedShort = false): number {
    return this.allocator.explorationWeight(armKey(strategyId, regime, assetClass, simulatedShort), rng);
  }

  /** 計画用の腕の配分倍率 (乱数なし・決定的。無効化中は 0) */
  armPlanWeight(strategyId: string, regime: RegimeLabel, assetClass: AssetClass, simulatedShort = false): number {
    return this.allocator.weight(armKey(strategyId, regime, assetClass, simulatedShort));
  }

  /** 腕が無効化中か (保存した状態) */
  isArmDisabled(strategyId: string, regime: RegimeLabel, assetClass: AssetClass, simulatedShort = false): boolean {
    return this.allocator.isDisabled(armKey(strategyId, regime, assetClass, simulatedShort));
  }

  /** 学習済みの現行パラメータ (未知の戦略は undefined) */
  paramsFor(strategyId: string, assetClass: AssetClass): Params | undefined {
    const info = this.deps.getStrategy?.(strategyId);
    return info ? this.tuner.currentParams(strategyId, assetClass, info.defaultParams) : undefined;
  }

  intelInfluence(assetClass: AssetClass): number {
    return this.reliability.intelInfluence(assetClass);
  }

  /** 全資産クラスの情報の効き具合 (計画の片側バイアスの補正に使う) */
  intelInfluences(): Record<AssetClass, number> {
    return Object.fromEntries(ASSET_CLASSES.map((c) => [c, this.reliability.intelInfluence(c)])) as Record<AssetClass, number>;
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
      adjustments: this.store.listAdjustments({ mode: this.mode, limit: opts.adjustmentLimit ?? 20 }),
      sources: this.reliability.all(),
      intelInfluence: Object.fromEntries(ASSET_CLASSES.map((c) => [c, this.reliability.intelInfluence(c)])) as Record<AssetClass, number>,
      causes: this.causeSummary(now - (opts.causeWindowMs ?? 30 * 86_400_000)),
      shadow: this.shadowSummary({ now, windowMs: opts.shadowWindowMs }),
      news: this.newsSummary(),
      forecast: this.forecastSummary(now),
    };
  }
}
