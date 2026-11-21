import type { ArmStats, AssetClass, RegimeLabel, ShadowTradeRecord, Store, TradeRecord, TradingMode } from "../core/types";
import { tradeOutcome } from "./attribution";
import { clamp } from "../core/util";

/** paper で再現した空売りの腕のキーの接尾辞 */
export const SIMULATED_SHORT_ARM_SUFFIX = "|short";

/**
 * 腕のキー: 戦略×レジーム×資産クラス。
 * paper で再現した空売り (simulatedShort) は別の腕 `<戦略>|<レジーム>|<資産クラス>|short` で学習する
 * (live で実行できない取引の結果を買いの配分・停止の判断に混ぜない)。買いと、取引所で空売りできる銘柄の売り (廃止した GMOコイン・FX・株の古い記録) は
 * 従来どおり接尾辞なしのキー (保存済みの腕と互換)。live では simulatedShort が無いので short の腕は使われない
 */
export const armKey = (strategyId: string, regime: RegimeLabel, assetClass: AssetClass, simulatedShort = false) =>
  `${strategyId}|${regime}|${assetClass}${simulatedShort ? SIMULATED_SHORT_ARM_SUFFIX : ""}`;

export const armKeyOf = (t: TradeRecord) => armKey(t.strategyId, t.entryContext.regime.label, t.assetClass, t.simulatedShort === true);

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
  /** 無効化判定に必要な最小件数 (実際の取引のみ。回復後は数え直す) */
  minSamplesToDisable: number;
  /**
   * 無効化の上側信頼限界の z 値。決済のたびに判定する逐次検定なので、固定標本の片側 95% (1.645) ではなく 2.5 を使う
   * (合成の勝敗列 +1.5R/−1R での試算: 期待 R +0.1 の腕が 300 取引中に一度でも無効化される割合 約 1%、
   * 期待 R −0.2 の腕が 300 取引以内に無効化される割合 約 88%。2.75 だと後者が約 82% で目標 80% の境目になる)
   */
  ucbZ: number;
  /**
   * 無効化の判定に使う「実際の取引だけ」の R の指数加重係数。ewmaAlpha (0.05 ≒ 有効 39 件) では
   * 標準誤差が下がらず期待 R −0.2 程度の腕を見分けられないため、より長い窓 (0.01 ≒ 有効 199 件) にする
   */
  realEwmaAlpha: number;
  /** 無効化された腕を試す確率 */
  exploreProb: number;
  /** 探索時の配分倍率 */
  exploreSize: number;
  /** 有効な腕の配分倍率の下限・上限 */
  minWeight: number;
  maxWeight: number;
  /** 勝率 (事後平均 − 0.5) を配分に反映する係数 */
  winTilt: number;
  /** 仮想トレード (見送ったシグナルの答え合わせ) 1 件の重み (実際の取引は 1) */
  shadowWeight: number;
  /**
   * 回復判定の事前の擬似重み。無効化した時点の (実取引のみの) 縮小推定を、この重みの事前観測として持ち、
   * 無効化中の観測 (実取引 1 + 仮想 shadowWeight) で更新する。0 を越えたら回復。
   * 合成データの試算 (期待 R −0.5 で止めた後に真の期待 R が変わる): 10 だと −0.2 の腕の約 5% が短い勝ち続きで
   * 戻ってしまい、30 だと +0.1 の腕の回復が遅い (中央値 約 360 機会)。20 で −0.2 の誤回復 約 1%、
   * +0.1 の回復 中央値 約 230 機会、+0.2 約 130 機会
   */
  recoverPriorW: number;
  /**
   * 回復判定の推定の指数加重係数 (観測 1 件あたり × 重み)。ewmaAlpha (0.05) だと仮想トレード中心の推定のぶれが大きく、
   * 期待 R −0.2 の腕でも数百件で偶然 0 を越えて戻ってしまうため、無効化と同じ長さの窓 (0.01) にする
   */
  recoverEwmaAlpha: number;
}

export const DEFAULT_ALLOCATOR_OPTIONS: AllocatorOptions = {
  priorAlpha: 2,
  priorBeta: 2,
  betaDecay: 0.98,
  ewmaAlpha: 0.05,
  priorVarR: 1,
  shrinkN: 10,
  minSamplesToDisable: 30,
  ucbZ: 2.5,
  realEwmaAlpha: 0.01,
  exploreProb: 0.05,
  exploreSize: 0.25,
  minWeight: 0.25,
  maxWeight: 1.5,
  winTilt: 0.3,
  shadowWeight: 0.25,
  recoverPriorW: 20,
  recoverEwmaAlpha: 0.01,
};

/**
 * 保存する状態 (ArmStats + R の指数加重分散)。ewmaR / ewmaVarR は序盤は (重み付き) 単純平均・分散。
 * - ewmaR / ewmaVarR / wN: 実際の取引 (重み 1) + 仮想トレード (重み shadowWeight)。配分倍率 (weight / sample) にだけ使う
 * - n / sumR / sumR2: 実際の取引だけの累計 (表示の平均 R)
 * - wN: 重み付きの件数。EWMA の係数と有効件数に使う。無ければ n
 * - shadowN / shadowWins / shadowSumR: 仮想トレードの件数・勝ち数・R の合計 (表示用)
 * 以下は無効化・回復の判定用 (無い旧データは get() で n / sumR / sumR2 から初期化する。保存済みの値は消さない)
 * - realN / realMeanR / realVarR: 実際の取引だけの件数・指数加重平均・分散 (係数 realEwmaAlpha)。無効化の判定に使う。
 *   回復したら 0 から数え直す (回復後に改めて minSamplesToDisable 件の実取引で判定する)
 * - disabled: 無効化状態 (都度計算せず状態として持つ。止める条件と戻す条件が異なるヒステリシス)
 * - recMeanR / recW: 無効化中の回復判定用の推定 (無効化時点の推定を事前値に、実取引 + 仮想トレードで更新)
 * - disabledAt / recoveredAt / disableCount: 直近の無効化・回復の時刻と、無効化した回数
 */
export interface ArmState extends ArmStats {
  ewmaVarR: number;
  wN?: number;
  shadowN?: number;
  shadowWins?: number;
  shadowSumR?: number;
  realN?: number;
  realMeanR?: number;
  realVarR?: number;
  disabled?: boolean;
  recMeanR?: number;
  recW?: number;
  disabledAt?: number;
  recoveredAt?: number;
  disableCount?: number;
}

/** 腕の状態の変化 (無効化 / 回復)。observe の戻り値にだけ付ける (保存しない) */
export type ArmTransition = "disabled" | "recovered";
export type ArmUpdate = ArmState & { transition?: ArmTransition };

export interface ArmSnapshot extends ArmState {
  winRate: number;
  /** 実際の取引の平均 R */
  meanR: number;
  /** 無効化の判定に使う上側信頼限界 (実取引のみ。縮小推定 + z·SE。実取引が無ければ +∞) */
  upperR: number;
  weight: number;
  disabled: boolean;
  shadowN: number;
  /** 仮想トレードの勝率・平均純 R (件数 0 なら 0) */
  shadowWinRate: number;
  shadowMeanR: number;
}

export type Rng = () => number;

/** 腕の状態の kv キー (mode 別。paper の学習を live に持ち込まない) */
export const armStateKey = (mode: TradingMode, key: string) => `arm:${mode}:${key}`;
/** 腕のキー一覧の kv キー (mode 別) */
export const armIndexKey = (mode: TradingMode) => `arm:${mode}:index`;
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
 * - 期待 R: 指数加重平均・分散 + 縮小推定 (実取引 + 仮想トレード)。配分倍率に使う
 * - weight: 0〜1.5 の配分倍率 (新しい腕は 1.0)。無効化中は 0
 * - 無効化 (止める): 実際の取引だけの統計で、件数 ≥ minSamplesToDisable かつ
 *   縮小推定した平均 + ucbZ·SE < 0。仮想トレードは使わない (有効な腕では仮想トレードは配分倍率にだけ効く)
 * - 回復 (戻す): 無効化中は、無効化時点の推定を事前値 (重み recoverPriorW) にして実取引 (重み 1) と
 *   仮想トレード (重み shadowWeight) で更新した推定が 0 を越えたら戻す。止める条件より緩いのでばたつかない
 * 状態は Store kv "arm:<mode>:<key>" に保存 (mode 別。省略時の mode は paper)。
 */
export class StrategyAllocator {
  readonly opts: AllocatorOptions;
  private readonly cache = new Map<string, ArmState>();

  constructor(
    private readonly store: Store,
    opts: Partial<AllocatorOptions> = {},
    readonly mode: TradingMode = "paper",
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
    const raw = this.store.kvGet<ArmState>(armStateKey(this.mode, key));
    const s = raw ? this.upgrade({ ...raw }) : undefined;
    if (s) this.cache.set(key, s);
    return s ? { ...s } : undefined;
  }

  /**
   * 旧データ (実取引のみの統計・無効化状態が無い) の初期化。実取引の累計 (n / sumR / sumR2) から
   * 平均・分散を作り、無効化状態は新しい規則で決める。保存は次の更新時 (既存の項目は消さない)
   */
  private upgrade(s: ArmState): ArmState {
    if (s.realN === undefined || !Number.isFinite(s.realN)) {
      const n = Number.isFinite(s.n) && s.n > 0 ? s.n : 0;
      const mean = n > 0 ? s.sumR / n : 0;
      s.realN = n;
      s.realMeanR = Number.isFinite(mean) ? mean : 0;
      s.realVarR = n > 0 && Number.isFinite(s.sumR2) ? Math.max(0, s.sumR2 / n - mean * mean) : 0;
    }
    s.realMeanR = Number.isFinite(s.realMeanR) ? s.realMeanR : 0;
    s.realVarR = Number.isFinite(s.realVarR) ? Math.max(0, s.realVarR!) : 0;
    if (s.disabled === undefined) {
      s.disabled = this.shouldDisable(s);
      if (s.disabled) {
        s.recMeanR = this.realShrunk(s);
        s.recW = this.opts.recoverPriorW;
        s.disabledAt = s.updatedAt;
      }
    }
    if (s.disabled && !(Number.isFinite(s.recMeanR) && Number.isFinite(s.recW))) {
      s.recMeanR = Math.min(0, this.realShrunk(s));
      s.recW = this.opts.recoverPriorW;
    }
    return s;
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
      realN: 0,
      realMeanR: 0,
      realVarR: 0,
      disabled: false,
    };
  }

  /** 決済済みトレードで腕を更新 (重み 1) */
  update(trade: TradeRecord, now: number = trade.exitTs): ArmUpdate {
    const outcome = tradeOutcome(trade);
    const winInc = outcome === "win" ? 1 : outcome === "breakeven" ? 0.5 : 0;
    return this.observe(armKeyOf(trade), winInc, trade.rMultiple, 1, now, false);
  }

  /**
   * 仮想トレード (見送ったシグナル) の結果で同じ腕を更新する。重みは shadowWeight (既定 0.25)。
   * 有効な腕では配分倍率の統計にだけ入れ、無効化の判定には使わない (仮想の結果だけでは腕を止めない)。
   * 無効化中の腕では回復の判定にも使う
   */
  updateShadow(t: ShadowTradeRecord, now: number = t.exitTs): ArmUpdate {
    const winInc = t.netR > 0 ? 1 : t.netR < 0 ? 0 : 0.5;
    return this.observe(armKey(t.strategyId, t.regime, t.assetClass, t.simulatedShort === true), winInc, t.netR, this.opts.shadowWeight, now, true);
  }

  /** 重み w の観測で腕を更新する (ベータ分布は w を足し、忘却も w 回分。EWMA の係数も w に比例) */
  private observe(key: string, winInc: number, rRaw: number, w: number, now: number, shadow: boolean): ArmUpdate {
    const o = this.opts;
    const prev = this.get(key);
    const s = prev ?? this.fresh(key, now);
    const decay = Math.pow(o.betaDecay, w);
    // 忘却: 事前分布へ少し戻してから加算
    s.alpha = o.priorAlpha + (s.alpha - o.priorAlpha) * decay + w * winInc;
    s.beta = o.priorBeta + (s.beta - o.priorBeta) * decay + w * (1 - winInc);

    const r = clamp(Number.isFinite(rRaw) ? rRaw : 0, -R_CLIP, R_CLIP);
    s.wN = (s.wN ?? s.n) + w;
    // 序盤は (重み付き) 単純平均 (係数 w/wN)、件数が増えたら指数加重 (係数 ewmaAlpha × w) に切り替える
    const a = Math.min(1, Math.max(w / s.wN, o.ewmaAlpha * w));
    const diff = r - s.ewmaR;
    s.ewmaR += a * diff;
    s.ewmaVarR = (1 - a) * (s.ewmaVarR + a * diff * diff);
    if (shadow) {
      s.shadowN = (s.shadowN ?? 0) + 1;
      s.shadowWins = (s.shadowWins ?? 0) + winInc;
      s.shadowSumR = (s.shadowSumR ?? 0) + r;
    } else {
      s.n += 1;
      s.sumR += r;
      s.sumR2 += r * r;
      // 実際の取引だけの統計 (序盤は単純平均、以降は係数 realEwmaAlpha の指数加重)
      s.realN = (s.realN ?? 0) + 1;
      const ar = Math.min(1, Math.max(1 / s.realN, o.realEwmaAlpha));
      const dr = r - (s.realMeanR ?? 0);
      s.realMeanR = (s.realMeanR ?? 0) + ar * dr;
      s.realVarR = (1 - ar) * ((s.realVarR ?? 0) + ar * dr * dr);
    }
    s.updatedAt = now;

    let transition: ArmTransition | undefined;
    if (!s.disabled) {
      // 止める: 実際の取引で判定する (仮想トレードでは止めない)
      if (!shadow && this.shouldDisable(s)) {
        s.disabled = true;
        s.disabledAt = now;
        s.disableCount = (s.disableCount ?? 0) + 1;
        // 回復判定の事前値 = 無効化時点の縮小推定 (負)。これを越える証拠が集まるまで戻さない
        s.recMeanR = this.realShrunk(s);
        s.recW = o.recoverPriorW;
        transition = "disabled";
      }
    } else {
      // 戻す: 無効化中は実取引 (重み 1) と仮想トレード (重み shadowWeight) で回復判定の推定を更新する。
      // 係数は序盤 w / recW (事前値との重み付き平均)、以降は recoverEwmaAlpha × w (古い証拠を忘れる)
      s.recW = (s.recW ?? o.recoverPriorW) + w;
      const ak = Math.min(1, Math.max(w / s.recW, o.recoverEwmaAlpha * w));
      s.recMeanR = (s.recMeanR ?? 0) + ak * (r - (s.recMeanR ?? 0));
      if (s.recMeanR > 0) {
        s.disabled = false;
        s.recoveredAt = now;
        delete s.recMeanR;
        delete s.recW;
        // 回復後は実取引の統計を数え直す (改めて minSamplesToDisable 件の実取引で判定する)
        s.realN = 0;
        s.realMeanR = 0;
        s.realVarR = 0;
        transition = "recovered";
      }
    }

    this.cache.set(key, s);
    this.store.kvSet(armStateKey(this.mode, key), s);
    if (!prev) {
      const idx = this.store.kvGet<string[]>(armIndexKey(this.mode)) ?? [];
      if (!idx.includes(key)) this.store.kvSet(armIndexKey(this.mode), [...idx, key]);
    }
    return transition ? { ...s, transition } : { ...s };
  }

  /** 実取引だけの有効件数 (指数加重の上限で頭打ち) */
  private realNEff(s: ArmState) {
    return Math.min(s.realN ?? 0, (2 - this.opts.realEwmaAlpha) / this.opts.realEwmaAlpha);
  }

  /** 実取引だけの R の分散 (事前分散と件数で混ぜる。少数サンプルで過小評価しない) */
  private realVar(s: ArmState) {
    const n = this.realNEff(s);
    return (n * Math.max(0, s.realVarR ?? 0) + this.opts.shrinkN * this.opts.priorVarR) / (n + this.opts.shrinkN);
  }

  /** 実取引だけの縮小推定した期待 R (実取引が無ければ 0) */
  private realShrunk(s: ArmState) {
    const n = this.realNEff(s);
    return n > 0 ? (n * (s.realMeanR ?? 0)) / (n + this.opts.shrinkN) : 0;
  }

  /** 実取引だけの上側信頼限界 (縮小推定 + z·SE)。実取引が無ければ +∞ */
  private realUpper(s: ArmState) {
    const n = this.realNEff(s);
    if (!(n > 0)) return Number.POSITIVE_INFINITY;
    return this.realShrunk(s) + this.opts.ucbZ * Math.sqrt(this.realVar(s) / n);
  }

  /** 止める条件: 実取引の件数 (回復後は数え直し) ≥ minSamplesToDisable かつ 上側信頼限界 < 0 */
  private shouldDisable(s: ArmState) {
    return (s.realN ?? 0) >= this.opts.minSamplesToDisable && this.realUpper(s) < 0;
  }

  /** 重み付きの件数 (旧データは n) */
  private wN(s: ArmState) {
    return s.wN ?? s.n;
  }

  private nEff(s: ArmState) {
    return Math.min(this.wN(s), this.effectiveN);
  }

  /** R の分散 (観測の指数加重分散を事前分散と件数で混ぜる。少数サンプルで過小評価しない) */
  private varR(s: ArmState) {
    const n = this.nEff(s);
    return (n * Math.max(0, s.ewmaVarR) + this.opts.shrinkN * this.opts.priorVarR) / (n + this.opts.shrinkN);
  }

  /** 縮小推定した期待 R (新しい腕は 0) */
  meanR(key: string): number {
    const s = this.get(key);
    if (!s || !(this.wN(s) > 0)) return 0;
    const n = this.nEff(s);
    return (n * s.ewmaR) / (n + this.opts.shrinkN);
  }

  winRate(key: string): number {
    const s = this.get(key);
    return s ? s.alpha / (s.alpha + s.beta) : this.opts.priorAlpha / (this.opts.priorAlpha + this.opts.priorBeta);
  }

  /** 無効化の判定に使う期待 R の上側信頼限界 (実際の取引だけ。縮小推定 + ucbZ·SE。実取引が無ければ +∞) */
  upperConfidenceR(key: string): number {
    const s = this.get(key);
    return s ? this.realUpper(s) : Number.POSITIVE_INFINITY;
  }

  /** 無効化中か (保存した状態。止める・戻す判定は更新時に行う) */
  isDisabled(key: string): boolean {
    return this.get(key)?.disabled === true;
  }

  /** 無効化中の回復判定の推定 (無効化中でなければ undefined) */
  recoveryR(key: string): number | undefined {
    const s = this.get(key);
    return s?.disabled ? s.recMeanR : undefined;
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
    return this.store.kvGet<string[]>(armIndexKey(this.mode)) ?? [];
  }

  /** 全腕の成績表 */
  snapshot(): ArmSnapshot[] {
    const out: ArmSnapshot[] = [];
    for (const key of this.keys()) {
      const s = this.get(key);
      if (!s) continue;
      const shadowN = s.shadowN ?? 0;
      out.push({
        ...s,
        winRate: this.winRate(key),
        meanR: s.n > 0 ? s.sumR / s.n : 0,
        upperR: this.upperConfidenceR(key),
        weight: this.weight(key),
        disabled: this.isDisabled(key),
        shadowN,
        shadowWinRate: shadowN > 0 ? (s.shadowWins ?? 0) / shadowN : 0,
        shadowMeanR: shadowN > 0 ? (s.shadowSumR ?? 0) / shadowN : 0,
      });
    }
    return out.sort((a, b) => b.n - a.n || b.shadowN - a.shadowN || a.key.localeCompare(b.key));
  }
}
