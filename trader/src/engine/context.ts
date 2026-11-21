/** エンジンの判断に使う純粋関数群 (情報バイアス・流動性・ブラックアウト・自動監視の候補選定) */
import {
  TIMEFRAME_MS, type AssetClass, type Candle, type Instrument, type IntelBias, type IntelItem, type MarketBrief, type MarketView,
  type StrategyPlan, type Timeframe,
} from "../core/types";
import { biasForInstrument } from "../intel/planner";
import { clampOrZero } from "../core/util";

const CLASS_PSEUDO: Record<AssetClass, string> = { crypto: "CRYPTO", meme: "MEME", fx: "FX", stock: "STOCKS" };
const DAY_MS = 86_400_000;

/** 情報収集がまだ無いときの空のブリーフ */
export function emptyBrief(now: number): MarketBrief {
  return { generatedAt: now, riskOn: 0, summary: "", biases: {}, watchlist: [], events: [], stub: true };
}

/**
 * 戦略へ渡す IntelBias。brief.biases から biasForInstrument と同じ規則で選び、
 * sentiment / confidence に情報の効き具合 (learning.intelInfluence) を掛けてクランプする。
 * 情報源の寄与 (sourceContrib) は学習 (情報源の信頼度) のために引き継ぐ (FX のクオート通貨側は符号を反転)。
 */
export function intelBiasFor(inst: Instrument, biases: Record<string, IntelBias>, influence: number): IntelBias | undefined {
  const b = biasForInstrument(inst, biases);
  if (!b.found) return undefined;
  const k = Number.isFinite(influence) ? Math.max(0, influence) : 1;
  const pseudo = biases[CLASS_PSEUDO[inst.assetClass]];
  const used: [IntelBias, number][] = [];
  if (inst.assetClass === "fx") {
    if (biases[inst.baseCurrency]) used.push([biases[inst.baseCurrency], 1]);
    if (biases[inst.quoteCurrency]) used.push([biases[inst.quoteCurrency], -1]);
  } else {
    const src = biases[inst.baseCurrency] ?? biases[inst.symbol.split("/")[0]] ?? pseudo;
    if (src) used.push([src, 1]);
  }
  const sourceContrib: Record<string, number> = {};
  const sourceIds = new Set<string>();
  for (const [bias, sign] of used) {
    for (const id of bias.sourceIds ?? []) sourceIds.add(id);
    for (const [src, v] of Object.entries(bias.sourceContrib ?? {})) {
      if (Number.isFinite(v)) sourceContrib[src] = clampOrZero((sourceContrib[src] ?? 0) + sign * v, -1, 1);
    }
  }
  // ブラックアウト期限は関連する全資産の最大 (eventRisk と同じ範囲)
  const related = [biases[inst.baseCurrency], biases[inst.quoteCurrency], pseudo, inst.assetClass === "fx" ? biases.FX : undefined];
  const blackoutUntil = related.reduce<number | undefined>(
    (m, x) => (x?.blackoutUntil !== undefined && (m === undefined || x.blackoutUntil > m) ? x.blackoutUntil : m),
    undefined,
  );
  return {
    asset: inst.assetClass === "fx" ? inst.symbol : (used[0]?.[0].asset ?? inst.baseCurrency),
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
 * ミーム銘柄の流動性 (USD)。不明なら undefined (RiskManager が見送る)。
 * - DEX 銘柄: instrument.meta.liquidityUsd (プールの流動性)
 * - CEX 銘柄: 板の厚みを直接取れないため、直近 24 時間の出来高 × 価格を USD 換算した値を代理指標にする。
 *   足が 24 時間分ない場合は 1 時間以上あれば 24 時間へ線形に引き延ばす。
 */
export function liquidityUsdFor(inst: Instrument, view: Pick<MarketView, "candles" | "quote" | "now">, toUsd: (ccy: string) => number): number | undefined {
  if (inst.venue.startsWith("dex")) {
    const v = Number(inst.meta?.liquidityUsd);
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  }
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

// ───────── 自動ミーム監視 ─────────

export interface AutoMemeCandidate {
  key: string;
  chainId: string;
  pairAddress: string;
  symbol: string;
  liquidityUsd: number;
  rugRisk: number;
  pairAgeHours: number;
  inWatchlist: boolean;
}

const DEX_URL_RE = /^https:\/\/dexscreener\.com\/([a-z0-9_-]+)\/([a-z0-9]+)\/?(?:[?#].*)?$/i;

/** URL (https://dexscreener.com/<chain>/<pair>) からチェーンとペアアドレス */
export function parseDexScreenerUrl(url: string | undefined): { chainId: string; pairAddress: string } | undefined {
  const m = url ? DEX_URL_RE.exec(url.trim()) : null;
  return m ? { chainId: m[1].toLowerCase(), pairAddress: m[2] } : undefined;
}

/**
 * DexScreener 由来のトレンドから自動監視の候補を選ぶ (純粋関数)。
 * 条件: 流動性 ≥ minLiquidityUsd、rugRisk < 0.5、ペア作成から 24 時間以上。
 * brief.watchlist に載っているものを優先し、次に流動性の大きい順。
 */
export function selectAutoMemeCandidates(
  items: IntelItem[],
  o: { minLiquidityUsd: number; watchlist?: string[]; exclude?: Set<string>; max?: number; source?: string },
): AutoMemeCandidate[] {
  const wl = new Set((o.watchlist ?? []).map((s) => s.toUpperCase()));
  const seen = new Map<string, AutoMemeCandidate>();
  for (const it of items) {
    if (it.kind !== "trending" || it.source !== (o.source ?? "dexscreener")) continue;
    const loc = parseDexScreenerUrl(it.url);
    if (!loc) continue;
    const m = it.metrics ?? {};
    const liq = m.liquidityUsd;
    const rug = m.rugRisk;
    const age = m.pairAgeHours;
    if (!(Number.isFinite(liq) && liq >= o.minLiquidityUsd)) continue;
    if (!(Number.isFinite(rug) && rug < 0.5)) continue;
    if (!(Number.isFinite(age) && age >= 24)) continue;
    const key = `${loc.chainId}:${loc.pairAddress}`;
    if (o.exclude?.has(key)) continue;
    const symbol = (it.assets.find((a) => a !== "MEME") ?? "").toUpperCase();
    const cand: AutoMemeCandidate = {
      key, ...loc, symbol, liquidityUsd: liq, rugRisk: rug, pairAgeHours: age,
      inWatchlist: wl.has(symbol) || [...wl].some((w) => w.split("/")[0] === symbol),
    };
    const prev = seen.get(key);
    if (!prev || cand.liquidityUsd > prev.liquidityUsd) seen.set(key, cand);
  }
  return [...seen.values()]
    .sort((a, b) => Number(b.inWatchlist) - Number(a.inWatchlist) || b.liquidityUsd - a.liquidityUsd)
    .slice(0, o.max ?? 5);
}
