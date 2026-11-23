/**
 * 建値ストップ (BREAKEVEN_TRIGGER_R)。純粋なモジュール (時刻・価格は引数で渡す。I/O・乱数なし)。
 *
 * 有利方向へ十分に動いた建玉が、そのまま含み益を吐き出して損失で終わるのを防ぐ。
 *   - 発動: エントリーの仲値 (無ければ建値) からの有利な仲値の動き ≥ triggerR × 当初のリスク (|建値 − 当初ストップ|)。
 *     判定は仲値 (ライブ・仮想トレードは気配の仲値、バックテストは足の終値)。triggerR = 0 で無効。
 *   - 保護ストップ: 往復コスト込みの建値。読みの管理の「建値 (往復手数料込み)」(breakevenPrice) と同じ計算に、
 *     決済の手数料率として taker 率 + 約定ごとの固定手数料の 1 単位換算 (costFeeRate(inst, 約定代金)) + 発動時の半スプレッドの率を渡す。
 *     買い: (建値 + エントリー手数料/単位) / (1 − 決済コスト率) ≈ 建値 × (1 + 決済コスト率) + エントリー手数料/単位。売りは逆。
 *   - 緩めない: 実効のストップは 当初ストップ・トレーリング・読みの管理の保護ストップ・建値ストップ のうち最もきついもの。
 *     一度発動したら戻さない (呼び出し側が保存する)。
 *   - 発動した判定 (ティック・足) ではストップを判定しない (次のティック・足から効く。先読みしない)。
 *   - このストップでの決済は "trailing" で、記録に breakevenStopExit を付ける (ParamTuner のトレーリングの調整の根拠から外す)。
 * R・価格は統計値・判定値なので number で計算する (会計値ではない)。
 */
import type { CoreEnv } from "../core/config";
import { breakevenPrice } from "./thesis";

export interface BreakevenSettings {
  /** 発動する有利な仲値の動き (当初のリスクの何倍か。0 で無効。BREAKEVEN_TRIGGER_R) */
  triggerR: number;
}

export const DEFAULT_BREAKEVEN_SETTINGS: Readonly<BreakevenSettings> = { triggerR: 0.5 };

/** 無効 (従来どおり)。設定を渡さないときの既定 */
export const BREAKEVEN_DISABLED: Readonly<BreakevenSettings> = { triggerR: 0 };

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** 環境変数から (未設定なら config の既定値と同じ) */
export function breakevenSettingsFromEnv(env: Partial<Pick<CoreEnv, "BREAKEVEN_TRIGGER_R">>): BreakevenSettings {
  const t = env.BREAKEVEN_TRIGGER_R;
  return { triggerR: finite(t) && t >= 0 ? t : DEFAULT_BREAKEVEN_SETTINGS.triggerR };
}

/** 有効か (triggerR > 0) */
export function breakevenEnabled(s: BreakevenSettings | undefined): s is BreakevenSettings {
  return !!s && finite(s.triggerR) && s.triggerR > 0;
}

/** 設定の 1 行表示 (status / backtest の見出し用) */
export function formatBreakevenSettings(s: BreakevenSettings | undefined): string {
  if (!breakevenEnabled(s)) return "無効 (BREAKEVEN_TRIGGER_R=0)";
  return `有効 (仲値が ${s.triggerR}R 有利に動いたら、ストップを往復コスト込みの建値へ引き上げ)`;
}

/**
 * 発動するか: 方向 × (仲値 − エントリーの基準 (仲値)) ≥ triggerR × 当初のリスク。
 * 無効・リスク 0 以下・価格が不正なら false。浮動小数点の誤差でちょうどの値を取りこぼさないよう、ごくわずかな許容差を持つ
 */
export function breakevenTriggered(
  s: BreakevenSettings | undefined, direction: "long" | "short", entryRef: number, risk: number, mid: number,
): boolean {
  if (!breakevenEnabled(s)) return false;
  if (!(finite(entryRef) && entryRef > 0) || !(finite(risk) && risk > 0) || !(finite(mid) && mid > 0)) return false;
  const move = (direction === "long" ? 1 : -1) * (mid - entryRef);
  const need = s.triggerR * risk;
  return move >= need - Math.abs(need) * 1e-9;
}

export interface BreakevenCostInput {
  direction: "long" | "short";
  /** 建値 (エントリーの約定価格) */
  entryPrice: number;
  /** 1 単位あたりの実際のエントリー手数料 (分からなければ 0 / 省略) */
  entryFeePerUnit?: number;
  /** 決済の手数料率 (taker + 約定ごとの固定手数料の 1 単位換算。costFeeRate(inst, 約定代金))。省略時 0 */
  exitFeeRate?: number;
  /** 発動時の半スプレッドの率 ((ask − bid) / 2 / 仲値。バックテストは半スプレッドの bps / 1e4)。省略時 0 */
  halfSpreadRate?: number;
}

/**
 * 往復コスト込みの建値ストップ (読みの管理の breakevenPrice と同じ計算。決済コスト率 = 手数料率 + 半スプレッドの率)。
 * 求まらなければ undefined
 */
export function breakevenStopPrice(i: BreakevenCostInput): number | undefined {
  if (!(finite(i.entryPrice) && i.entryPrice > 0)) return undefined;
  const fee = finite(i.entryFeePerUnit) ? i.entryFeePerUnit : 0;
  const rate = (finite(i.exitFeeRate) && i.exitFeeRate > 0 ? i.exitFeeRate : 0) + (finite(i.halfSpreadRate) && i.halfSpreadRate > 0 ? i.halfSpreadRate : 0);
  if (!(rate < 1)) return undefined;
  const be = breakevenPrice({ direction: i.direction, entryPrice: i.entryPrice, entryFeePerUnit: fee, takerFeeRate: rate });
  return finite(be) && be > 0 ? be : undefined;
}
