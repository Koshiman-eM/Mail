/** MarketBrief + レジーム + 戦略一覧 → StrategyPlan (決定論ベースライン + 任意の AI 調整) */
import { z } from "zod";
import { askStructured, aiEnabled, type AiOptions } from "../core/ai";
import { createLogger } from "../core/logger";
import type {
  AssetClass,
  EconEvent,
  Horizon,
  Instrument,
  IntelBias,
  Lesson,
  MarketBrief,
  RegimeFeatures,
  Strategy,
  StrategyPlan,
  SymbolPlan,
  TradingMode,
} from "../core/types";
import { EVENT_POST_MS, EVENT_PRE_MS } from "./aggregate";
import { buildPlannerPrompt, formatLessons, isPlannerScope, PLANNER_SYSTEM } from "./prompts";
import { clamp } from "../core/util";

const log = createLogger("intel.planner");

export const PLAN_TTL_MS = 60 * 60_000;
export const MAX_RISK_MULTIPLIER = 1.5;
/** armWeights がこれ未満の戦略は無効化 */
export const ARM_DISABLE_BELOW = 0.1;
/** 片側バイアスにする閾値 */
export const DIRECTION_MIN_CONFIDENCE = 0.5;
export const DIRECTION_MIN_ABS_SENTIMENT = 0.35;
/** horizon 別のリスク倍率 (scalp/short がメイン) */
export const HORIZON_RISK_FACTOR: Record<Horizon, number> = { scalp: 1, short: 1, mid: 0.8, long: 0.6 };

export type PlanStrategy = Pick<Strategy, "id" | "horizon" | "assetClasses" | "regimes">;

export interface PlanInput {
  brief: MarketBrief;
  instruments: Instrument[];
  regimes: Record<string, RegimeFeatures>;
  strategies: PlanStrategy[];
  /** key: "strategyId|regimeLabel|assetClass" → 0〜1.5 (決定的な重み。乱数入りの探索の重みを渡さない) */
  armWeights?: Record<string, number>;
  /**
   * 資産クラス別の情報の効き具合 (learning.intelInfluence, 0〜1.5, 中立 1)。片側バイアスの判定に使う
   * sentiment / confidence に掛ける (戦略へ渡す情報バイアスと同じ補正。未指定は 1)
   */
  intelInfluence?: Partial<Record<AssetClass, number>>;
  lessons: Lesson[];
  now: number;
  ai?: AiOptions;
  /**
   * 取引 mode (記録用)。片側バイアス "short" は取引所の allowShort だけで判定し、paper の空売り再現では使わない
   * (再現の対象銘柄で買いを止めると、paper の買いの成績が live とずれるため)
   */
  mode?: TradingMode;
}

const CLASS_PSEUDO: Record<AssetClass, string> = { crypto: "CRYPTO", meme: "MEME", fx: "FX", stock: "STOCKS" };

/** 銘柄に対応するバイアス (個別 → クラス擬似資産の順。FX は base - quote) */
export function biasForInstrument(
  inst: Instrument,
  biases: Record<string, IntelBias>,
): { sentiment: number; confidence: number; eventRisk: number; found: boolean } {
  const pseudo = biases[CLASS_PSEUDO[inst.assetClass]];
  let sentiment = 0;
  let confidence = 0;
  let found = false;
  if (inst.assetClass === "fx") {
    const b = biases[inst.baseCurrency];
    const q = biases[inst.quoteCurrency];
    if (b || q) {
      sentiment = clamp((b?.sentiment ?? 0) - (q?.sentiment ?? 0), -1, 1);
      confidence = Math.min(b?.confidence ?? 0, q?.confidence ?? 0) || Math.max(b?.confidence ?? 0, q?.confidence ?? 0) * 0.5;
      found = true;
    }
  } else {
    const own = biases[inst.baseCurrency] ?? biases[inst.symbol.split("/")[0]];
    const src = own ?? pseudo;
    if (src) {
      sentiment = src.sentiment;
      confidence = src.confidence;
      found = true;
    }
  }
  // eventRisk: 関連する全資産の最大
  const ev = [biases[inst.baseCurrency], biases[inst.quoteCurrency], pseudo, inst.assetClass === "fx" ? biases.FX : undefined]
    .filter((x): x is IntelBias => Boolean(x))
    .reduce((m, x) => Math.max(m, x.eventRisk), 0);
  return { sentiment, confidence, eventRisk: ev, found };
}

/**
 * 片側バイアスの判定に使うバイアス。biasForInstrument の sentiment / confidence に情報の効き具合を掛けてクランプする
 * (engine/context.ts の intelBiasFor と同じ補正。情報が逆効果だと学習したら片側化もしにくくなる)
 */
export function influencedBias(
  inst: Instrument,
  biases: Record<string, IntelBias>,
  influence: number | undefined,
): ReturnType<typeof biasForInstrument> {
  const b = biasForInstrument(inst, biases);
  const k = influence !== undefined && Number.isFinite(influence) ? Math.max(0, influence) : 1;
  if (k === 1) return b;
  return { ...b, sentiment: clamp(b.sentiment * k, -1, 1), confidence: clamp(b.confidence * k, 0, 1) };
}

/** 経済指標からブラックアウト (高インパクトのみ)。影響クラスは通貨で決める */
export function blackoutsFromEvents(events: EconEvent[], now: number, validUntil: number): StrategyPlan["blackouts"] {
  const out: StrategyPlan["blackouts"] = [];
  for (const e of events) {
    if (e.impact !== "high") continue;
    const start = e.ts - EVENT_PRE_MS;
    const end = e.ts + EVENT_POST_MS;
    if (end <= now || start >= validUntil) continue;
    const assetClasses: AssetClass[] = e.currency === "USD" ? ["fx", "stock"] : ["fx"];
    out.push({ start, end, assetClasses, reason: `${e.currency ?? ""} ${e.title}`.trim() });
  }
  return out;
}

export function buildBaselinePlan(input: PlanInput): StrategyPlan {
  const { brief, instruments, regimes, strategies, armWeights = {}, intelInfluence = {}, now } = input;
  const validUntil = now + PLAN_TTL_MS;
  const perSymbol: Record<string, SymbolPlan> = {};
  const riskOn = clamp(brief.riskOn, -1, 1);

  for (const inst of instruments) {
    const regime = regimes[inst.symbol];
    const bias = influencedBias(inst, brief.biases, intelInfluence[inst.assetClass]);
    const notes: string[] = [];
    let enabled: PlanStrategy[] = [];
    const armDisabled: string[] = [];
    let mult = 0;

    if (regime?.label === "low_liquidity") {
      notes.push("低流動性レジームのため全戦略停止");
    } else {
      enabled = strategies.filter((s) => {
        if (!s.assetClasses.includes(inst.assetClass)) return false;
        if (!regime) return true; // レジーム不明は資産クラスのみで判定
        if (!s.regimes.includes(regime.label)) return false;
        const w = armWeights[`${s.id}|${regime.label}|${inst.assetClass}`];
        if (w === undefined || w >= ARM_DISABLE_BELOW) return true;
        armDisabled.push(s.id);
        return false;
      });
      if (enabled.length === 0) notes.push("現レジームに合う有効戦略なし");
      else {
        // 時間軸: 有効戦略のうち最も重視する horizon (scalp/short 優先) の係数
        const horizonFactor = Math.max(...enabled.map((s) => HORIZON_RISK_FACTOR[s.horizon]));
        mult = 1 * horizonFactor * (1 + 0.25 * riskOn) * (1 - 0.6 * bias.eventRisk);
        if (!regime) {
          mult *= 0.6;
          notes.push("レジーム不明のため控えめ");
        } else {
          if (regime.label === "high_vol") mult *= 0.7;
          if (regime.volatilityPercentile > 0.9) mult *= 0.8;
        }
        if (inst.assetClass === "meme") mult *= 0.7;
        if (bias.eventRisk >= 0.5) notes.push(`指標イベント接近 (eventRisk ${bias.eventRisk.toFixed(2)})`);
      }
    }

    let directionBias: SymbolPlan["directionBias"] = "both";
    if (enabled.length > 0 && bias.found && bias.confidence >= DIRECTION_MIN_CONFIDENCE && Math.abs(bias.sentiment) >= DIRECTION_MIN_ABS_SENTIMENT) {
      if (bias.sentiment > 0) directionBias = "long";
      // 片側 "short" (買いを止める) は取引所で本当に空売りできる銘柄だけ。paper で空売りを再現する現物は
      // "both" のままにして、買いの扱いを live と同じに保つ (再現の空売りは "both" の下で戦略が出す)
      else if (inst.allowShort) directionBias = "short";
      else {
        mult *= 0.6; // 売り建て不可の弱気は倍率を絞るだけ
        notes.push("弱気だがショート不可のためリスク縮小");
      }
      if (directionBias !== "both") notes.push(`情報バイアス ${bias.sentiment.toFixed(2)} (信頼度 ${bias.confidence.toFixed(2)}) により片側`);
    }

    perSymbol[inst.symbol] = {
      symbol: inst.symbol,
      enabledStrategies: enabled.map((s) => s.id),
      directionBias,
      riskMultiplier: enabled.length === 0 ? 0 : clamp(mult, 0, MAX_RISK_MULTIPLIER),
      notes: notes.length ? notes.join(" / ") : undefined,
      ...(armDisabled.length ? { armDisabled } : {}),
    };
  }

  const blackouts = blackoutsFromEvents(brief.events, now, validUntil);
  const active = Object.values(perSymbol).filter((p) => p.enabledStrategies.length > 0).length;
  const rationale =
    `ベースライン計画: ${instruments.length} 銘柄中 ${active} 銘柄で戦略を有効化。` +
    `リスクオン指数 ${riskOn.toFixed(2)}、ブラックアウト ${blackouts.length} 件。` +
    "スキャルピング・短期戦略を主軸とし、中長期はリスクを控えめにしています。";
  return { generatedAt: now, validUntil, perSymbol, blackouts, rationale };
}

const AiPlanSchema = z.object({
  rationale: z.string(),
  adjustments: z.array(
    z.object({
      symbol: z.string(),
      enabledStrategies: z.array(z.string()),
      directionBias: z.enum(["long", "short", "both"]),
      riskMultiplier: z.number(),
      notes: z.string(),
    }),
  ),
  extraBlackouts: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      assetClasses: z.array(z.enum(["crypto", "meme", "fx", "stock"])),
      reason: z.string(),
    }),
  ),
});
export type AiPlan = z.infer<typeof AiPlanSchema>;

/** AI の調整案を制約内でマージ (純粋関数)。ベースラインのブラックアウトは削除不可 */
export function mergeAiPlan(base: StrategyPlan, ai: AiPlan, instruments: Instrument[], now: number, mode?: TradingMode): StrategyPlan {
  const byInst = new Map(instruments.map((i) => [i.symbol, i]));
  const perSymbol: Record<string, SymbolPlan> = Object.fromEntries(Object.entries(base.perSymbol).map(([k, v]) => [k, { ...v }]));
  for (const adj of ai.adjustments) {
    const cur = perSymbol[adj.symbol];
    const inst = byInst.get(adj.symbol);
    if (!cur || !inst) continue;
    // 停止中の銘柄は AI でも再開できない
    if (cur.enabledStrategies.length === 0) continue;
    const allowed = new Set(cur.enabledStrategies);
    const strategies = [...new Set(adj.enabledStrategies.filter((s) => allowed.has(s)))];
    if (strategies.length > 0 || adj.enabledStrategies.length === 0) cur.enabledStrategies = strategies;
    if (adj.directionBias !== "short" || inst.allowShort) cur.directionBias = adj.directionBias;
    if (Number.isFinite(adj.riskMultiplier)) cur.riskMultiplier = clamp(adj.riskMultiplier, 0, MAX_RISK_MULTIPLIER);
    if (cur.enabledStrategies.length === 0) cur.riskMultiplier = 0;
    const note = adj.notes.trim();
    if (note) cur.notes = [cur.notes, `AI: ${note}`].filter(Boolean).join(" / ");
  }
  const extra = ai.extraBlackouts
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start && b.end - b.start <= 24 * 3_600_000 && b.end > now && b.assetClasses.length > 0)
    .slice(0, 5)
    .map((b) => ({ ...b, reason: `AI: ${b.reason}` }));
  return {
    ...base,
    perSymbol,
    blackouts: [...base.blackouts, ...extra],
    rationale: ai.rationale.trim() || base.rationale,
  };
}

export async function buildStrategyPlan(input: PlanInput): Promise<StrategyPlan> {
  const base = buildBaselinePlan(input);
  if (!aiEnabled(input.ai)) return base;
  try {
    const prompt = buildPlannerPrompt(
      {
        baseline: base,
        brief: { riskOn: input.brief.riskOn, summary: input.brief.summary, watchlist: input.brief.watchlist, biases: Object.values(input.brief.biases).map((b) => ({ asset: b.asset, sentiment: +b.sentiment.toFixed(2), confidence: +b.confidence.toFixed(2), eventRisk: +b.eventRisk.toFixed(2) })) },
        // 情報の効き具合 (1 未満なら情報に沿った取引の成績が悪い)。ベースラインの片側バイアスはこれで補正済み
        ...(input.intelInfluence ? { intelInfluence: input.intelInfluence } : {}),
        regimes: input.regimes,
        strategies: input.strategies,
      },
      formatLessons(input.lessons, isPlannerScope),
      new Date(input.now).toISOString(),
    );
    const ai = await askStructured(input.ai!, AiPlanSchema, PLANNER_SYSTEM, prompt, "low");
    return mergeAiPlan(base, ai, input.instruments, input.now, input.mode);
  } catch (e) {
    log.warn("AI 計画調整に失敗したためベースラインを使用", { error: e instanceof Error ? e.message : String(e) });
    return base;
  }
}
