/** エンジンの判断に使う純粋関数群 (情報バイアス・流動性・ブラックアウト) */
import {
  TIMEFRAME_MS, type AssetClass, type Candle, type Instrument, type IntelBias, type MarketBrief, type MarketView,
  type StrategyPlan, type Timeframe,
} from "../core/types";
import { biasForInstrument } from "../intel/planner";
import { clampOrZero } from "../core/util";

/** 資産クラスの擬似資産 (情報バイアスのキー。src/intel/planner.ts と同じ)。未知のクラスは擬似資産なし */
const CLASS_PSEUDO: Record<AssetClass, string> = { crypto: "CRYPTO", meme: "MEME" };
const DAY_MS = 86_400_000;

/** 情報収集がまだ無いときの空のブリーフ */
export function emptyBrief(now: number): MarketBrief {
  return { generatedAt: now, riskOn: 0, summary: "", biases: {}, watchlist: [], events: [], stub: true };
}

/**
 * 戦略へ渡す IntelBias。brief.biases から biasForInstrument と同じ規則で選び、
 * sentiment / confidence に情報の効き具合 (learning.intelInfluence) を掛けてクランプする。
 * 情報源の寄与 (sourceContrib) は学習 (情報源の信頼度) のために引き継ぐ。
 */
export function intelBiasFor(inst: Instrument, biases: Record<string, IntelBias>, influence: number): IntelBias | undefined {
  const b = biasForInstrument(inst, biases);
  if (!b.found) return undefined;
  const k = Number.isFinite(influence) ? Math.max(0, influence) : 1;
  const pseudo = biases[CLASS_PSEUDO[inst.assetClass]];
  const used = biases[inst.baseCurrency] ?? biases[inst.symbol.split("/")[0]] ?? pseudo;
  const sourceContrib: Record<string, number> = {};
  const sourceIds = new Set<string>();
  if (used) {
    for (const id of used.sourceIds ?? []) sourceIds.add(id);
    for (const [src, v] of Object.entries(used.sourceContrib ?? {})) {
      if (Number.isFinite(v)) sourceContrib[src] = clampOrZero((sourceContrib[src] ?? 0) + v, -1, 1);
    }
  }
  // ブラックアウト期限は関連する全資産の最大 (eventRisk と同じ範囲。クオート通貨の経済指標を含む)
  const related = [biases[inst.baseCurrency], biases[inst.quoteCurrency], pseudo];
  const blackoutUntil = related.reduce<number | undefined>(
    (m, x) => (x?.blackoutUntil !== undefined && (m === undefined || x.blackoutUntil > m) ? x.blackoutUntil : m),
    undefined,
  );
  return {
    asset: used?.asset ?? inst.baseCurrency,
    sentiment: clampOrZero(b.sentiment * k, -1, 1),
    confidence: clampOrZero(b.confidence * k, 0, 1),
    eventRisk: clampOrZero(b.eventRisk, 0, 1),
    ...(blackoutUntil !== undefined ? { blackoutUntil } : {}),
    sourceIds: [...sourceIds],
    sourceContrib,
  };
}

/** 直近 24 時間の出来高 (基準通貨建て) と、実際にカバーできた時間 */
export function volume24h(candles: MarketView["candles"], now: number): { volume: number; coveredMs: number } | undefined {
  let best: { volume: number; coveredMs: number } | undefined;
  for (const tf of ["1h", "15m", "5m", "1m"] as Timeframe[]) {
    const cs: Candle[] | undefined = candles[tf];
    if (!cs || cs.length === 0) continue;
    const ms = TIMEFRAME_MS[tf];
    const from = now - DAY_MS;
    let volume = 0;
    let n = 0;
    for (let i = cs.length - 1; i >= 0 && cs[i].ts >= from; i--) {
      if (Number.isFinite(cs[i].volume)) volume += cs[i].volume;
      n++;
    }
    const coveredMs = Math.min(DAY_MS, n * ms);
    if (n > 0 && (!best || coveredMs > best.coveredMs)) best = { volume, coveredMs };
  }
  return best;
}

/** 代理指標の計算に必要な最小カバー時間 */
export const MIN_VOLUME_COVERAGE_MS = 3_600_000;

/**
 * ミーム銘柄 (資産クラス meme。WATCHLIST で明示したもの) の流動性 (USD)。不明なら undefined (RiskManager が見送る)。
 * 板の厚みを直接取れないため、直近 24 時間の出来高 × 価格を USD 換算した値を代理指標にする。
 * 足が 24 時間分ない場合は 1 時間以上あれば 24 時間へ線形に引き延ばす。
 */
export function liquidityUsdFor(inst: Instrument, view: Pick<MarketView, "candles" | "quote" | "now">, toUsd: (ccy: string) => number): number | undefined {
  const vol = volume24h(view.candles, view.now);
  if (!vol || vol.coveredMs < MIN_VOLUME_COVERAGE_MS) return undefined;
  const q = view.quote;
  const price = q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : (q.last ?? NaN);
  const rate = toUsd(inst.quoteCurrency);
  if (!(price > 0) || !Number.isFinite(rate) || !(rate > 0)) return undefined;
  const scaled = vol.volume * (DAY_MS / vol.coveredMs);
  const usd = scaled * price * (inst.contractSize ?? 1) * rate;
  return Number.isFinite(usd) ? usd : undefined;
}

/** 現在有効なブラックアウト (なければ undefined) */
export function activeBlackout(plan: Pick<StrategyPlan, "blackouts"> | undefined, assetClass: AssetClass, now: number) {
  return plan?.blackouts.find((b) => b.start <= now && now < b.end && b.assetClasses.includes(assetClass));
}

/** 計画用のレジームを測る時間足 (15m → 5m → 1h → 1m の順で保持しているもの) */
export function planRegimeTimeframe(tfs: readonly Timeframe[]): Timeframe {
  return (["15m", "5m", "1h", "1m"] as Timeframe[]).find((t) => tfs.includes(t)) ?? tfs[0] ?? "1m";
}

/** 見送り理由の集計キー (数値を # に置き換えて種類ごとにまとめる) */
export function normalizeReason(reason: string): string {
  return reason.replace(/\d[\d.,:]*/g, "#").slice(0, 80);
}
