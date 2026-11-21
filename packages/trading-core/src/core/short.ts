/**
 * 実効の空売り可否と、paper での空売りの再現 (PAPER_SIMULATE_SHORT)。
 *
 * bitbank などの現物 (ccxt の spot は allowShort=false) では空売りできないが、paper では
 * 「売りで負の建玉を持ち、買い戻しで決済する」空売りを再現して、売りのシグナルも学習させる。
 *
 * 安全のための約束:
 * - instrument.allowShort (取引所の仕様) は書き換えない。再現する銘柄には simulatedShort: true を別に付ける。
 * - 実効の空売り可否は必ず canShort(inst, mode) で判定する。simulatedShort が効くのは mode === "paper" のときだけ
 *   (live・バックテスト・mode 不明では allowShort だけで判定する。live の経路は従来と同じ)。
 * - 対象は allowShort=false の暗号資産 (assetClass "crypto") だけ。ミーム (meme) と DEX の銘柄 (Jupiter の venue "jupiter"、
 *   古い "dex:*") は、流動性が薄く実際には借りられない (貸株・信用の対象にならない) ため再現しない。
 *   Jupiter はスワップだけ (現物) なので SOL・JUP (crypto) でも空売りしない。
 */
import { enabledProfile } from "./assetClasses";
import type { Instrument, TradingMode } from "./types";

/** PAPER_SHORT_BORROW_RATE_DAILY の既定値 (0.04%/日。bitbank の信用取引の手数料・金利を想定した仮の値) */
export const DEFAULT_SHORT_BORROW_RATE_DAILY = 0.0004;
/** PAPER_SHORT_BORROW_RATE_DAILY の上限 (1%/日) */
export const MAX_SHORT_BORROW_RATE_DAILY = 0.01;

type ShortInfo = Pick<Instrument, "allowShort" | "assetClass" | "venue"> & { simulatedShort?: boolean };

/** DEX の取引先 (空売りを再現しない)。Jupiter と、廃止した dex:* の古い銘柄 */
const NO_SHORT_VENUES = ["jupiter"] as const;

/**
 * paper で空売りを再現してよい銘柄か (allowShort=false で、資産クラスのプロファイルが再現を許すもの (crypto・stock)。
 * meme・fx と DEX (jupiter・dex:*) は対象外)
 */
export function simulatedShortEligible(inst: ShortInfo): boolean {
  if (inst.allowShort) return false;
  // プロファイルの paperSimulatedShort (crypto・stock)。使わないクラス・meme・fx は再現しない
  if (enabledProfile(inst.assetClass)?.paperSimulatedShort !== true) return false;
  // WATCHLIST で dex のペアを crypto と指定しても、DEX の銘柄は借りられないので再現しない
  if (typeof inst.venue === "string") {
    const v = inst.venue.toLowerCase();
    if (v.startsWith("dex")) return false;
    // Jupiter (Solana の DEX アグリゲーター) は現物のスワップだけ。SOL・JUP (crypto) でも空売りは再現しない
    if ((NO_SHORT_VENUES as readonly string[]).includes(v.split(":")[0])) return false;
  }
  return true;
}

/**
 * 実効の空売り可否。取引所で空売りできる (allowShort) か、paper で再現する銘柄 (simulatedShort) で mode が paper のとき。
 * live では simulatedShort が付いていても常に allowShort だけで判定する
 */
export function canShort(inst: ShortInfo, mode: TradingMode | undefined): boolean {
  if (inst.allowShort) return true;
  return mode === "paper" && inst.simulatedShort === true && simulatedShortEligible(inst);
}

/** paper で再現した空売りか (取引所では空売りできないが paper で売り建てる)。direction が short のときだけ true */
export function isSimulatedShort(inst: ShortInfo, mode: TradingMode | undefined, direction?: string): boolean {
  if (direction !== undefined && direction !== "short") return false;
  return !inst.allowShort && canShort(inst, mode);
}

/**
 * 空売りを再現する銘柄に simulatedShort: true を付けた写しを返す (対象外・live・無効ならそのまま)。
 * 起動時 (src/engine/setup.ts) に、発注先の mode が paper で PAPER_SIMULATE_SHORT=true のときだけ呼ぶ
 */
export function withSimulatedShort(inst: Instrument, opts: { mode: TradingMode; enabled: boolean }): Instrument {
  if (opts.mode !== "paper" || !opts.enabled || !simulatedShortEligible(inst)) return inst;
  return inst.simulatedShort === true ? inst : { ...inst, simulatedShort: true };
}
