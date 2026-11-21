/**
 * 読みの管理 (THESIS_EXIT)。純粋なモジュール (時刻・価格は引数で渡す。I/O・乱数なし)。
 *
 * エントリー時に「いつ頃までに利益が出る読みか」= 読みの期限 (エントリー時刻 + expectedMs) を決め、保有中に答え合わせをする。
 *   - expectedMs: 戦略がシグナルに expectedMs を付けていればそれ、無ければ (MAX_HOLD_MINUTES で丸めた) maxHoldMs。
 *   - 途中で読み外れ (thesis_failed): 期限の半分を過ぎて、値動きだけの R (grossR = 方向 × (仲値 − 建値) / 当初のリスク。
 *     手数料・スプレッドを含めない) ≤ −earlyCutR なら決済する (earlyCutR = 0 で無効)。コストだけで切らないため純 R は使わない。
 *   - 期限で読み外れ (thesis_timeout): 期限の時点で 純 R < minR なら決済する。
 *   - 期限で読み当たり (延長): 純 R ≥ minR なら保有を続ける。保護ストップは「今のストップ」と
 *     「max(建値 (往復手数料の見積り込み), 延長後の有利な極値 − trailR × 当初のリスク)」(売りは逆) のきつい方へ引き上げる。
 *     極値は延長した時点から測り、延長した時点の決済できる価格から始める (延長より前の高値・安値は使わない)。
 *     したがって延長した瞬間のストップは max(建値, 決済できる価格 − trailR × リスク) より厳しくならず、延長そのもので決済しない
 *     (延長した判定ではストップを判定し直さない)。極値が進むほど上がるだけで、下げない。
 *     このストップでの決済は従来のトレーリングと同じ "trailing" で、記録に thesisStopExit を付ける (パラメータ調整の根拠から外すため)。
 *   - 延長の上限 (thesis_cap): 期限 × extendMult で決済する。
 *   - 利確・損切り・戦略の決済シグナルは従来どおり (ここでは判定しない)。
 * 純 R = (方向 × (決済できる価格 − 建値) − 往復手数料の見積り) / 当初の 1 単位あたりのリスク (|建値 − 当初ストップ|)。
 *   決済できる価格は買いなら bid、売りなら ask (バックテストは終値 ∓ 半スプレッド)。手数料はエントリーで実際に払った額
 *   (1 単位あたり。分からなければ 0) + 決済の taker 手数料率 × 決済できる価格。
 *   期限の判定 (延長するか) は純 R (コストを引いた利益) で行う。
 * 読みの管理が無効・期限が無い・当初のリスクが 0 以下 (純 R が求まらない) ときは、従来の時間切れ (maxHoldMs で "time") に戻す。
 * R は統計値なので number で計算する (会計値ではない)。
 */
import type { CoreEnv } from "../core/config";
import type { TradeRecord } from "../core/types";

export type ThesisExitReason = "thesis_failed" | "thesis_timeout" | "thesis_cap";

/**
 * 読みの答え合わせの結果 (TradeRecord.thesisOutcome)。
 * failed_early: 途中で読み外れ / timeout: 期限で読み外れ / extended: 期限で読み当たり → 延長 / none: 期限の前に決着 (利確・損切り・シグナルなど)
 */
export type ThesisOutcome = NonNullable<TradeRecord["thesisOutcome"]>;

export interface ThesisSettings {
  /** 読みの管理を使うか (THESIS_EXIT。false なら従来の時間切れと同一) */
  enabled: boolean;
  /** 期限の時点でこの純 R 以上なら読み当たり (延長)。未満なら読み外れで決済 (THESIS_MIN_R) */
  minR: number;
  /** 期限の半分を過ぎて 値動きだけの R (grossR) ≤ −これ なら途中で決済 (THESIS_EARLY_CUT_R。0 で無効) */
  earlyCutR: number;
  /** 延長の上限 (期限の何倍まで持つか。THESIS_EXTEND_MULT。1 なら延長しない) */
  extendMult: number;
  /** 延長後のトレーリングの幅 (当初のリスクの何倍。THESIS_TRAIL_R) */
  trailR: number;
}

export const DEFAULT_THESIS_SETTINGS: Readonly<ThesisSettings> = { enabled: true, minR: 0.1, earlyCutR: 0.5, extendMult: 4, trailR: 0.5 };

/** 無効 (従来の時間切れ)。バックテスト・PositionManager・仮想トレードで設定を渡さないときの既定 */
export const THESIS_DISABLED: Readonly<ThesisSettings> = { ...DEFAULT_THESIS_SETTINGS, enabled: false };

type ThesisEnv = Partial<Pick<CoreEnv, "THESIS_EXIT" | "THESIS_MIN_R" | "THESIS_EARLY_CUT_R" | "THESIS_EXTEND_MULT" | "THESIS_TRAIL_R">>;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 環境変数から (未設定の項目は config の既定値と同じ) */
export function thesisSettingsFromEnv(env: ThesisEnv): ThesisSettings {
  const d = DEFAULT_THESIS_SETTINGS;
  return {
    enabled: env.THESIS_EXIT ?? d.enabled,
    minR: finite(env.THESIS_MIN_R) ? env.THESIS_MIN_R : d.minR,
    earlyCutR: finite(env.THESIS_EARLY_CUT_R) ? env.THESIS_EARLY_CUT_R : d.earlyCutR,
    extendMult: finite(env.THESIS_EXTEND_MULT) ? env.THESIS_EXTEND_MULT : d.extendMult,
    trailR: finite(env.THESIS_TRAIL_R) ? env.THESIS_TRAIL_R : d.trailR,
  };
}

/** 設定の 1 行表示 (status / simulate / backtest の見出し用) */
export function formatThesisSettings(s: ThesisSettings): string {
  if (!s.enabled) return "無効 (従来の時間切れ)";
  return (
    `有効 (期限で 純R ≥ ${s.minR} なら延長 / 期限の半分を過ぎて 値動きのR ≤ −${s.earlyCutR} で途中決済${s.earlyCutR > 0 ? "" : " (無効)"}` +
    ` / 延長の上限 期限 × ${s.extendMult} / 延長後のトレーリング ${s.trailR}R)`
  );
}

/** 読みの期限 (ms)。expectedMs (> 0) があればそれ、無ければ maxHoldMs (> 0)。どちらも無ければ undefined (期限なし) */
export function resolveThesisMs(expectedMs?: number, maxHoldMs?: number): number | undefined {
  if (finite(expectedMs) && expectedMs > 0) return expectedMs;
  if (finite(maxHoldMs) && maxHoldMs > 0) return maxHoldMs;
  return undefined;
}

/** 当初の 1 単位あたりのリスク |建値 − 当初ストップ|。求まらなければ NaN */
export function initialRiskPerUnit(entryPrice: number, initialStop: number): number {
  if (!finite(entryPrice) || !finite(initialStop) || !(entryPrice > 0) || !(initialStop > 0)) return NaN;
  return Math.abs(entryPrice - initialStop);
}

/**
 * 読みの管理を使う建玉なら期限 (ms) を返す: 有効・期限あり・当初のリスク > 0。
 * 使わない (従来の時間切れ) なら undefined
 */
export function activeThesisMs(s: ThesisSettings | undefined, expectedMs: number | undefined, maxHoldMs: number | undefined, riskPerUnit: number): number | undefined {
  if (!s?.enabled) return undefined;
  if (!(finite(riskPerUnit) && riskPerUnit > 0)) return undefined;
  return resolveThesisMs(expectedMs, maxHoldMs);
}

/** 純 R・建値・トレーリングの計算に使う建玉の値 (1 単位 = 価格 1 の動きが 1 になる単位。契約サイズは呼び出し側で割る) */
export interface ThesisPricing {
  direction: "long" | "short";
  /** 建値 (エントリーの約定価格) */
  entryPrice: number;
  /** 当初の 1 単位あたりのリスク (initialRiskPerUnit) */
  risk: number;
  /** 1 単位あたりの実際のエントリー手数料 (maker の受け取りなら負。分からなければ 0 / 省略) */
  entryFeePerUnit?: number;
  /** 決済の taker 手数料率 (省略時 0) */
  takerFeeRate?: number;
}

const feeOf = (p: ThesisPricing) => (finite(p.entryFeePerUnit) ? p.entryFeePerUnit : 0);
const rateOf = (p: ThesisPricing) => (finite(p.takerFeeRate) && p.takerFeeRate > 0 && p.takerFeeRate < 1 ? p.takerFeeRate : 0);

/**
 * 今決済したときの純 R の見積り: (方向 × (exitMark − 建値) − エントリー手数料 − taker 手数料率 × exitMark) / 当初のリスク。
 * exitMark は決済できる価格 (買いは bid、売りは ask)。当初のリスクが 0 以下・価格が不正なら NaN
 */
export function thesisNetR(p: ThesisPricing, exitMark: number): number {
  if (!(finite(p.risk) && p.risk > 0) || !(finite(exitMark) && exitMark > 0) || !(finite(p.entryPrice) && p.entryPrice > 0)) return NaN;
  const dir = p.direction === "long" ? 1 : -1;
  return (dir * (exitMark - p.entryPrice) - feeOf(p) - rateOf(p) * exitMark) / p.risk;
}

/**
 * 値動きだけの R: 方向 × (mid − 建値) / 当初のリスク (手数料・スプレッドを含めない。途中で読み外れの判定に使う)。
 * mid は仲値 (バックテストは終値)。求まらなければ NaN
 */
export function thesisGrossR(p: Pick<ThesisPricing, "direction" | "entryPrice" | "risk">, mid: number): number {
  if (!(finite(p.risk) && p.risk > 0) || !(finite(mid) && mid > 0) || !(finite(p.entryPrice) && p.entryPrice > 0)) return NaN;
  return ((p.direction === "long" ? 1 : -1) * (mid - p.entryPrice)) / p.risk;
}

/**
 * 往復手数料の見積り込みの建値 (この価格で決済すると純損益 ≈ 0)。
 * 買い: (建値 + エントリー手数料) / (1 − taker 手数料率)、売り: (建値 − エントリー手数料) / (1 + taker 手数料率)
 */
export function breakevenPrice(p: Pick<ThesisPricing, "direction" | "entryPrice" | "entryFeePerUnit" | "takerFeeRate">): number {
  const fee = feeOf(p as ThesisPricing);
  const rate = rateOf(p as ThesisPricing);
  return p.direction === "long" ? (p.entryPrice + fee) / (1 - rate) : (p.entryPrice - fee) / (1 + rate);
}

/**
 * 延長後の保護ストップ: 買いは max(建値 (手数料込み), peak − trailR × リスク)、売りは min(建値, peak + trailR × リスク)。
 * peak は延長した時点からの最も有利な決済できる価格 (買いは bid の高値、売りは ask の安値。延長した時点の決済できる価格から始める)。
 * 極値が進むほど有利な側へ動くだけ (下げない)。
 * 求まらなければ undefined
 */
export function thesisTrailStop(p: ThesisPricing, peak: number, trailR: number): number | undefined {
  if (!(finite(p.risk) && p.risk > 0) || !(finite(p.entryPrice) && p.entryPrice > 0)) return undefined;
  const be = breakevenPrice(p);
  if (!finite(be) || !(be > 0)) return undefined;
  const w = finite(trailR) && trailR > 0 ? trailR * p.risk : 0;
  if (!finite(peak) || !(peak > 0)) return be;
  return p.direction === "long" ? Math.max(be, peak - w) : Math.min(be, peak + w);
}

/**
 * 延長後の有利な極値を進める (買いは高い方、売りは安い方)。peak が無ければ price から始める。price が不正なら peak のまま
 */
export function advancePeak(direction: "long" | "short", peak: number | undefined, price: number): number | undefined {
  if (!(finite(price) && price > 0)) return peak;
  if (peak === undefined || !finite(peak)) return price;
  return direction === "long" ? Math.max(peak, price) : Math.min(peak, price);
}

/** 2 つのストップのうち建玉に近い (きつい) 方。買いは高い方、売りは低い方。undefined・非有限は無視 */
export function tighterStop(direction: "long" | "short", a: number | undefined, b: number | undefined): number | undefined {
  const xs = [a, b].filter((x): x is number => finite(x));
  if (xs.length === 0) return undefined;
  return direction === "long" ? Math.max(...xs) : Math.min(...xs);
}

export interface ThesisInput {
  /** エントリーからの経過 (ms) */
  elapsedMs: number;
  /** 戦略が付けた読みの期限 (signal.expectedMs。MAX_HOLD_MINUTES で丸めたもの)。無ければ maxHoldMs を使う */
  expectedMs?: number;
  /** 最大保有 (signal.maxHoldMs。読みの管理を使わないときの従来の時間切れにも使う) */
  maxHoldMs?: number;
  /** 期限で読み当たりとして延長済みか */
  extended: boolean;
  /** 今決済したときの純 R (thesisNetR。求まらなければ NaN = 従来の時間切れに戻す)。期限の判定に使う */
  netR: number;
  /** 値動きだけの R (thesisGrossR。手数料・スプレッドを含めない)。途中で読み外れの判定に使う (NaN なら途中では切らない) */
  grossR: number;
}

export interface ThesisDecision {
  /** 期限で読み当たり: 延長する (呼び出し側が延長を記録し、保護ストップを引き上げる) */
  extend?: { netR: number };
  /** 決済する (time は従来の時間切れ) */
  exit?: { reason: ThesisExitReason | "time"; netR?: number };
}

/**
 * 時間に関する決済の判定 (損切り・利確・トレーリングの後に呼ぶ)。
 * - 読みの管理を使わない (無効・期限なし・純 R が NaN): 従来どおり maxHoldMs を過ぎたら time。
 * - 延長前: 期限を過ぎたら 純R < minR で thesis_timeout、それ以外は延長 (extend)。
 *   期限の半分 〜 期限の間は 値動きだけの R (grossR) ≤ −earlyCutR で thesis_failed (earlyCutR > 0 のときだけ。コストだけでは切らない)。
 * - 延長後 (同じ判定で延長した場合も含む): 期限 × extendMult を過ぎたら thesis_cap (extendMult ≤ 1 なら期限で即上限)
 */
export function decideThesis(i: ThesisInput, s: ThesisSettings): ThesisDecision {
  const ms = s.enabled ? resolveThesisMs(i.expectedMs, i.maxHoldMs) : undefined;
  if (ms === undefined || !finite(i.netR)) {
    const mh = i.maxHoldMs;
    return finite(mh) && mh > 0 && i.elapsedMs >= mh ? { exit: { reason: "time" } } : {};
  }
  const out: ThesisDecision = {};
  let extended = i.extended;
  if (!extended) {
    if (i.elapsedMs >= ms) {
      if (i.netR < s.minR) return { exit: { reason: "thesis_timeout", netR: i.netR } };
      out.extend = { netR: i.netR };
      extended = true;
    } else if (s.earlyCutR > 0 && i.elapsedMs >= ms / 2 && finite(i.grossR) && i.grossR <= -s.earlyCutR) {
      return { exit: { reason: "thesis_failed", netR: i.netR } };
    }
  }
  const mult = finite(s.extendMult) && s.extendMult > 1 ? s.extendMult : 1;
  if (extended && i.elapsedMs >= ms * mult) out.exit = { reason: "thesis_cap", netR: i.netR };
  return out;
}

/** 決済理由と延長の有無から、読みの答え合わせの結果を決める */
export function thesisOutcomeOf(reason: string, extended: boolean): ThesisOutcome {
  if (reason === "thesis_failed") return "failed_early";
  if (reason === "thesis_timeout") return "timeout";
  if (extended) return "extended";
  return "none";
}

/** 読みの答え合わせの区分の表示名 */
export const THESIS_OUTCOME_LABEL: Record<ThesisOutcome, string> = {
  failed_early: "途中で読み外れ",
  timeout: "期限で読み外れ",
  extended: "期限で読み当たり→延長",
  none: "期限前に決着",
};
