/**
 * 転換で決済 (REVERSAL_EXIT)。純粋なモジュール (足・時刻は引数で渡す。I/O・乱数なし)。
 *
 * 建玉を持った後の値動きをダウ理論で見る (建玉に対する相対的な判定。全戦略に掛ける)。
 *   - 買い: エントリーした足以降にできたスイングロー (エントリー後の安値の切り上げ = 押し安値) のうち、
 *     確定している最も新しいものを「守るべき水準」にする。確定足の終値がその水準を
 *     REVERSAL_EXIT_BUFFER_ATR × ATR(14) より大きく下回ったら (既定 0 = 終値が下回れば十分)、エントリーからの上昇が崩れた
 *     (押し安値割れ) とみなして決済する。
 *   - 売り: 逆。エントリー後のスイングハイ (戻り高値) を、確定足の終値が上回ったら決済する (戻り高値超え)。
 *   - 含み益でも含み損でも同じ (利確・損切りの手前で、トレンドがはっきり転換したら決済する)。
 *   - エントリー後にまだスイングが確定していなければ判定しない (当初の損切りが守る)。REVERSAL_EXIT_FALLBACK=true (既定 false) のときだけ、
 *     エントリーした足の安値 (買い) / 高値 (売り) を水準にする (フォールバック。監査ログに fallback: true。早く発火しすぎるので既定は無効)。
 *     エントリーした足より前のスイングは使わない (エントリーした足そのもののスイングは使う)。
 *   - 時間足は REVERSAL_EXIT_TF: lower (既定) = 戦略の主時間足の 1 つ下 (1m→1m, 5m→1m, 15m→5m, 1h→15m, 4h→1h, 1d→4h)、
 *     same = 戦略の主時間足。
 *   - ヒゲ (安値・高値) だけが水準を越えても決済しない (終値で判定する)。
 * スイングは src/structure/pivots.ts の detectPivots (左右 N 本。左は厳密・右は >= で横ばい対応) と同じ規則で、
 * N 本後の足が確定してから使う (confirmedAt ≤ 最後の確定足。リペイントしない)。N は REVERSAL_EXIT_PIVOT_N (既定 3。
 * 新規エントリーのフィルターの STRUCTURE_PIVOT_N とは別)。
 * 足は確定足だけ (昇順) を渡す。最後の足が「いま確定した足」で、その終値で判定する (先読みなし)。
 * ATR は最後の REVERSAL_ATR_WINDOW 本だけから求める (渡す足の本数によらず同じ値にするため。運用とバックテストで一致させる)。
 * 価格は統計値なので number で計算する (会計値ではない)。
 */
import type { Env } from "../core/config";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "../core/types";
import { atrLast } from "../indicators/series";
import { confirmedPivots, detectPivots, normalizePivotN } from "../structure/pivots";
import { strategyIdListWarnings } from "../strategies/retired";

export interface ReversalSettings {
  /** 転換で決済を使うか (REVERSAL_EXIT。false なら従来と同一) */
  enabled: boolean;
  /** スイングの左右の本数 (REVERSAL_EXIT_PIVOT_N。2〜10) */
  pivotN: number;
  /** 終値が水準をこの ATR(14) 倍より大きく越えたら決済 (REVERSAL_EXIT_BUFFER_ATR。0〜1。0 = 越えれば十分) */
  bufferAtr: number;
  /** 対象の戦略 id (REVERSAL_EXIT_STRATEGIES)。空ならすべての戦略 */
  strategies: readonly string[];
  /**
   * 判定に使う時間足 (REVERSAL_EXIT_TF)。lower (既定) = 戦略の主時間足の 1 つ下 (reversalLowerTimeframe)、
   * same = 戦略の主時間足 (従来どおり)
   */
  timeframe: ReversalTfMode;
  /**
   * エントリー後に確定したスイングが無いとき、エントリーした足の安値 (買い) / 高値 (売り) を水準にする (REVERSAL_EXIT_FALLBACK。既定 false)。
   * 既定で無効なのは早く発火しすぎるため (simulate でほとんどの取引をエントリー付近で閉じ、勝率は 5% 前後だった)
   */
  fallback: boolean;
}

/** 転換で決済の時間足のモード (REVERSAL_EXIT_TF) */
export type ReversalTfMode = "lower" | "same";

export const DEFAULT_REVERSAL_SETTINGS: Readonly<ReversalSettings> = { enabled: true, pivotN: 3, bufferAtr: 0, strategies: [], timeframe: "lower", fallback: false };

/**
 * 主時間足の 1 つ下の時間足 (REVERSAL_EXIT_TF=lower で使う)。
 * 1m→1m, 5m→1m, 15m→5m, 1h→15m, 4h→1h, 1d→4h (1s→1s, 1w→1d)
 */
const LOWER_TF: Record<Timeframe, Timeframe> = {
  "1s": "1s", "1m": "1m", "5m": "1m", "15m": "5m", "1h": "15m", "4h": "1h", "1d": "4h", "1w": "1d",
};
export function reversalLowerTimeframe(primary: Timeframe): Timeframe {
  return LOWER_TF[primary] ?? primary;
}

/** 転換で決済に使う時間足 (設定が無い・same なら主時間足、lower なら 1 つ下) */
export function reversalTimeframeFor(s: Pick<ReversalSettings, "timeframe"> | undefined, primary: Timeframe): Timeframe {
  return s?.timeframe === "same" ? primary : reversalLowerTimeframe(primary);
}

/**
 * バックテスト用: 基準足 baseTf から作れる時間足か (基準足の整数倍)。作れなければ主時間足に戻す (same 扱い)
 */
export function reversalBacktestTimeframe(s: Pick<ReversalSettings, "timeframe"> | undefined, primary: Timeframe, baseTf: Timeframe): Timeframe {
  const tf = reversalTimeframeFor(s, primary);
  const ms = TIMEFRAME_MS[tf];
  const baseMs = TIMEFRAME_MS[baseTf];
  return ms >= baseMs && ms % baseMs === 0 ? tf : primary;
}

/** ATR の期間と、ATR を求める足の本数 (最後の何本か) */
export const REVERSAL_ATR_PERIOD = 14;
export const REVERSAL_ATR_WINDOW = 100;

/** 決済理由の表示名と、方向別の中身 (買い: 押し安値割れ / 売り: 戻り高値超え) */
export const REVERSAL_EXIT_LABEL = "転換で決済";
export const reversalDetailLabel = (direction: "long" | "short"): string => (direction === "long" ? "押し安値割れ" : "戻り高値超え");

type ReversalEnv = Partial<Pick<Env, "REVERSAL_EXIT" | "REVERSAL_EXIT_PIVOT_N" | "REVERSAL_EXIT_BUFFER_ATR" | "REVERSAL_EXIT_STRATEGIES" | "REVERSAL_EXIT_TF" | "REVERSAL_EXIT_FALLBACK">>;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 環境変数から (未設定の項目は config の既定値と同じ) */
export function reversalSettingsFromEnv(env: ReversalEnv): ReversalSettings {
  const d = DEFAULT_REVERSAL_SETTINGS;
  return {
    enabled: env.REVERSAL_EXIT ?? d.enabled,
    pivotN: finite(env.REVERSAL_EXIT_PIVOT_N) ? env.REVERSAL_EXIT_PIVOT_N : d.pivotN,
    bufferAtr: finite(env.REVERSAL_EXIT_BUFFER_ATR) && env.REVERSAL_EXIT_BUFFER_ATR >= 0 ? env.REVERSAL_EXIT_BUFFER_ATR : d.bufferAtr,
    strategies: Array.isArray(env.REVERSAL_EXIT_STRATEGIES) ? [...env.REVERSAL_EXIT_STRATEGIES] : [...d.strategies],
    timeframe: env.REVERSAL_EXIT_TF === "same" || env.REVERSAL_EXIT_TF === "lower" ? env.REVERSAL_EXIT_TF : d.timeframe,
    fallback: env.REVERSAL_EXIT_FALLBACK ?? d.fallback,
  };
}

/** この戦略の建玉に転換で決済を掛けるか (有効で、対象の一覧が空 = すべて、または一覧に含まれる) */
export function reversalAppliesTo(s: ReversalSettings | undefined, strategyId: string): boolean {
  if (!s?.enabled) return false;
  return s.strategies.length === 0 || s.strategies.includes(strategyId);
}

/** 設定の 1 行表示 (status / simulate / backtest の見出し用) */
export function formatReversalSettings(s: ReversalSettings): string {
  if (!s.enabled) return "無効 (従来どおり)";
  return (
    `有効 (${s.timeframe === "same" ? "戦略の主時間足" : "戦略の主時間足の 1 つ下の時間足"}のスイング 左右 ${s.pivotN} 本` +
    `${s.fallback ? " (無ければエントリーした足の安値・高値)" : ""} / 終値が水準を${s.bufferAtr > 0 ? ` ${s.bufferAtr} ATR より大きく` : ""}越えたら決済` +
    ` / 対象 ${s.strategies.length ? s.strategies.join(", ") : "すべての戦略"})`
  );
}

/**
 * 設定の警告 (起動時にログへ出す。害はないが意図どおりに効かない組み合わせ)。
 * - REVERSAL_EXIT_STRATEGIES に戦略の一覧 (knownIds) に無い id がある (綴り違いなど。その id は何も対象にしない。
 *   廃止した戦略の id は、再起動前に建てたその戦略の建玉にだけ効く)
 * - STRUCTURE_EXIT_ON_REVERSAL=true と併用している (ラップした戦略の目線の転換での決済と重なる。どちらか一方で十分)
 */
export function reversalConfigWarnings(s: ReversalSettings, knownIds: readonly string[], structureExitOnReversal = false): string[] {
  const out: string[] = [];
  if (!s.enabled) return out;
  // 廃止した戦略の id は一覧から外さない (外すと一覧が空 = すべての戦略、に変わりうる)。再起動前に建てた建玉にだけ効く
  out.push(...strategyIdListWarnings("REVERSAL_EXIT_STRATEGIES", s.strategies, knownIds, "再起動前に建てたその戦略の建玉にだけ効きます"));
  if (structureExitOnReversal) {
    out.push(
      "STRUCTURE_EXIT_ON_REVERSAL=true と REVERSAL_EXIT=true を併用しています。どちらも転換で決済するので重複です (REVERSAL_EXIT は全戦略・建玉に対する押し安値割れ / 戻り高値超え)",
    );
  }
  return out;
}

/** 足の間隔 (最小の正の差)。求まらなければ undefined */
function inferBarMs(candles: readonly Candle[]): number | undefined {
  let min = Infinity;
  for (let i = 1; i < Math.min(candles.length, 500); i++) {
    const d = candles[i].ts - candles[i - 1].ts;
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : undefined;
}

/**
 * エントリーした足の添字 (ts ≤ entryTs < ts + 足の長さ)。
 * - 足がエントリーより後からしか無い (履歴が足りない・建玉が古すぎる) なら -1。
 * - エントリーした足がまだ確定していない (形成中) なら candles.length。
 * - 足が欠けていてエントリーした足が無ければ、エントリーの後の最初の足。
 * tfMs (足の長さ) を省略すると足の間隔から推定する
 */
export function entryBarIndex(candles: readonly Candle[], entryTs: number, tfMs?: number): number {
  if (candles.length === 0 || !finite(entryTs) || candles[0].ts > entryTs) return -1;
  // ts ≤ entryTs の最後の足 (二分探索)
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].ts <= entryTs) lo = mid;
    else hi = mid - 1;
  }
  const ms = finite(tfMs) && tfMs > 0 ? tfMs : inferBarMs(candles);
  if (ms === undefined || entryTs < candles[lo].ts + ms) return lo;
  return lo + 1;
}

export interface ReversalLevel {
  /** 守るべき水準 (買い: 押し安値 = スイングローの安値、売り: 戻り高値 = スイングハイの高値) */
  level: number;
  /** スイングの足の開始時刻 */
  pivotTs: number;
  /** スイングが確定した足 (N 本後) の開始時刻 (フォールバックはエントリーした足の開始時刻) */
  confirmedTs: number;
  /** エントリー後に確定したスイングが無く、エントリーした足の安値 (買い) / 高値 (売り) を使った */
  fallback?: boolean;
}

/**
 * 守るべき水準: エントリーした足以降の、確定したスイングロー (買い) / スイングハイ (売り) のうち最も新しいもの。
 * 無ければ undefined (エントリー後にまだスイングが確定していない・履歴が足りない)。
 * fallback が true なら、スイングが無いときにエントリーした足 (確定済み) の安値 (買い) / 高値 (売り) を返す (fallback: true)。
 * エントリーした足が無い・まだ確定していない (形成中) なら fallback でも undefined
 */
export function reversalLevel(
  candles: readonly Candle[], entryTs: number, direction: "long" | "short", N: number, tfMs?: number, fallback = false,
): ReversalLevel | undefined {
  const n = normalizePivotN(N);
  const e = entryBarIndex(candles, entryTs, tfMs);
  if (e < 0 || e >= candles.length) return undefined;
  // 足 i のスイングは足 i−N 〜 i+N だけで決まるので、エントリーした足の N 本前から渡せば結果は変わらない
  const from = Math.max(0, e - n);
  const win = candles.slice(from);
  const type = direction === "long" ? "SL" : "SH";
  const ps = confirmedPivots(detectPivots(win, n), win.length - 1).filter((p) => p.type === type && p.idx + from >= e);
  const p = ps[ps.length - 1];
  if (!p) {
    if (!fallback) return undefined;
    const eb = candles[e];
    return { level: direction === "long" ? eb.low : eb.high, pivotTs: eb.ts, confirmedTs: eb.ts, fallback: true };
  }
  return { level: p.price, pivotTs: p.ts, confirmedTs: win[p.confirmedAt].ts };
}

export interface ReversalCheckOptions {
  /** スイングの左右の本数 (REVERSAL_EXIT_PIVOT_N) */
  pivotN: number;
  /** バッファ (ATR の倍数。省略・0 なら終値が水準を越えれば十分) */
  bufferAtr?: number;
  /** 足の長さ (ms)。省略時は足の間隔から推定 */
  tfMs?: number;
  /** スイングが無ければエントリーした足の安値・高値を水準にする (REVERSAL_EXIT_FALLBACK。省略時 false) */
  fallback?: boolean;
}

export interface ReversalCheck {
  /** 決済する (確定足の終値が水準をバッファより大きく越えた) */
  exit: boolean;
  /** 守るべき水準 (無ければ undefined) */
  level?: number;
  /** 水準のスイングの足の開始時刻 (フォールバックはエントリーした足) */
  pivotTs?: number;
  /** 水準がフォールバック (エントリー後に確定したスイングが無く、エントリーした足の安値・高値) */
  fallback?: boolean;
  /** 判定した確定足 (最後の足) の終値と開始時刻 */
  close: number;
  barTs?: number;
  /** ATR(14) (最後の REVERSAL_ATR_WINDOW 本から。求まらなければ NaN) */
  atr: number;
  /** 決済の閾値 (買い: 水準 − バッファ × ATR、売り: 水準 + バッファ × ATR) */
  threshold?: number;
  /**
   * 判定しなかった理由: no_bars = 足が無い / no_history = 足がエントリーより後からしか無い /
   * no_swing = エントリー後に確定したスイングが無い (フォールバック有効ならエントリーした足がまだ確定していない) / no_atr = バッファがあるのに ATR が求まらない (決済しない)
   */
  skip?: "no_bars" | "no_history" | "no_swing" | "no_atr";
}

/**
 * 転換で決済の判定 (最後の確定足の終値で 1 回)。
 * 買い: 終値 < 押し安値 − バッファ × ATR で exit、売り: 終値 > 戻り高値 + バッファ × ATR で exit (等しいときは決済しない)
 */
export function checkReversal(
  candles: readonly Candle[], entryTs: number, direction: "long" | "short", opts: ReversalCheckOptions,
): ReversalCheck {
  const last = candles[candles.length - 1];
  const close = last ? last.close : NaN;
  const atr = candles.length ? atrLast(candles.slice(-REVERSAL_ATR_WINDOW), REVERSAL_ATR_PERIOD) : NaN;
  if (!last) return { exit: false, close, atr, skip: "no_bars" };
  const base = { close, barTs: last.ts, atr };
  if (entryBarIndex(candles, entryTs, opts.tfMs) < 0) return { exit: false, ...base, skip: "no_history" };
  const lv = reversalLevel(candles, entryTs, direction, opts.pivotN, opts.tfMs, opts.fallback === true);
  if (!lv) return { exit: false, ...base, skip: "no_swing" };
  const buf = finite(opts.bufferAtr) && opts.bufferAtr > 0 ? opts.bufferAtr : 0;
  const found = { ...base, level: lv.level, pivotTs: lv.pivotTs, ...(lv.fallback ? { fallback: true } : {}) };
  if (buf > 0 && !(finite(atr) && atr > 0)) return { exit: false, ...found, skip: "no_atr" };
  // バッファ 0 なら ATR を使わない (足が少なく ATR が求まらなくても 0 × NaN にしない)
  const threshold = buf === 0 ? lv.level : direction === "long" ? lv.level - buf * atr : lv.level + buf * atr;
  const exit = finite(close) && (direction === "long" ? close < threshold : close > threshold);
  return { exit, ...found, threshold };
}
