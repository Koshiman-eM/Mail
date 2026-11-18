import type { ArmStats, AssetClass, RegimeLabel, Store, TradeRecord } from "../core/types";
import { tradeOutcome } from "./attribution";

/** 腕のキー: 戦略×レジーム×資産クラス */
export const armKey = (strategyId: string, regime: RegimeLabel, assetClass: AssetClass) =>
  `${strategyId}|${regime}|${assetClass}`;

export const armKeyOf = (t: TradeRecord) => armKey(t.strategyId, t.entryContext.regime.label, t.assetClass);

export interface AllocatorOptions {
  /** 勝率のベータ事前分布 */
  priorAlpha: number;
  priorBeta: number;
  /** ベータ分布の忘却率 (1 件ごとに事前分布へ戻す割合の補数。0.98 ≒ 直近 50 件程度を重視) */
  betaDecay: number;
  /** R の指数加重平均の係数 */
  ewmaAlpha: number;
  /** R の分散の事前値 (R^2)。少数サンプルの分散推定に混ぜる */
  priorVarR: number;
  /** 期待 R の縮小推定に使う事前の擬似件数 */
  shrinkN: number;
  /** 無効化判定に必要な最小件数 */
  minSamplesToDisable: number;
  /** 上側信頼限界の z 値 (片側 95%) */
  ucbZ: number;
  /** 無効化された腕を試す確率 */
  exploreProb: number;
  /** 探索時の配分倍率 */
  exploreSize: number;
  /** 有効な腕の配分倍率の下限・上限 */
  minWeight: number;
  maxWeight: number;
  /** 勝率 (事後平均 − 0.5) を配分に反映する係数 */
  winTilt: number;
}

export const DEFAULT_ALLOCATOR_OPTIONS: AllocatorOptions = {
  priorAlpha: 2,
  priorBeta: 2,
  betaDecay: 0.98,
  ewmaAlpha: 0.05,
  priorVarR: 1,
  shrinkN: 10,
  minSamplesToDisable: 30,
  ucbZ: 1.645,
  exploreProb: 0.05,
  exploreSize: 0.25,
  minWeight: 0.25,
  maxWeight: 1.5,
  winTilt: 0.3,
};

/** 保存する状態 (ArmStats + R の指数加重分散)。ewmaR / ewmaVarR は序盤は単純平均・分散 */
export interface ArmState extends ArmStats {
  ewmaVarR: number;
}

export interface ArmSnapshot extends ArmState {
  winRate: number;
  meanR: number;
  upperR: number;
  weight: number;
  disabled: boolean;
}

export type Rng = () => number;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const INDEX_KEY = "arm:index";
/** R の外れ値の影響を抑える */
const R_CLIP = 10;

/** 標準正規乱数 (Box-Muller) */
function randNormal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** ガンマ乱数 (Marsaglia-Tsang)。shape < 1 は変換で対応 */
function randGamma(shape: number, rng: Rng): number {
  if (shape < 1) return randGamma(shape + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = randNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape; // フォールバック (平均値)
}

export function randBeta(a: number, b: number, rng: Rng): number {
  const x = randGamma(a, rng);
  const y = randGamma(b, rng);
  return x + y > 0 ? x / (x + y) : 0.5;
}

/**
 * 戦略配分 (多腕バンディット)。
 * - 勝率: ベータ事後分布 (忘却付き)
 * - 期待 R: 指数加重平均・分散 + 縮小推定
 * - weight: 0〜1.5 の配分倍率 (新しい腕は 1.0)。十分なサンプルで期待 R の上側信頼限界が負なら無効化 (0)
 * 状態は Store kv "arm:<key>" に保存。
 */
export class StrategyAllocator {
  readonly opts: AllocatorOptions;
  private readonly cache = new Map<string, ArmState>();

  constructor(
    private readonly store: Store,
    opts: Partial<AllocatorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_ALLOCATOR_OPTIONS, ...opts };
  }

  /** 指数加重の有効サンプル数の上限 */
  private get effectiveN(): number {
    return (2 - this.opts.ewmaAlpha) / this.opts.ewmaAlpha;
  }

  get(key: string): ArmState | undefined {
    const c = this.cache.get(key);
    if (c) return { ...c };
    const s = this.store.kvGet<ArmState>(`arm:${key}`);
    if (s) this.cache.set(key, s);
    return s ? { ...s } : undefined;
  }

  private fresh(key: string, now: number): ArmState {
    return {
      key,
      alpha: this.opts.priorAlpha,
      beta: this.opts.priorBeta,
      n: 0,
      sumR: 0,
      sumR2: 0,
      ewmaR: 0,
      ewmaVarR: 0,
      updatedAt: now,
    };
  }

  /** 決済済みトレードで腕を更新 */
  update(trade: TradeRecord, now: number = trade.exitTs): ArmState {
    const key = armKeyOf(trade);
    const o = this.opts;
    const prev = this.get(key);
    const s = prev ?? this.fresh(key, now);
    const outcome = tradeOutcome(trade);
    const winInc = outcome === "win" ? 1 : outcome === "breakeven" ? 0.5 : 0;
    // 忘却: 事前分布へ少し戻してから加算
    s.alpha = o.priorAlpha + (s.alpha - o.priorAlpha) * o.betaDecay + winInc;
    s.beta = o.priorBeta + (s.beta - o.priorBeta) * o.betaDecay + (1 - winInc);

    const r = clamp(Number.isFinite(trade.rMultiple) ? trade.rMultiple : 0, -R_CLIP, R_CLIP);
    s.n += 1;
    // 序盤は単純平均 (係数 1/n)、件数が増えたら指数加重 (係数 ewmaAlpha) に切り替える
    const a = Math.max(1 / s.n, o.ewmaAlpha);
    const diff = r - s.ewmaR;
    s.ewmaR += a * diff;
    s.ewmaVarR = (1 - a) * (s.ewmaVarR + a * diff * diff);
    s.sumR += r;
    s.sumR2 += r * r;
    s.updatedAt = now;

    this.cache.set(key, s);
    this.store.kvSet(`arm:${key}`, s);
    if (!prev) {
      const idx = this.store.kvGet<string[]>(INDEX_KEY) ?? [];
      if (!idx.includes(key)) this.store.kvSet(INDEX_KEY, [...idx, key]);
    }
    return { ...s };
  }

  private nEff(s: ArmState) {
    return Math.min(s.n, this.effectiveN);
  }

  /** R の分散 (観測の指数加重分散を事前分散と件数で混ぜる。少数サンプルで過小評価しない) */
  private varR(s: ArmState) {
    const n = this.nEff(s);
    return (n * Math.max(0, s.ewmaVarR) + this.opts.shrinkN * this.opts.priorVarR) / (n + this.opts.shrinkN);
  }

  /** 縮小推定した期待 R (新しい腕は 0) */
  meanR(key: string): number {
    const s = this.get(key);
    if (!s || s.n === 0) return 0;
    const n = this.nEff(s);
    return (n * s.ewmaR) / (n + this.opts.shrinkN);
  }

  winRate(key: string): number {
    const s = this.get(key);
    return s ? s.alpha / (s.alpha + s.beta) : this.opts.priorAlpha / (this.opts.priorAlpha + this.opts.priorBeta);
  }

  /** 期待 R の上側信頼限界 (指数加重平均ベース) */
  upperConfidenceR(key: string): number {
    const s = this.get(key);
    if (!s || s.n === 0) return Number.POSITIVE_INFINITY;
    return s.ewmaR + this.opts.ucbZ * Math.sqrt(this.varR(s) / this.nEff(s));
  }

  /** n ≥ minSamplesToDisable かつ 期待 R の上側信頼限界 < 0 */
  isDisabled(key: string): boolean {
    const s = this.get(key);
    if (!s || s.n < this.opts.minSamplesToDisable) return false;
    return this.upperConfidenceR(key) < 0;
  }

  private score(meanR: number, winP: number) {
    return 1 + meanR + this.opts.winTilt * (winP - 0.5);
  }

  /** 配分倍率 (決定的)。無効化された腕は 0、それ以外は minWeight〜maxWeight */
  weight(key: string): number {
    if (this.isDisabled(key)) return 0;
    return clamp(this.score(this.meanR(key), this.winRate(key)), this.opts.minWeight, this.opts.maxWeight);
  }

  /** トンプソンサンプリング版。勝率と期待 R を事後分布からサンプルして倍率に変換 */
  sample(key: string, rng: Rng = Math.random): number {
    if (this.isDisabled(key)) return this.explore(rng);
    const s = this.get(key) ?? this.fresh(key, 0);
    const p = randBeta(s.alpha, s.beta, rng);
    const n = this.nEff(s);
    const sd = Math.sqrt(this.varR(s) / (n + this.opts.shrinkN));
    const mu = this.meanR(key) + sd * randNormal(rng);
    return clamp(this.score(mu, p), this.opts.minWeight, this.opts.maxWeight);
  }

  /** 探索込みの倍率: 無効化された腕も exploreProb の確率で exploreSize の試行を許す */
  explorationWeight(key: string, rng: Rng = Math.random): number {
    return this.isDisabled(key) ? this.explore(rng) : this.weight(key);
  }

  private explore(rng: Rng) {
    return rng() < this.opts.exploreProb ? this.opts.exploreSize : 0;
  }

  keys(): string[] {
    return this.store.kvGet<string[]>(INDEX_KEY) ?? [];
  }

  /** 全腕の成績表 */
  snapshot(): ArmSnapshot[] {
    const out: ArmSnapshot[] = [];
    for (const key of this.keys()) {
      const s = this.get(key);
      if (!s) continue;
      out.push({
        ...s,
        winRate: this.winRate(key),
        meanR: s.n > 0 ? s.sumR / s.n : 0,
        upperR: this.upperConfidenceR(key),
        weight: this.weight(key),
        disabled: this.isDisabled(key),
      });
    }
    return out.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }
}
