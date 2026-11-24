/**
 * backtest のコストの前提 (--cost-model native|jupiter)。
 * - native (既定): 取得元の銘柄定義のまま (ccxt は取引所の手数料率 + 資産クラスの既定のスプレッド・スリッページ、
 *   jupiter は運用と同じ jupiterInstrument)。
 * - jupiter: 足の取得元によらず Jupiter で売買したときのコストにする (取引所の長い履歴で Jupiter のコストを試す)。
 *   手数料率 0 (経路の手数料は見積もりの価格に含まれる)、約定ごとの固定手数料 = JUPITER_NETWORK_FEE_USD、
 *   スプレッド = 運用と同じ jupiterInstrument の costModel (主要銘柄 (crypto) の代わりのモデルの片道 bps × 2。
 *   流動性は JUPITER_BACKTEST_ASSUMED_LIQUIDITY_USD を仮定)、スリッページ 0、空売りなし。指値は使わない (CLI が limitOrders を渡さない)。
 *   ネットワーク手数料は USD 建てなので、クオートが USD / USDT / USDC の銘柄だけ (円建ては例外)。
 */
import type { Instrument } from "../core/types";
import { defaultCosts } from "../backtest/engine";
import { normalizeCurrency } from "./fx";
import { jupiterInstrument, JUPITER_VENUE } from "../market/feeds/jupiter";

export const BACKTEST_COST_MODELS = ["native", "jupiter"] as const;
export type BacktestCostModel = (typeof BACKTEST_COST_MODELS)[number];

/**
 * --cost-model jupiter で代わりのモデルに入れるプールの流動性 (USD)。SOL・JUP の主要なプールはこれより大きく、
 * 基準の代金 $50 の影響は 2 × 50 / 1e7 = 0.1bps (片道はほぼ固定の 5bps)
 */
export const JUPITER_BACKTEST_ASSUMED_LIQUIDITY_USD = 10_000_000;

export interface JupiterCostSettings {
  /** 基準の約定代金 (JUPITER_QUOTE_SIZE_USD) */
  quoteSizeUsd: number;
  /** 約定ごとのネットワーク手数料 (JUPITER_NETWORK_FEE_USD) */
  networkFeeUsd: number;
  /** 仮定する流動性 (既定 JUPITER_BACKTEST_ASSUMED_LIQUIDITY_USD) */
  liquidityUsd?: number;
}

/**
 * 銘柄定義に Jupiter のコスト (主要銘柄の代わりのモデル + ネットワーク手数料) を当てる。数値は運用と同じ jupiterInstrument から取る。
 * Jupiter の銘柄 (--source jupiter) はそのまま。クオートが USD 系でなければ例外
 */
export function jupiterCostInstrument(inst: Instrument, s: JupiterCostSettings): Instrument {
  if (inst.venue === JUPITER_VENUE) return inst;
  if (normalizeCurrency(inst.quoteCurrency) !== "USD") {
    throw new Error(
      `--cost-model jupiter は USD 建て (USD / USDT / USDC) の銘柄だけです: ${inst.symbol} (クオート ${inst.quoteCurrency})。` +
        "円建ての銘柄は --cost-model native (取引所の手数料) にしてください",
    );
  }
  const j = jupiterInstrument(
    { mint: "-", symbol: inst.baseCurrency, decimals: 9, assetClass: "crypto", liquidityUsd: s.liquidityUsd ?? JUPITER_BACKTEST_ASSUMED_LIQUIDITY_USD, source: "fixed" },
    { quoteSizeUsd: s.quoteSizeUsd, networkFeeUsd: s.networkFeeUsd, minNotionalUsd: 0 },
  );
  // 現物のスワップとして扱う (先物の契約サイズ・空売りの再現は外す)
  const { contractSize: _cs, simulatedShort: _ss, ...rest } = inst;
  return {
    ...rest,
    assetClass: "crypto",
    takerFeeRate: j.takerFeeRate,
    makerFeeRate: j.makerFeeRate,
    ...(j.fixedFeePerOrder !== undefined ? { fixedFeePerOrder: j.fixedFeePerOrder } : {}),
    ...(j.costModel ? { costModel: j.costModel } : {}),
    allowShort: false,
  };
}

/** 銘柄定義のコストの前提の表示 (バックテストの見出し用。backtest の instrumentCosts と同じ選び方) */
export function describeInstrumentCosts(inst: Instrument): string {
  const m = inst.costModel;
  const valid = m && Number.isFinite(m.spreadBps) && m.spreadBps >= 0 && Number.isFinite(m.slippageBps) && m.slippageBps >= 0;
  const c = valid ? { spreadBps: m.spreadBps, slippageBps: m.slippageBps } : defaultCosts(inst.assetClass);
  const pct = (r: number) => `${(r * 100).toFixed(3)}%`;
  const fixed = inst.fixedFeePerOrder !== undefined && inst.fixedFeePerOrder > 0 ? ` / 固定 ${inst.fixedFeePerOrder} ${inst.quoteCurrency}/約定` : "";
  const ref = valid ? ` (基準の約定代金 ${m.refNotional} ${inst.quoteCurrency})` : " (資産クラスの既定値)";
  return (
    `手数料 taker ${pct(inst.takerFeeRate)} / maker ${pct(Number.isFinite(inst.makerFeeRate) ? inst.makerFeeRate : inst.takerFeeRate)}${fixed}` +
    ` / スプレッド ${c.spreadBps.toFixed(1)}bps (往復) / スリッページ ${c.slippageBps.toFixed(1)}bps (片道)${ref}`
  );
}
