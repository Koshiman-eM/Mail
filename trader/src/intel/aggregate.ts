/** IntelItem 群 → 資産別 IntelBias (純粋関数) */
import type { EconEvent, IntelBias, IntelItem, SourceReliability } from "../core/types";
import { clamp } from "../core/util";

export const DEFAULT_HALF_LIFE_MS = 6 * 3_600_000;
/** 加重平均を 0 へ縮める事前質量 (少数・低重要度の記事で極端な値にならないように) */
export const PRIOR_MASS = 0.3;
/** confidence の質量スケール */
export const MASS_SCALE = 1.5;
/** Fear&Greed のコントラリアン係数 (極端値で ±この値まで逆張り方向へ) */
export const FNG_CONTRARIAN_COEF = 0.25;
export const EVENT_PRE_MS = 30 * 60_000;
export const EVENT_POST_MS = 15 * 60_000;
const EVENT_LOOKAHEAD_MS = 6 * 3_600_000;
const EVENT_AFTER_MS = 2 * 3_600_000;
const MAX_SOURCE_IDS = 50;
/** USD 指標が波及するクラス擬似資産 (eventRisk のみ、ブラックアウトは付けない) */
const USD_SPILLOVER = ["CRYPTO", "MEME", "STOCKS"];
const SPILLOVER_SCALE = 0.5;
/** now よりこれ以上未来の公開時刻は信用しない (情報源側の丸めと同じ 5 分) */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * 集計に使う公開時刻。now より MAX_FUTURE_SKEW_MS 以上未来なら、取得時刻 (それも未来・不正なら now) に丸める。
 * 丸めないと未来の記事は「経過時間 0」の最大の重みのまま、その時刻が来るまで残り続ける
 */
export function effectivePublishedAt(it: Pick<IntelItem, "publishedAt" | "fetchedAt">, now: number): number {
  const p = it.publishedAt;
  if (!Number.isFinite(p)) return Number.isFinite(it.fetchedAt) && it.fetchedAt <= now ? it.fetchedAt : now;
  if (p <= now + MAX_FUTURE_SKEW_MS) return p;
  return Number.isFinite(it.fetchedAt) && it.fetchedAt <= now ? it.fetchedAt : now;
}

export interface BuildBiasesOpts {
  now: number;
  halfLifeMs?: number;
  reliability?: Record<string, SourceReliability>;
  events?: EconEvent[];
}

interface Acc {
  wSum: number;
  wsSum: number;
  wAbs: number;
  baseSum: number;
  bySource: Map<string, { base: number; bs: number }>;
  ids: { id: string; w: number }[];
}

/** 時間減衰 × importance × 信頼度 weight の加重平均 */
export function buildBiases(items: IntelItem[], opts: BuildBiasesOpts): Record<string, IntelBias> {
  const { now, halfLifeMs = DEFAULT_HALF_LIFE_MS, reliability = {}, events = [] } = opts;
  const accs = new Map<string, Acc>();
  const seen = new Set<string>();

  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (it.kind === "calendar" || it.kind === "metric") continue;
    if (it.sentiment === undefined || !Number.isFinite(it.sentiment)) continue;
    const age = Math.max(0, now - effectivePublishedAt(it, now));
    const decay = 0.5 ** (age / halfLifeMs);
    const base = decay * clamp(it.importance ?? 0.5, 0, 1);
    const rw = clamp(reliability[it.source]?.weight ?? 1, 0, 2);
    const w = base * rw;
    const s = clamp(it.sentiment, -1, 1);
    for (const asset of new Set(it.assets)) {
      let a = accs.get(asset);
      if (!a) accs.set(asset, (a = { wSum: 0, wsSum: 0, wAbs: 0, baseSum: 0, bySource: new Map(), ids: [] }));
      a.wSum += w;
      a.wsSum += w * s;
      a.wAbs += w * Math.abs(s);
      a.baseSum += base;
      const sc = a.bySource.get(it.source) ?? { base: 0, bs: 0 };
      sc.base += base;
      sc.bs += base * s;
      a.bySource.set(it.source, sc);
      a.ids.push({ id: it.id, w: base });
    }
  }

  const out: Record<string, IntelBias> = {};
  for (const [asset, a] of accs) {
    const agreement = a.wAbs > 0 ? Math.abs(a.wsSum) / a.wAbs : 0;
    // 信頼度 weight は sentiment の大きさと confidence に効く (質量 wSum 経由)
    const sentiment = clamp(a.wsSum / (a.wSum + PRIOR_MASS), -1, 1);
    const confidence = clamp((1 - Math.exp(-a.wSum / MASS_SCALE)) * (0.4 + 0.6 * agreement), 0, 1);
    // 寄与は信頼度 weight を掛けない素の方向 (weight 0 の情報源も学習側で評価し続けられるように)
    const sourceContrib: Record<string, number> = {};
    for (const [src, sc] of a.bySource) sourceContrib[src] = clamp(sc.bs / (a.baseSum + PRIOR_MASS), -1, 1);
    out[asset] = {
      asset,
      sentiment,
      confidence,
      eventRisk: 0,
      sourceIds: a.ids.sort((x, y) => y.w - x.w).slice(0, MAX_SOURCE_IDS).map((x) => x.id),
      sourceContrib,
    };
  }

  applyFearGreed(out, items, reliability, now);
  applyEvents(out, events, now);
  return out;
}

const ensure = (out: Record<string, IntelBias>, asset: string): IntelBias =>
  (out[asset] ??= { asset, sentiment: 0, confidence: 0, eventRisk: 0, sourceIds: [], sourceContrib: {} });

/** 極端な強欲は少しマイナス、極端な恐怖は少しプラス (CRYPTO) */
function applyFearGreed(
  out: Record<string, IntelBias>,
  items: IntelItem[],
  reliability: Record<string, SourceReliability>,
  now: number,
) {
  let latest: IntelItem | undefined;
  for (const it of items) {
    if (it.metrics?.fng === undefined || it.publishedAt > now) continue;
    if (!latest || it.publishedAt > latest.publishedAt) latest = it;
  }
  if (!latest) return;
  const x = clamp(((latest.metrics!.fng - 50) / 50), -1, 1);
  const rw = clamp(reliability[latest.source]?.weight ?? 1, 0, 2);
  const adj = -FNG_CONTRARIAN_COEF * x ** 3;
  const b = ensure(out, "CRYPTO");
  b.sentiment = clamp(b.sentiment + adj * rw, -1, 1);
  b.confidence = Math.max(b.confidence, 0.2);
  b.sourceIds = [...b.sourceIds, latest.id];
  b.sourceContrib[latest.source] = clamp(adj, -1, 1);
  b.notes = `Fear&Greed=${latest.metrics!.fng}`;
}

/** イベントの近さ (0〜1): 前 30 分〜後 15 分は 1、そこから減衰 */
function proximity(dt: number): number {
  if (dt > 0) {
    if (dt <= EVENT_PRE_MS) return 1;
    if (dt <= EVENT_LOOKAHEAD_MS) return 1 - (0.7 * (dt - EVENT_PRE_MS)) / (EVENT_LOOKAHEAD_MS - EVENT_PRE_MS);
    return 0;
  }
  const since = -dt;
  if (since <= EVENT_POST_MS) return 1;
  if (since <= EVENT_AFTER_MS) return 1 - (0.7 * (since - EVENT_POST_MS)) / (EVENT_AFTER_MS - EVENT_POST_MS);
  return 0;
}

const IMPACT_BASE = { high: 1, medium: 0.5, low: 0.15 } as const;

function applyEvents(out: Record<string, IntelBias>, events: EconEvent[], now: number) {
  for (const ev of events) {
    const dt = ev.ts - now;
    const risk = IMPACT_BASE[ev.impact] * proximity(dt);
    if (risk <= 0) continue;
    const direct = ev.currency ? [ev.currency, "FX"] : ["FX"];
    const spill = ev.currency === "USD" ? USD_SPILLOVER : [];
    const active = ev.impact === "high" && dt <= EVENT_PRE_MS && dt >= -EVENT_POST_MS;
    for (const asset of direct) {
      const b = ensure(out, asset);
      b.eventRisk = Math.max(b.eventRisk, risk);
      if (active) b.blackoutUntil = Math.max(b.blackoutUntil ?? 0, ev.ts + EVENT_POST_MS);
    }
    for (const asset of spill) {
      const b = ensure(out, asset);
      b.eventRisk = Math.max(b.eventRisk, risk * SPILLOVER_SCALE);
    }
  }
}
