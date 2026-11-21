/**
 * コストの見積もりに使う手数料率 (taker 手数料 + 約定ごとの固定手数料の率換算)。
 *
 * Jupiter (DEX) の銘柄は takerFeeRate = 0 (経路の LP 手数料は見積もりの価格に織り込み済み) で、
 * Solana のネットワーク手数料を約定ごとの固定額 (Instrument.fixedFeePerOrder、クオート通貨建て) として持つ。
 * 期待値とコストの比較 (RiskManager・戦略・バックテスト・仮想トレード・読みの管理の純 R) は bps / 率で考えるので、
 * 固定額を代表的な約定代金 (costModel.refNotional) で割った率を taker 手数料に足して使う。
 * 実際の約定 (PaperBroker・バックテストの会計) は固定額をそのまま手数料に計上する (率換算は見積もりだけ)。
 */
import type { Instrument } from "./types";

type FeeInfo = Pick<Instrument, "takerFeeRate"> & Partial<Pick<Instrument, "fixedFeePerOrder" | "costModel">>;

const finitePos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** 約定ごとの固定手数料 (クオート通貨建て)。無ければ 0 */
export function fixedFeeOf(inst: Partial<Pick<Instrument, "fixedFeePerOrder">>): number {
  return finitePos(inst.fixedFeePerOrder) ? inst.fixedFeePerOrder : 0;
}

/**
 * 固定手数料を率に直した値 (notional が無ければ costModel.refNotional)。
 * 固定手数料が無い・代金が分からなければ 0
 */
function fixedFeeRate(inst: Partial<Pick<Instrument, "fixedFeePerOrder" | "costModel">>, notional?: number): number {
  const fee = fixedFeeOf(inst);
  if (fee === 0) return 0;
  const n = finitePos(notional) ? notional : inst.costModel?.refNotional;
  return finitePos(n) ? fee / n : 0;
}

/** コストの見積もりに使う片道の手数料率 (taker + 固定手数料の率換算)。固定手数料の無い銘柄は takerFeeRate そのもの */
export function costFeeRate(inst: FeeInfo, notional?: number): number {
  const t = Number.isFinite(inst.takerFeeRate) ? Math.max(0, inst.takerFeeRate) : 0;
  return t + fixedFeeRate(inst, notional);
}
