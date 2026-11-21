/**
 * 往復コスト (bps) の唯一の定義: 往復の手数料 + スプレッド (全幅) + 往復の約定ずれ。
 *
 * - 手数料率は片道の率 (taker + 約定ごとの固定手数料の率換算。src/core/fees.ts の costFeeRate) を渡す。
 * - RiskManager (気配のスプレッド、約定ずれ 0)・純期待値の戦略 (気配のスプレッド + 想定の約定ずれ)・
 *   バックテスト (想定のスプレッド + 約定ずれ) が同じ式を使う。各呼び出し側の入力の扱い (不正な気配の扱いなど) は従来どおり。
 */
import { costFeeRate } from "./fees";
import type { Instrument, Quote } from "./types";

/** 往復コスト (bps) = 片道の手数料率 × 2 × 10⁴ + スプレッド (bps) + 2 × 片道の約定ずれ (bps) */
export function roundTripCostBps(feeRate: number, spreadBps: number, slippageBps = 0): number {
  return feeRate * 2 * 1e4 + spreadBps + 2 * slippageBps;
}

/** 気配のスプレッド (bps、全幅)。仲値が 0 以下なら 0 */
export function quoteSpreadBps(quote: Pick<Quote, "bid" | "ask">): number {
  const mid = (quote.bid + quote.ask) / 2;
  return mid > 0 ? ((quote.ask - quote.bid) / mid) * 10_000 : 0;
}

/**
 * 銘柄と気配の往復の想定コスト (bps) = 往復の手数料 (taker + 固定手数料の率換算) + スプレッド (負なら 0)。約定ずれは含めない。
 * RiskManager の判定・エンジンのコストの記録に使う (固定手数料の無い銘柄は 往復 taker 手数料 + スプレッド)
 */
export function quoteCostBps(
  instrument: Pick<Instrument, "takerFeeRate"> & Partial<Pick<Instrument, "fixedFeePerOrder" | "costModel">>,
  quote: Pick<Quote, "bid" | "ask">,
): number {
  return roundTripCostBps(costFeeRate(instrument), Math.max(0, quoteSpreadBps(quote)));
}
