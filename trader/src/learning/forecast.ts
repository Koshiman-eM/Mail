/**
 * 銘柄ごとの「今後の値動きの予想」と、その答え合わせ・オンライン学習。
 *
 * 予想 (forecast):
 * - 監視銘柄ごとに intervalMs (既定 5 分) ごと、horizonsMs (既定 15 分・1 時間・4 時間) 後の値動きを予想する。
 * - 特徴量 (−1〜+1) は確定足だけから作る (先読みしない):
 *   trend (EMA の傾き・並び) / momentum (直近の変化率 ÷ ATR) / meanRevert (ボリンジャー・VWAP からの乖離、逆向き) /
 *   news (ブリーフの資産別バイアス sentiment × confidence) / consensus (直近の戦略シグナルの向きの合計)
 * - pUp = sigmoid(Σ w_i f_i + b)。重みは (予想時間, 資産クラス) ごと。初期値は小さく、pUp は 0.5 付近から始まる。
 * - |pUp − 0.5| < flatThreshold なら flat、それ以外は pUp > 0.5 で up、そうでなければ down。
 * - 値幅 (±%) = 主時間足の ATR 比 × √(予想時間 ÷ 時間足)。
 *
 * 答え合わせ (evaluate):
 * - 期限の価格 (1 分足の終値。無ければ期限から lateToleranceMs 以内に限り現在の仲値) と予想時の仲値を比べる。
 * - ノイズの範囲はニュースの答え合わせ (newsCheck) と同じ max(1 分足 ATR 比 × √分数 × noiseAtrMult, 往復コスト比)。
 *   範囲内の動きは結果 flat とし、学習には使わない。
 * - 的中率: 方向の予想 (up/down) と方向の結果 (up/down) の組だけで数える。flat の予想・flat の結果は別に数える
 *   (flat の予想は外れにも当たりにも数えない。結果 flat はノイズとして数える)。
 * - Brier スコア・較正: 方向の結果 (up = 1 / down = 0) が出たものすべて (flat の予想も含む) で計算する。
 * - 学習: オンラインのロジスティック回帰 (SGD、L2 正則化、重みの上限)。
 *
 * 取引への反映 (multiplierFor):
 * - (予想時間, 資産クラス) の判定済み (方向の予想 × 方向の結果) が minSamples 件以上、
 *   かつ的中率が 50% を有意に上回る (片側 95%、二項検定の正規近似・連続修正あり) ときだけ「LIVE」。
 *   重複する予想 (4 時間後の予想を 5 分ごと) は独立ではないので、z を √(予想時間 ÷ 間隔) で割って補正する。
 * - LIVE のとき、シグナルと予想の向きが一致すれば 1 + maxBoost × 強さ (最大 1.2)、逆なら 1 − maxCut × 強さ (最大 0.7 まで下げる)。
 *   強さ = |pUp − 0.5| × 2。LIVE でない間・予想が flat・古い予想は 1.0 (まったく影響しない)。
 *
 * 永続化 (mode 別の kv。SQLite / memory 共通):
 * - forecast:pending:<mode> 未判定の予想 (上限 maxPending、古い順に捨てる)
 * - forecast:model:<mode>   重み
 * - forecast:stats:<mode>   集計 (日ごとのバケツ。retentionMs を過ぎた日は捨てる)
 * - 判定済みの 1 件ずつは Store.saveForecastOutcomes (retentionMs で削除)
 * 監査ログには要約 (learning.forecast_summary) と反映状態の変化 (learning.forecast_live) だけを残す。
 */
import { randomUUID } from "node:crypto";
import {
  TIMEFRAME_MS, type AssetClass, type Candle, type ForecastDirection, type ForecastOutcomeRecord, type Horizon, type Store, type Timeframe,
  type TradingMode,
} from "../core/types";
import { atrLast, ema, smaLast, stdevLast, vwapLast } from "../indicators/series";
import type { PriceAt } from "./journal";
import { horizonLabel, noiseThreshold } from "./newsCheck";

export type { ForecastDirection } from "../core/types";

export const FORECAST_FEATURES = ["trend", "momentum", "meanRevert", "news", "consensus"] as const;
export type ForecastFeature = (typeof FORECAST_FEATURES)[number];
export type ForecastFeatures = Record<ForecastFeature, number>;

export const FORECAST_FEATURE_LABEL: Record<ForecastFeature, string> = {
  trend: "トレンド",
  momentum: "モメンタム",
  meanRevert: "平均回帰",
  news: "ニュース",
  consensus: "戦略の合意",
};

export interface ForecastOptions {
  /** 予想を出す間隔 (既定 5 分) */
  intervalMs: number;
  /** 予想する時間 (既定 15 分・1 時間・4 時間) */
  horizonsMs: number[];
  /** |pUp − 0.5| がこれ未満なら flat */
  flatThreshold: number;
  /** 未判定の予想の上限 (超えたら古い順に捨てる) */
  maxPending: number;
  /** ノイズの範囲 = max(ATR 比 (1 分あたり) × √分数 × noiseAtrMult, 往復コスト比) */
  noiseAtrMult: number;
  /** 期限の 1 分足が無いとき、期限からこの時間内なら現在の仲値で判定する */
  lateToleranceMs: number;
  learningRate: number;
  /** L2 正則化 (重みの減衰) */
  l2: number;
  /** |w| の上限 */
  maxWeight: number;
  /** |b| の上限 */
  maxBias: number;
  /** 重みの初期値 (全特徴量。バイアスは 0) */
  initialWeight: number;
  /** 取引に反映するのに必要な判定済みの件数 ((予想時間, 資産クラス) ごと) */
  minSamples: number;
  /** 片側検定の臨界値 (1.645 = 片側 95%) */
  zCritical: number;
  /** 判定済みの記録・集計を残す期間 (既定 30 日) */
  retentionMs: number;
  /** 一致時のサイズの上乗せの上限 (0.2 → 最大 1.2 倍) */
  maxBoost: number;
  /** 逆向き時のサイズの削減の上限 (0.3 → 最小 0.7 倍) */
  maxCut: number;
  /** これより古い予想は取引に使わない (既定 2 × intervalMs) */
  maxForecastAgeMs: number;
  /** 特徴量の計算に必要な確定足の本数 */
  minBars: number;
  /** 要約の監査ログの間隔 */
  auditEveryMs: number;
}

export const DEFAULT_FORECAST_OPTIONS: ForecastOptions = {
  intervalMs: 5 * 60_000,
  horizonsMs: [15 * 60_000, 60 * 60_000, 4 * 3_600_000],
  flatThreshold: 0.05,
  maxPending: 2_000,
  noiseAtrMult: 0.5,
  lateToleranceMs: 5 * 60_000,
  learningRate: 0.02,
  l2: 0.001,
  maxWeight: 3,
  maxBias: 1,
  initialWeight: 0.05,
  minSamples: 100,
  zCritical: 1.645,
  retentionMs: 30 * 86_400_000,
  maxBoost: 0.2,
  maxCut: 0.3,
  maxForecastAgeMs: 10 * 60_000,
  minBars: 30,
  auditEveryMs: 3_600_000,
};

// ───────────────────────── モデル (純粋関数) ─────────────────────────

export interface ForecastModel {
  w: ForecastFeatures;
  b: number;
  /** 学習した件数 */
  updates: number;
  updatedAt?: number;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const round = (x: number, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : 0);

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-clamp(z, -50, 50)));

export function initialModel(initialWeight = DEFAULT_FORECAST_OPTIONS.initialWeight): ForecastModel {
  const w = Object.fromEntries(FORECAST_FEATURES.map((k) => [k, initialWeight])) as ForecastFeatures;
  return { w, b: 0, updates: 0 };
}

export const featureArray = (f: ForecastFeatures): number[] => FORECAST_FEATURES.map((k) => round(clamp(f[k], -1, 1)));
export const featureObject = (a: readonly number[]): ForecastFeatures =>
  Object.fromEntries(FORECAST_FEATURES.map((k, i) => [k, clamp(Number(a[i]), -1, 1)])) as ForecastFeatures;

/** 線形結合 z = Σ w_i f_i + b */
export function logit(m: ForecastModel, f: ForecastFeatures): number {
  let z = m.b;
  for (const k of FORECAST_FEATURES) z += (m.w[k] ?? 0) * clamp(f[k], -1, 1);
  return z;
}

/** 上昇の確率 (0〜1) */
export function predictUp(m: ForecastModel, f: ForecastFeatures): number {
  return sigmoid(logit(m, f));
}

/** 方向の判定 */
export function classifyForecast(pUp: number, flatThreshold: number): ForecastDirection {
  if (!finite(pUp) || Math.abs(pUp - 0.5) < flatThreshold) return "flat";
  return pUp > 0.5 ? "up" : "down";
}

/**
 * オンラインのロジスティック回帰の 1 ステップ (y: 上昇 1 / 下落 0)。新しいモデルを返す。
 * w ← clamp(w − lr ((p − y) f + l2 w), ±maxWeight)、b ← clamp(b − lr (p − y), ±maxBias)
 */
export function sgdUpdate(
  m: ForecastModel,
  f: ForecastFeatures,
  y: 0 | 1,
  o: Pick<ForecastOptions, "learningRate" | "l2" | "maxWeight" | "maxBias">,
  now?: number,
): ForecastModel {
  const p = predictUp(m, f);
  const g = p - y;
  const w = { ...m.w };
  for (const k of FORECAST_FEATURES) w[k] = clamp((w[k] ?? 0) - o.learningRate * (g * clamp(f[k], -1, 1) + o.l2 * (w[k] ?? 0)), -o.maxWeight, o.maxWeight);
  const b = clamp(m.b - o.learningRate * g, -o.maxBias, o.maxBias);
  return { w, b, updates: m.updates + 1, ...(now !== undefined ? { updatedAt: now } : {}) };
}

/** 片側の二項検定 (正規近似・連続修正)。H0: 的中率 = 0.5 */
export function hitRateZ(n: number, hits: number): number {
  if (!(n > 0)) return 0;
  return (hits - 0.5 - n / 2) / Math.sqrt(n / 4);
}

/**
 * 実力が確かめられたか (判定済みが minSamples 件以上、かつ重複を補正した z ≥ zCritical)。
 * overlap: 予想時間 ÷ 予想の間隔 (4 時間後の予想を 5 分ごとに出すと 48 件が同じ値動きを共有する)。
 * 重複した予想は独立ではないので、有効な件数を n ÷ overlap とみなし z を √overlap で割る
 */
export function skillConfirmed(n: number, hits: number, o: Pick<ForecastOptions, "minSamples" | "zCritical">, overlap = 1): boolean {
  return n >= o.minSamples && hitRateZ(n, hits) / Math.sqrt(Math.max(1, overlap)) >= o.zCritical;
}

/** 予想の重複の度合い (予想時間 ÷ 予想の間隔、1 以上) */
export const forecastOverlap = (horizonMs: number, intervalMs: number) => (horizonMs > 0 && intervalMs > 0 ? Math.max(1, horizonMs / intervalMs) : 1);

/**
 * 新規エントリーのサイズの倍率。LIVE でない・予想が無い・flat なら 1.0。
 * 一致: 1 + maxBoost × 強さ / 逆: 1 − maxCut × 強さ (強さ = |pUp − 0.5| × 2)
 */
export function forecastSizeMultiplier(
  signal: "long" | "short",
  f: { direction: ForecastDirection; pUp: number } | undefined,
  live: boolean,
  o: Pick<ForecastOptions, "maxBoost" | "maxCut">,
): number {
  if (!live || !f || f.direction === "flat" || !finite(f.pUp)) return 1;
  const strength = clamp(Math.abs(f.pUp - 0.5) * 2, 0, 1);
  const agree = (signal === "long" && f.direction === "up") || (signal === "short" && f.direction === "down");
  return agree ? 1 + clamp(o.maxBoost, 0, 1) * strength : 1 - clamp(o.maxCut, 0, 1) * strength;
}

/** 戦略の時間軸 → 使う予想時間の目安 (scalp 15 分 / short 1 時間 / mid・long 4 時間) */
export const STRATEGY_FORECAST_TARGET_MS: Record<Horizon, number> = {
  scalp: 15 * 60_000,
  short: 60 * 60_000,
  mid: 4 * 3_600_000,
  long: 4 * 3_600_000,
};

/** 設定された予想時間のうち、戦略の時間軸に最も近いもの (対数で比べる) */
export function horizonForStrategy(h: Horizon, horizonsMs: readonly number[]): number | undefined {
  const target = STRATEGY_FORECAST_TARGET_MS[h] ?? STRATEGY_FORECAST_TARGET_MS.short;
  let best: number | undefined;
  for (const x of horizonsMs) {
    if (!(x > 0)) continue;
    if (best === undefined || Math.abs(Math.log(x / target)) < Math.abs(Math.log(best / target))) best = x;
  }
  return best;
}

// ───────────────────────── 特徴量 (純粋関数・確定足のみ) ─────────────────────────

/** now の時点で確定している足だけ (ts + 時間足 ≤ now)。末尾だけ確認する (昇順前提) */
export function closedOnly(c: readonly Candle[] | undefined, tf: Timeframe, now: number): Candle[] {
  if (!c || c.length === 0) return [];
  const ms = TIMEFRAME_MS[tf];
  let end = c.length;
  while (end > 0 && c[end - 1].ts + ms > now) end--;
  return end === c.length ? (c as Candle[]) : c.slice(0, end);
}

/**
 * 予想時間に合う時間足 (データが minBars 本以上あるものから選ぶ)。
 * 主時間足 = 予想時間の 1/3 以下で最も長いもの (無ければ最も短いもの)。15 分以下の予想は 1 つ下の時間足も使う。
 * 例: 15 分後 → 5m (と 1m)、1 時間後 → 15m、4 時間後 → 1h。無い時間足は近いものを使う。
 */
export function forecastTimeframes(horizonMs: number, available: readonly Timeframe[]): Timeframe[] {
  const tfs = [...new Set(available)].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
  if (tfs.length === 0) return [];
  const target = horizonMs / 3;
  let pi = -1;
  for (let i = 0; i < tfs.length; i++) if (TIMEFRAME_MS[tfs[i]] <= target) pi = i;
  if (pi < 0) pi = 0;
  const out = [tfs[pi]];
  if (horizonMs <= 15 * 60_000 && pi > 0) out.push(tfs[pi - 1]);
  return out;
}

/** トレンド: EMA(9) の傾きと EMA(9)−EMA(21) の並び (ATR 単位) → tanh */
export function trendFeature(c: readonly Candle[]): number | undefined {
  if (c.length < 30) return undefined;
  const closes = c.map((x) => x.close);
  const f = ema(closes, 9);
  const s = ema(closes, 21);
  const a = atrLast(c, 14);
  const n = closes.length - 1;
  if (!(a > 0) || !finite(f[n]) || !finite(f[n - 3]) || !finite(s[n])) return undefined;
  const slope = (f[n] - f[n - 3]) / (3 * a);
  const gap = (f[n] - s[n]) / a;
  return Math.tanh(2 * slope + 0.5 * gap);
}

/** モメンタム: 直近 k 本の変化率 ÷ (ATR × √k) → tanh */
export function momentumFeature(c: readonly Candle[], k: number): number | undefined {
  const kk = Math.max(1, Math.floor(k));
  if (c.length < Math.max(16, kk + 1)) return undefined;
  const a = atrLast(c, 14);
  if (!(a > 0)) return undefined;
  const n = c.length - 1;
  return Math.tanh((c[n].close - c[n - kk].close) / (a * Math.sqrt(kk)));
}

/** 平均回帰: ボリンジャー (20, 2σ) と VWAP (20) からの乖離。上に離れているほどマイナス */
export function meanRevertFeature(c: readonly Candle[]): number | undefined {
  if (c.length < 20) return undefined;
  const closes = c.map((x) => x.close);
  const last = closes[closes.length - 1];
  const m = smaLast(closes, 20);
  const sd = stdevLast(closes, 20);
  const vw = vwapLast(c, 20);
  const a = atrLast(c, 14);
  const z = sd > 0 && finite(m) ? (last - m) / (2 * sd) : 0;
  const dv = a > 0 && finite(vw) ? (last - vw) / a : 0;
  return -Math.tanh(0.5 * (z + 0.5 * dv));
}

/** 1 分あたりの ATR 比 (確定足が 15 本以上ある最も短い時間足の ATR を √時間 で換算)。newsCheck と同じ考え方 */
export function atrPctPerMinute(candles: Partial<Record<Timeframe, readonly Candle[]>>, mid: number, now: number): number | undefined {
  if (!(mid > 0)) return undefined;
  const tfs = (Object.keys(candles) as Timeframe[]).filter((tf) => TIMEFRAME_MS[tf] !== undefined).sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
  for (const tf of tfs) {
    const c = closedOnly(candles[tf], tf, now);
    if (c.length < 15) continue;
    const a = atrLast(c, 14);
    if (finite(a) && a > 0) return a / mid / Math.sqrt(Math.max(1, TIMEFRAME_MS[tf] / 60_000));
  }
  return undefined;
}

export interface FeatureInput {
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
  now: number;
  mid: number;
  horizonMs: number;
  /** ブリーフのバイアス sentiment × confidence (−1〜1) */
  news?: number;
  /** 直近の戦略シグナルの合意 (−1〜1) */
  consensus?: number;
  minBars?: number;
}

export interface FeatureResult {
  features: ForecastFeatures;
  /** 主時間足 */
  timeframe: Timeframe;
  /** 予想期間の想定変動幅 (比率。0.004 = ±0.4%) */
  rangePct: number;
}

/** 予想時間ごとの特徴量 (確定足だけを使う)。足が足りなければ undefined */
export function computeForecastFeatures(input: FeatureInput): FeatureResult | undefined {
  const { now, mid, horizonMs } = input;
  if (!(mid > 0) || !(horizonMs > 0)) return undefined;
  const minBars = input.minBars ?? DEFAULT_FORECAST_OPTIONS.minBars;
  const closed = new Map<Timeframe, Candle[]>();
  for (const tf of Object.keys(input.candles) as Timeframe[]) {
    if (TIMEFRAME_MS[tf] === undefined) continue;
    const c = closedOnly(input.candles[tf], tf, now);
    if (c.length >= minBars) closed.set(tf, c);
  }
  const tfs = forecastTimeframes(horizonMs, [...closed.keys()]);
  if (tfs.length === 0) return undefined;
  const primary = tfs[0];
  const pc = closed.get(primary)!;
  const a = atrLast(pc, 14);
  if (!(a > 0)) return undefined;
  // トレンドは主時間足 0.6 + 1 つ下 0.4 (1 つだけなら主時間足のみ)
  let trend = 0;
  let wsum = 0;
  tfs.forEach((tf, i) => {
    const t = trendFeature(closed.get(tf)!);
    if (t === undefined) return;
    const w = i === 0 ? 0.6 : 0.4;
    trend += w * t;
    wsum += w;
  });
  const k = clamp(Math.round(horizonMs / TIMEFRAME_MS[primary]), 3, 12);
  const features: ForecastFeatures = {
    trend: wsum > 0 ? clamp(trend / wsum, -1, 1) : 0,
    momentum: clamp(momentumFeature(pc, k) ?? 0, -1, 1),
    meanRevert: clamp(meanRevertFeature(pc) ?? 0, -1, 1),
    news: clamp(input.news ?? 0, -1, 1),
    consensus: clamp(input.consensus ?? 0, -1, 1),
  };
  const rangePct = (a / mid) * Math.sqrt(Math.max(1, horizonMs / TIMEFRAME_MS[primary]));
  return { features, timeframe: primary, rangePct };
}

// ───────────────────────── 集計 ─────────────────────────

export const CAL_BINS = 10;

/** 集計の 1 グループ分 */
export interface ForecastCounts {
  /** 方向の予想 × 方向の結果 (的中率の分母) */
  n: number;
  hits: number;
  /** flat の予想 (期限切れ以外) */
  flatPred: number;
  /** flat の予想で結果も flat */
  flatHits: number;
  /** 結果がノイズの範囲内 (flat) */
  noise: number;
  /** 価格が取れず判定できなかった */
  expired: number;
  /** Brier スコアの合計と件数 (方向の結果が出たもの) */
  brierSum: number;
  brierN: number;
  /** 較正 (pUp の 0.1 刻み): 件数・上昇数・pUp の合計 (資産クラスのグループだけ持つ) */
  calN?: number[];
  calUp?: number[];
  calP?: number[];
}

const emptyCounts = (cal: boolean): ForecastCounts => ({
  n: 0, hits: 0, flatPred: 0, flatHits: 0, noise: 0, expired: 0, brierSum: 0, brierN: 0,
  ...(cal ? { calN: new Array(CAL_BINS).fill(0), calUp: new Array(CAL_BINS).fill(0), calP: new Array(CAL_BINS).fill(0) } : {}),
});

function addCounts(into: ForecastCounts, x: ForecastCounts): void {
  into.n += x.n ?? 0;
  into.hits += x.hits ?? 0;
  into.flatPred += x.flatPred ?? 0;
  into.flatHits += x.flatHits ?? 0;
  into.noise += x.noise ?? 0;
  into.expired += x.expired ?? 0;
  into.brierSum += x.brierSum ?? 0;
  into.brierN += x.brierN ?? 0;
  if (into.calN && x.calN) {
    for (let i = 0; i < CAL_BINS; i++) {
      into.calN[i] += x.calN[i] ?? 0;
      into.calUp![i] += x.calUp?.[i] ?? 0;
      into.calP![i] += x.calP?.[i] ?? 0;
    }
  }
}

export const calBin = (p: number) => Math.min(CAL_BINS - 1, Math.max(0, Math.floor(clamp(p, 0, 1) * CAL_BINS)));

/** 1 件の結果を集計に加える (純粋関数ではなく counts を更新する) */
export function recordOutcome(c: ForecastCounts, pred: ForecastDirection, pUp: number, outcome: ForecastDirection | "expired"): void {
  if (outcome === "expired") {
    c.expired++;
    return;
  }
  if (pred === "flat") {
    c.flatPred++;
    if (outcome === "flat") c.flatHits++;
  }
  if (outcome === "flat") {
    c.noise++;
    return;
  }
  const y = outcome === "up" ? 1 : 0;
  c.brierSum += (pUp - y) ** 2;
  c.brierN++;
  if (c.calN) {
    const b = calBin(pUp);
    c.calN[b]++;
    c.calUp![b] += y;
    c.calP![b] += pUp;
  }
  if (pred !== "flat") {
    c.n++;
    if (pred === outcome) c.hits++;
  }
}

export interface ForecastStatsState {
  /** 日 (UTC 0 時のミリ秒) → グループのキー → 件数 */
  days: Record<string, Record<string, ForecastCounts>>;
  recorded: number;
  droppedCap: number;
  droppedUnwatched: number;
  learned: number;
  lastAuditAt?: number;
  /** 前回の要約以降の件数 */
  sinceAudit: { judged: number; hits: number; n: number; noise: number; expired: number };
  /** 取引に反映中の (予想時間|資産クラス) */
  live: string[];
}

const emptyStats = (): ForecastStatsState => ({
  days: {}, recorded: 0, droppedCap: 0, droppedUnwatched: 0, learned: 0, sinceAudit: { judged: 0, hits: 0, n: 0, noise: 0, expired: 0 }, live: [],
});

const DAY = 86_400_000;
export const classKey = (label: string, assetClass: string) => `c|${label}|${assetClass}`;
export const symbolKey = (label: string, symbol: string) => `s|${label}|${symbol}`;
export const modelKey = (label: string, assetClass: string) => `${label}|${assetClass}`;

export const forecastPendingKey = (mode: TradingMode) => `forecast:pending:${mode}`;
export const forecastModelKey = (mode: TradingMode) => `forecast:model:${mode}`;
export const forecastStatsKey = (mode: TradingMode) => `forecast:stats:${mode}`;

/** 未判定の予想 (kv に保存するので短い形) */
export interface PendingForecast {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  horizonMs: number;
  madeAt: number;
  mid0: number;
  pUp: number;
  dir: ForecastDirection;
  /** 特徴量 (FORECAST_FEATURES の順) */
  f: number[];
  atrPctPerMin: number;
  costPct: number;
}

export interface ForecastHorizonView {
  horizon: string;
  horizonMs: number;
  direction: ForecastDirection;
  pUp: number;
  /** 想定変動幅 (比率) */
  rangePct: number;
  timeframe: Timeframe;
  features: ForecastFeatures;
  /** 根拠の内訳: w_i × f_i とバイアス */
  contributions: ForecastFeatures & { bias: number };
}

export interface SymbolForecast {
  symbol: string;
  assetClass: AssetClass;
  madeAt: number;
  mid: number;
  horizons: ForecastHorizonView[];
}

/** /api/status の watched[].forecast */
export interface ForecastStatusView {
  madeAt: number;
  /** どれかの予想時間が取引に反映中 */
  live: boolean;
  horizons: {
    horizon: string;
    direction: ForecastDirection;
    pUp: number;
    rangePct: number;
    /** (予想時間, 資産クラス) の的中率と件数 (直近 retentionMs) */
    hitRate: number;
    n: number;
    live: boolean;
    /** 根拠の内訳 (w_i × f_i、bias) */
    contributions: Record<string, number>;
  }[];
  /** 予想時間をまとめた的中率と件数 */
  accuracy: { n: number; hits: number; hitRate: number; minSamples: number };
}

export interface ForecastGroupSummary {
  key: string;
  horizon: string;
  assetClass?: string;
  symbol?: string;
  n: number;
  hits: number;
  hitRate: number;
  flatPred: number;
  flatHits: number;
  noise: number;
  expired: number;
  /** Brier スコア (方向の結果が出たもの。0.25 = 常に 0.5 と同等) */
  brier: number;
  brierN: number;
  /** 重複を補正した z (片側検定の統計量) */
  z: number;
  /** 補正前の z */
  zRaw: number;
  /** 予想時間 ÷ 予想の間隔 */
  overlap: number;
  live: boolean;
}

export interface ForecastCalibrationBin {
  lo: number;
  hi: number;
  n: number;
  up: number;
  /** 実際の上昇率 */
  upRate: number;
  /** pUp の平均 */
  meanP: number;
}

export interface ForecastSummary {
  mode: TradingMode;
  generatedAt: number;
  windowMs: number;
  horizons: string[];
  pending: number;
  recorded: number;
  learned: number;
  droppedCap: number;
  droppedUnwatched: number;
  /** 予想時間 × 資産クラス (取引への反映の単位) */
  byClass: ForecastGroupSummary[];
  /** 予想時間ごと (資産クラスの合計) */
  byHorizon: ForecastGroupSummary[];
  /** 予想時間 × 銘柄 */
  bySymbol: ForecastGroupSummary[];
  /** 予想時間ごとの較正 */
  calibration: { horizon: string; bins: ForecastCalibrationBin[] }[];
  /** 学習した重み ((予想時間, 資産クラス) ごと) */
  models: { key: string; horizon: string; assetClass: string; weights: ForecastFeatures; bias: number; updates: number }[];
  options: Pick<ForecastOptions, "minSamples" | "zCritical" | "flatThreshold" | "noiseAtrMult" | "maxBoost" | "maxCut" | "intervalMs">;
}

function groupSummary(key: string, c: ForecastCounts, o: Pick<ForecastOptions, "minSamples" | "zCritical">, overlapOf: (label: string) => number, live?: boolean): ForecastGroupSummary {
  const [kind, horizon, ...rest] = key.split("|");
  const name = rest.join("|");
  const overlap = overlapOf(horizon);
  const zRaw = hitRateZ(c.n, c.hits);
  return {
    key,
    horizon,
    ...(kind === "c" ? { assetClass: name } : kind === "s" ? { symbol: name } : {}),
    n: c.n, hits: c.hits, hitRate: c.n ? c.hits / c.n : 0,
    flatPred: c.flatPred, flatHits: c.flatHits, noise: c.noise, expired: c.expired,
    brier: c.brierN ? c.brierSum / c.brierN : 0, brierN: c.brierN,
    z: round(zRaw / Math.sqrt(overlap), 3),
    zRaw: round(zRaw, 3),
    overlap: round(overlap, 2),
    live: live ?? skillConfirmed(c.n, c.hits, o, overlap),
  };
}

function calibrationBins(c: ForecastCounts): ForecastCalibrationBin[] {
  return Array.from({ length: CAL_BINS }, (_, i) => {
    const n = c.calN?.[i] ?? 0;
    const up = c.calUp?.[i] ?? 0;
    return { lo: i / CAL_BINS, hi: (i + 1) / CAL_BINS, n, up, upRate: n ? up / n : 0, meanP: n ? (c.calP?.[i] ?? 0) / n : 0 };
  });
}

// ───────────────────────── 追跡 (状態あり) ─────────────────────────

export interface ForecastInput {
  instrument: { symbol: string; assetClass: AssetClass };
  candles: Partial<Record<Timeframe, readonly Candle[]>>;
  now: number;
  mid: number;
  /** 往復コスト比 (手数料 × 2 + スプレッド / 仲値) */
  costPct?: number;
  news?: number;
  /** 予想時間 → 戦略の合意 (−1〜1) */
  consensus?: (horizonMs: number) => number;
}

export interface ForecastEvalDeps {
  isWatched: (symbol: string) => boolean;
  midNow: (symbol: string) => number | undefined;
  priceAt?: PriceAt;
}

export interface ForecastEvalResult {
  judged: number;
  hits: number;
  noise: number;
  expired: number;
  learned: number;
}

export interface ForecastTrackerDeps {
  store: Store;
  mode: TradingMode;
  options?: Partial<ForecastOptions>;
  /** 読むだけ (kv・表に書かない。レポート用) */
  readOnly?: boolean;
}

export class ForecastTracker {
  readonly opts: ForecastOptions;
  readonly mode: TradingMode;
  private readonly store: Store;
  private readonly readOnly: boolean;
  private pending: PendingForecast[];
  private models: Record<string, ForecastModel>;
  private stats: ForecastStatsState;
  private readonly latestBySymbol = new Map<string, SymbolForecast>();
  private aggCache?: { at: number; map: Map<string, ForecastCounts> };
  private dirtyPending = false;
  private dirtyModel = false;
  private dirtyStats = false;
  private lastPruneAt?: number;

  constructor(deps: ForecastTrackerDeps) {
    this.store = deps.store;
    this.mode = deps.mode;
    this.readOnly = deps.readOnly ?? false;
    const o = { ...DEFAULT_FORECAST_OPTIONS, ...(deps.options ?? {}) };
    if (deps.options?.maxForecastAgeMs === undefined) o.maxForecastAgeMs = 2 * o.intervalMs;
    this.opts = o;
    const p = deps.store.kvGet<PendingForecast[]>(forecastPendingKey(deps.mode));
    this.pending = Array.isArray(p) ? p.filter((x) => x && finite(x.madeAt) && finite(x.horizonMs) && finite(x.mid0) && Array.isArray(x.f)) : [];
    const m = deps.store.kvGet<Record<string, ForecastModel>>(forecastModelKey(deps.mode));
    this.models = m && typeof m === "object" ? m : {};
    const s = deps.store.kvGet<Partial<ForecastStatsState>>(forecastStatsKey(deps.mode));
    this.stats = { ...emptyStats(), ...(s ?? {}) };
    this.stats.sinceAudit = { ...emptyStats().sinceAudit, ...(this.stats.sinceAudit ?? {}) };
    if (!Array.isArray(this.stats.live)) this.stats.live = [];
  }

  get horizonLabels(): string[] {
    return this.opts.horizonsMs.map(horizonLabel);
  }

  /** 予想時間のラベル → 重複の度合い (設定に無いラベルは 1) */
  private overlapOf = (label: string): number => {
    const h = this.opts.horizonsMs.find((x) => horizonLabel(x) === label);
    return h === undefined ? 1 : forecastOverlap(h, this.opts.intervalMs);
  };

  /** 未判定の予想 (複製) */
  listPending(): PendingForecast[] {
    return this.pending.map((p) => ({ ...p, f: [...p.f] }));
  }

  /** (予想時間, 資産クラス) の重み (無ければ初期値) */
  model(horizonMs: number, assetClass: string): ForecastModel {
    const k = modelKey(horizonLabel(horizonMs), assetClass);
    const m = this.models[k];
    if (m && m.w) return { w: { ...initialModel(this.opts.initialWeight).w, ...m.w }, b: finite(m.b) ? m.b : 0, updates: m.updates ?? 0, ...(m.updatedAt ? { updatedAt: m.updatedAt } : {}) };
    return initialModel(this.opts.initialWeight);
  }

  /** 最新の予想 (無ければ undefined) */
  latest(symbol: string): SymbolForecast | undefined {
    return this.latestBySymbol.get(symbol);
  }

  /**
   * 1 銘柄の予想を出し、時間ごとに未判定として記録する。足が足りない時間は飛ばす。
   * 何も出せなければ undefined
   */
  forecast(input: ForecastInput): SymbolForecast | undefined {
    const { instrument: inst, now, mid } = input;
    if (!(mid > 0)) return undefined;
    const atrMin = atrPctPerMinute(input.candles, mid, now) ?? 0;
    const horizons: ForecastHorizonView[] = [];
    for (const h of this.opts.horizonsMs) {
      let consensus = 0;
      try {
        consensus = input.consensus?.(h) ?? 0;
      } catch {
        consensus = 0;
      }
      const fr = computeForecastFeatures({ candles: input.candles, now, mid, horizonMs: h, news: input.news, consensus, minBars: this.opts.minBars });
      if (!fr) continue;
      const m = this.model(h, inst.assetClass);
      const pUp = predictUp(m, fr.features);
      const direction = classifyForecast(pUp, this.opts.flatThreshold);
      const contributions = { ...(Object.fromEntries(FORECAST_FEATURES.map((k) => [k, round(m.w[k] * fr.features[k])])) as ForecastFeatures), bias: round(m.b) };
      horizons.push({ horizon: horizonLabel(h), horizonMs: h, direction, pUp, rangePct: fr.rangePct, timeframe: fr.timeframe, features: fr.features, contributions });
      this.pending.push({
        id: `fc_${now.toString(36)}_${randomUUID().slice(0, 8)}`,
        symbol: inst.symbol,
        assetClass: inst.assetClass,
        horizonMs: h,
        madeAt: now,
        mid0: mid,
        pUp: round(pUp, 6),
        dir: direction,
        f: featureArray(fr.features),
        atrPctPerMin: atrMin,
        costPct: finite(input.costPct) && input.costPct > 0 ? input.costPct : 0,
      });
      this.stats.recorded++;
      this.dirtyPending = true;
      this.dirtyStats = true;
    }
    if (horizons.length === 0) return undefined;
    if (this.pending.length > this.opts.maxPending) {
      this.pending.sort((a, b) => a.madeAt - b.madeAt);
      const drop = this.pending.length - this.opts.maxPending;
      this.pending.splice(0, drop);
      this.stats.droppedCap += drop;
    }
    const sf: SymbolForecast = { symbol: inst.symbol, assetClass: inst.assetClass, madeAt: now, mid, horizons };
    this.latestBySymbol.set(inst.symbol, sf);
    return sf;
  }

  /** 監視をやめた銘柄の最新の予想を消す */
  forget(isWatched: (symbol: string) => boolean): void {
    for (const s of [...this.latestBySymbol.keys()]) if (!isWatched(s)) this.latestBySymbol.delete(s);
  }

  /** 期限が来た予想をまとめて判定し、学習する */
  evaluate(now: number, deps: ForecastEvalDeps): ForecastEvalResult {
    const res: ForecastEvalResult = { judged: 0, hits: 0, noise: 0, expired: 0, learned: 0 };
    this.forget(deps.isWatched);
    if (this.pending.length === 0) {
      this.maybePrune(now);
      this.maybeAudit(now);
      return res;
    }
    const keep: PendingForecast[] = [];
    const records: ForecastOutcomeRecord[] = [];
    const dayKey = String(Math.floor(now / DAY) * DAY);
    const day = (this.stats.days[dayKey] ??= {});
    for (const p of this.pending) {
      if (!deps.isWatched(p.symbol)) {
        this.stats.droppedUnwatched++;
        this.dirtyPending = true;
        this.dirtyStats = true;
        continue;
      }
      const due = p.madeAt + p.horizonMs;
      if (now < due) {
        keep.push(p);
        continue;
      }
      this.dirtyPending = true;
      this.dirtyStats = true;
      let px = deps.priceAt?.(p.symbol, due);
      if (!(finite(px) && px > 0)) px = now - due <= this.opts.lateToleranceMs ? deps.midNow(p.symbol) : undefined;
      const label = horizonLabel(p.horizonMs);
      const cc = (day[classKey(label, p.assetClass)] ??= emptyCounts(true));
      const sc = (day[symbolKey(label, p.symbol)] ??= emptyCounts(false));
      let outcome: ForecastDirection | "expired";
      let change: number | undefined;
      let noise: number | undefined;
      if (!(finite(px) && px > 0) || !(p.mid0 > 0)) {
        outcome = "expired";
        res.expired++;
      } else {
        change = (px - p.mid0) / p.mid0;
        noise = noiseThreshold({ atrPctPerMin: p.atrPctPerMin, costPct: p.costPct }, p.horizonMs, this.opts.noiseAtrMult);
        outcome = Math.abs(change) < noise ? "flat" : change > 0 ? "up" : "down";
      }
      recordOutcome(cc, p.dir, p.pUp, outcome);
      recordOutcome(sc, p.dir, p.pUp, outcome);
      const hit = p.dir !== "flat" && (outcome === "up" || outcome === "down") ? p.dir === outcome : undefined;
      if (outcome !== "expired") res.judged++;
      if (outcome === "flat") res.noise++;
      if (hit) res.hits++;
      if (hit !== undefined) this.stats.sinceAudit.n++;
      if (hit) this.stats.sinceAudit.hits++;
      if (outcome === "up" || outcome === "down") {
        const k = modelKey(label, p.assetClass);
        this.models[k] = sgdUpdate(this.model(p.horizonMs, p.assetClass), featureObject(p.f), outcome === "up" ? 1 : 0, this.opts, now);
        this.dirtyModel = true;
        this.stats.learned++;
        res.learned++;
      }
      records.push({
        id: p.id, mode: this.mode, symbol: p.symbol, assetClass: p.assetClass, horizonMs: p.horizonMs,
        madeAt: p.madeAt, dueAt: due, judgedAt: now, pUp: p.pUp, direction: p.dir, outcome,
        ...(change !== undefined ? { changePct: round(change, 6) } : {}),
        ...(noise !== undefined ? { noisePct: round(noise, 6) } : {}),
        ...(hit !== undefined ? { hit } : {}),
        features: p.f,
      });
    }
    this.pending = keep;
    this.stats.sinceAudit.judged += res.judged;
    this.stats.sinceAudit.noise += res.noise;
    this.stats.sinceAudit.expired += res.expired;
    if (records.length > 0) this.aggCache = undefined;
    if (!this.readOnly && records.length > 0) this.store.saveForecastOutcomes(records);
    this.maybePrune(now);
    this.auditLive(now);
    this.maybeAudit(now);
    return res;
  }

  /** 古い日の集計と判定済みの記録を消す (1 日 1 回) */
  private maybePrune(now: number): void {
    if (this.lastPruneAt !== undefined && now - this.lastPruneAt < DAY) return;
    this.lastPruneAt = now;
    const cutoff = now - this.opts.retentionMs;
    for (const d of Object.keys(this.stats.days)) {
      if (Number(d) + DAY <= cutoff) {
        delete this.stats.days[d];
        this.dirtyStats = true;
        this.aggCache = undefined;
      }
    }
    if (!this.readOnly) this.store.pruneForecastOutcomes(cutoff);
  }

  /** 直近 retentionMs の集計 (日のバケツの合計) */
  private aggregate(now: number): Map<string, ForecastCounts> {
    if (this.aggCache && Math.floor(this.aggCache.at / DAY) === Math.floor(now / DAY)) return this.aggCache.map;
    const cutoff = now - this.opts.retentionMs;
    const map = new Map<string, ForecastCounts>();
    for (const [d, groups] of Object.entries(this.stats.days)) {
      if (Number(d) + DAY <= cutoff) continue;
      for (const [k, c] of Object.entries(groups)) {
        let t = map.get(k);
        if (!t) map.set(k, (t = emptyCounts(k.startsWith("c|"))));
        addCounts(t, c);
      }
    }
    this.aggCache = { at: now, map };
    return map;
  }

  /** (予想時間, 資産クラス) の実力 */
  skill(horizonMs: number, assetClass: string, now: number): { n: number; hits: number; hitRate: number; z: number; live: boolean } {
    const c = this.aggregate(now).get(classKey(horizonLabel(horizonMs), assetClass));
    const n = c?.n ?? 0;
    const hits = c?.hits ?? 0;
    const overlap = forecastOverlap(horizonMs, this.opts.intervalMs);
    return { n, hits, hitRate: n ? hits / n : 0, z: hitRateZ(n, hits) / Math.sqrt(overlap), live: skillConfirmed(n, hits, this.opts, overlap) };
  }

  /**
   * 新規エントリーのサイズの倍率。LIVE でない・予想が無い/古い・flat なら mult = 1。
   * 使う予想時間は戦略の時間軸に合わせる (scalp → 15 分、short → 1 時間、mid / long → 4 時間)
   */
  multiplierFor(
    symbol: string,
    signal: "long" | "short",
    strategyHorizon: Horizon,
    now: number,
  ): { mult: number; horizon?: string; direction?: ForecastDirection; pUp?: number; live: boolean } {
    const h = horizonForStrategy(strategyHorizon, this.opts.horizonsMs);
    const sf = this.latestBySymbol.get(symbol);
    if (h === undefined || !sf || now - sf.madeAt > this.opts.maxForecastAgeMs || now < sf.madeAt) return { mult: 1, live: false };
    const hv = sf.horizons.find((x) => x.horizonMs === h);
    if (!hv) return { mult: 1, live: false };
    const live = this.skill(h, sf.assetClass, now).live;
    return { mult: forecastSizeMultiplier(signal, hv, live, this.opts), horizon: hv.horizon, direction: hv.direction, pUp: hv.pUp, live };
  }

  /** /api/status 用 */
  statusFor(symbol: string, now: number): ForecastStatusView | undefined {
    const sf = this.latestBySymbol.get(symbol);
    if (!sf) return undefined;
    let n = 0;
    let hits = 0;
    const horizons = sf.horizons.map((h) => {
      const sk = this.skill(h.horizonMs, sf.assetClass, now);
      n += sk.n;
      hits += sk.hits;
      return {
        horizon: h.horizon, direction: h.direction, pUp: round(h.pUp), rangePct: round(h.rangePct, 6),
        hitRate: round(sk.hitRate), n: sk.n, live: sk.live,
        contributions: h.contributions as Record<string, number>,
      };
    });
    return {
      madeAt: sf.madeAt,
      live: horizons.some((h) => h.live),
      horizons,
      accuracy: { n, hits, hitRate: n ? round(hits / n) : 0, minSamples: this.opts.minSamples },
    };
  }

  /** 反映状態が変わったものを監査ログへ */
  private auditLive(now: number): void {
    const agg = this.aggregate(now);
    const live: string[] = [];
    for (const [k, c] of agg) if (k.startsWith("c|") && skillConfirmed(c.n, c.hits, this.opts, this.overlapOf(k.split("|")[1]))) live.push(k.slice(2));
    live.sort();
    const prev = new Set(this.stats.live);
    const cur = new Set(live);
    const changed = [...live.filter((k) => !prev.has(k)).map((k) => [k, true] as const), ...[...prev].filter((k) => !cur.has(k)).map((k) => [k, false] as const)];
    if (changed.length === 0) return;
    this.stats.live = live;
    this.dirtyStats = true;
    if (this.readOnly) return;
    for (const [k, on] of changed) {
      const [h, cls] = k.split("|");
      const c = agg.get(`c|${k}`);
      this.store.audit({
        ts: now,
        type: "learning.forecast_live",
        data: { mode: this.mode, horizon: h, assetClass: cls, live: on, n: c?.n ?? 0, hitRate: c && c.n ? round(c.hits / c.n) : 0, z: round(hitRateZ(c?.n ?? 0, c?.hits ?? 0) / Math.sqrt(this.overlapOf(h)), 3) },
      });
    }
  }

  /** auditEveryMs ごとに要約を監査ログへ (毎件は残さない) */
  private maybeAudit(now: number): void {
    const s = this.stats.sinceAudit;
    if (this.stats.lastAuditAt === undefined) {
      this.stats.lastAuditAt = now;
      this.dirtyStats = true;
      return;
    }
    if (now - this.stats.lastAuditAt < this.opts.auditEveryMs || s.judged + s.expired === 0) return;
    if (!this.readOnly) {
      const agg = this.aggregate(now);
      const groups = [...agg]
        .filter(([k]) => k.startsWith("c|"))
        .map(([k, c]) => ({ key: k.slice(2), n: c.n, hitRate: c.n ? round(c.hits / c.n) : 0, brier: c.brierN ? round(c.brierSum / c.brierN) : 0, live: skillConfirmed(c.n, c.hits, this.opts, this.overlapOf(k.split("|")[1])) }));
      this.store.audit({
        ts: now,
        type: "learning.forecast_summary",
        data: { mode: this.mode, since: this.stats.lastAuditAt, judged: s.judged, n: s.n, hits: s.hits, noise: s.noise, expired: s.expired, pending: this.pending.length, groups },
      });
    }
    this.stats.lastAuditAt = now;
    this.stats.sinceAudit = { judged: 0, hits: 0, n: 0, noise: 0, expired: 0 };
    this.dirtyStats = true;
  }

  /** 変化があれば kv に保存する */
  flush(): void {
    if (this.readOnly) return;
    const write = () => {
      if (this.dirtyPending) this.store.kvSet(forecastPendingKey(this.mode), this.pending);
      if (this.dirtyModel) this.store.kvSet(forecastModelKey(this.mode), this.models);
      if (this.dirtyStats) this.store.kvSet(forecastStatsKey(this.mode), this.stats);
    };
    if (this.store.transaction) this.store.transaction(write);
    else write();
    this.dirtyPending = this.dirtyModel = this.dirtyStats = false;
  }

  /** ダッシュボード・レポート用の集計 (直近 retentionMs) */
  summary(now: number): ForecastSummary {
    const agg = this.aggregate(now);
    const o = this.opts;
    const labels = this.horizonLabels;
    const order = (h: string) => {
      const i = labels.indexOf(h);
      return i < 0 ? labels.length : i;
    };
    const byClass: ForecastGroupSummary[] = [];
    const bySymbol: ForecastGroupSummary[] = [];
    const horizonTotals = new Map<string, ForecastCounts>();
    for (const [k, c] of agg) {
      if (k.startsWith("c|")) {
        const g = groupSummary(k, c, o, this.overlapOf);
        byClass.push(g);
        let t = horizonTotals.get(g.horizon);
        if (!t) horizonTotals.set(g.horizon, (t = emptyCounts(true)));
        addCounts(t, c);
      } else if (k.startsWith("s|")) bySymbol.push(groupSummary(k, c, o, this.overlapOf));
    }
    const sortG = (a: ForecastGroupSummary, b: ForecastGroupSummary) =>
      order(a.horizon) - order(b.horizon) || (a.assetClass ?? a.symbol ?? "").localeCompare(b.assetClass ?? b.symbol ?? "");
    byClass.sort(sortG);
    bySymbol.sort(sortG);
    const hs = [...new Set([...labels, ...horizonTotals.keys()])].sort((a, b) => order(a) - order(b));
    const byHorizon = hs.map((h) => groupSummary(`h|${h}|`, horizonTotals.get(h) ?? emptyCounts(true), o, this.overlapOf, byClass.some((g) => g.horizon === h && g.live)));
    for (const g of byHorizon) delete g.assetClass;
    const calibration = hs.map((h) => ({ horizon: h, bins: calibrationBins(horizonTotals.get(h) ?? emptyCounts(true)) }));
    const models = Object.entries(this.models)
      .map(([key, m]) => {
        const [horizon, assetClass] = key.split("|");
        const w = { ...initialModel(o.initialWeight).w, ...(m?.w ?? {}) };
        return { key, horizon, assetClass, weights: Object.fromEntries(FORECAST_FEATURES.map((k) => [k, round(w[k])])) as ForecastFeatures, bias: round(m?.b ?? 0), updates: m?.updates ?? 0 };
      })
      .sort((a, b) => order(a.horizon) - order(b.horizon) || a.assetClass.localeCompare(b.assetClass));
    return {
      mode: this.mode,
      generatedAt: now,
      windowMs: o.retentionMs,
      horizons: labels,
      pending: this.pending.length,
      recorded: this.stats.recorded,
      learned: this.stats.learned,
      droppedCap: this.stats.droppedCap,
      droppedUnwatched: this.stats.droppedUnwatched,
      byClass,
      byHorizon,
      bySymbol,
      calibration,
      models,
      options: { minSamples: o.minSamples, zCritical: o.zCritical, flatThreshold: o.flatThreshold, noiseAtrMult: o.noiseAtrMult, maxBoost: o.maxBoost, maxCut: o.maxCut, intervalMs: o.intervalMs },
    };
  }
}

/** 保存済みの kv から集計を読む (エンジンが動いていないレポート用)。mode を省くと記録の多い方 */
export function loadForecastSummary(store: Store, now: number, mode?: TradingMode, options?: Partial<ForecastOptions>): ForecastSummary {
  let m = mode;
  if (!m) {
    const rec = (x: TradingMode) => store.kvGet<Partial<ForecastStatsState>>(forecastStatsKey(x))?.recorded ?? 0;
    m = rec("live") > rec("paper") ? "live" : "paper";
  }
  return new ForecastTracker({ store, mode: m, readOnly: true, ...(options ? { options } : {}) }).summary(now);
}
