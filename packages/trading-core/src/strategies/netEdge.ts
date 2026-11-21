/**
 * コスト控除後の期待値 (純期待値, edgeIsNet) を出す戦略の共通部品 (scalp_micro・scalp_rebound・scalp_pullback・pullback_5m・pullback_15m)。
 * 往復コスト・勝率を仮定した期待値・コストの条件 (cost / spread / edge) の判定と、見送ったシグナルの観測用の通知。
 * 期待値の定義は src/strategies/scalpMicro.ts の説明を参照。
 */
import { roundTripCostBps, quoteSpreadBps } from "../core/costs";
import { costFeeRate } from "../core/fees";
import type { Signal, StrategyContext } from "../core/types";
import { tempoNetEdgeFloor } from "../engine/tempo";
import { clamp } from "./common";

/** 既定の勝率の上乗せの上限 (ランダムウォークの勝率 p0 に対して) */
export const DEFAULT_WIN_EDGE_MAX = 0.1;

/**
 * 気配からの往復コスト (bps。src/core/costs.ts の roundTripCostBps)。takerFeeRate には固定手数料の率換算を含めた値 (costFeeRate) を渡す。
 * 気配が無効なら undefined。手数料率・約定ずれの非有限・負の値は 0 とみなす
 */
export function quoteRoundTripCostBps(takerFeeRate: number, bid: number, ask: number, slippageBps: number): number | undefined {
  if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(ask)) return undefined;
  const fee = Math.max(0, Number.isFinite(takerFeeRate) ? takerFeeRate : 0);
  const slip = Math.max(0, Number.isFinite(slippageBps) ? slippageBps : 0);
  return roundTripCostBps(fee, quoteSpreadBps({ bid, ask }), slip);
}

/**
 * 勝率を仮定した期待値 (bps, コスト控除後)。
 * p0 = sl / (tp + sl) (ランダムウォークで利確が先に届く確率)、p = p0 + winEdgeMax × strength。
 */
export function microExpectedEdge(a: { tpBps: number; slBps: number; costBps: number; confidence: number; winEdgeMax: number }): {
  p0: number;
  p: number;
  edgeBps: number;
} {
  const { tpBps, slBps, costBps } = a;
  if (!(tpBps > 0) || !(slBps > 0)) return { p0: 0, p: 0, edgeBps: -Infinity };
  const p0 = slBps / (tpBps + slBps);
  const strength = clamp((a.confidence - 0.5) / 0.5);
  const p = clamp(p0 + Math.max(0, a.winEdgeMax) * strength, 0, 0.99);
  return { p0, p, edgeBps: p * tpBps - (1 - p) * slBps - costBps };
}

export interface NetEdgeEntryArgs {
  /** 戦略に渡された ctx (気配・params の slippageBps / minStopSpreads・tempo・onFiltered を使う) */
  ctx: StrategyContext;
  /** buildEntrySignal の結果。null・利確なしなら null を返す */
  sig: Signal | null;
  /** エントリーの想定価格 (refPrice) */
  price: number;
  /** 利確幅 ≥ costMult × 往復コスト の倍率 (テンポで緩めた後の値) */
  costMult: number;
  /** シグナルの maxHoldMs */
  maxHoldMs: number;
  winEdgeMax: number;
  /** 期待値 (コスト控除後, bps) の下限 */
  minNetEdgeBps: number;
}

/**
 * 往復コスト → 期待値 (コスト控除後) → シグナルの組み立て → コストの条件の判定。
 * 条件 (利確幅 ≥ costMult × コスト、損切り幅 ≥ minStopSpreads × スプレッド、期待値 > 下限) を満たせばシグナル、
 * 満たさなければ ctx.onFiltered に理由 (cost / spread / edge) を通知して null。気配が無効なら通知せずに null
 */
export function netEdgeEntry(a: NetEdgeEntryArgs): Signal | null {
  const { ctx, sig, price } = a;
  if (!sig || sig.takeProfit === undefined) return null;
  const p = ctx.params;

  // コスト
  const q = ctx.market.quote;
  const costBps = quoteRoundTripCostBps(costFeeRate(ctx.market.instrument), q?.bid ?? NaN, q?.ask ?? NaN, p.slippageBps);
  if (costBps === undefined) return null;
  const spread = q.ask - q.bid;
  const tpDist = Math.abs(sig.takeProfit - price);
  const slDist = Math.abs(price - sig.stopLoss);
  const tpBps = (tpDist / price) * 1e4;
  const slBps = (slDist / price) * 1e4;
  // インテルの補正後の confidence で勝率を推定する
  const ev = microExpectedEdge({ tpBps, slBps, costBps, confidence: sig.confidence, winEdgeMax: a.winEdgeMax });
  const full: Signal = {
    ...sig,
    expectedEdgeBps: ev.edgeBps,
    edgeIsNet: true,
    maxHoldMs: a.maxHoldMs,
    features: { ...sig.features, costBps, tpBps, slBps, winProb: ev.p, winProbBase: ev.p0, netEdgeBps: ev.edgeBps },
  };
  // 見送ったシグナルを観測用に通知する (失敗しても戦略の結果は変えない)
  const notify = (reason: string): null => {
    if (ctx.onFiltered && Number.isFinite(ev.edgeBps) && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.takeProfit)) {
      try {
        ctx.onFiltered(full, reason);
      } catch {
        /* 観測用。握りつぶす */
      }
    }
    return null;
  };
  // 利確幅がコストの costMult 倍未満、または損切りがスプレッドに近すぎるなら出さない
  if (tpBps < Math.max(0, a.costMult) * costBps) return notify("cost");
  if (slDist < Math.max(0, p.minStopSpreads) * spread) return notify("spread");
  // コスト控除後の期待値の条件はテンポでも緩めない (探索 ctx.tempoExplore のときだけ tempoNetEdgeFloor まで下げる)
  if (!(ev.edgeBps > tempoNetEdgeFloor(a.minNetEdgeBps, ctx.tempo, costBps, ctx.tempoExplore === true))) return notify("edge");
  return full;
}
