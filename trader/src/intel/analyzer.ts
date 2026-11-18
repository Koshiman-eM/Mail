/** IntelItem 群 → MarketBrief。AI 有効時は Claude で記事分析、無効/失敗時はキーワード辞書 */
import { z } from "zod";
import { askStructured, aiEnabled, type AiOptions } from "../core/ai";
import { createLogger } from "../core/logger";
import type { EconEvent, IntelItem, Lesson, MarketBrief, SourceReliability } from "../core/types";
import { buildBiases, DEFAULT_HALF_LIFE_MS } from "./aggregate";
import { tagAssets } from "./assetTagger";
import { ANALYZER_SYSTEM, buildAnalyzerPrompt, formatLessons, isIntelScope } from "./prompts";
import { applyFallbackSentiment } from "./sentiment";

const log = createLogger("intel.analyzer");

export interface AnalyzeContext {
  now: number;
  reliability: Record<string, SourceReliability>;
  lessons: Lesson[];
  ai?: AiOptions;
  events: EconEvent[];
  /** LLM に渡す最大記事数 */
  maxAiItems?: number;
  halfLifeMs?: number;
}

export interface AnalyzeResult {
  brief: MarketBrief;
  /** 分析結果 (sentiment/importance/assets) を反映した項目 */
  items: IntelItem[];
  /** LLM で分析できた id (呼び出し側がキャッシュして再分析を避ける) */
  aiAnalyzedIds: string[];
}

const AiSchema = z.object({
  articles: z.array(
    z.object({ id: z.string(), sentiment: z.number(), importance: z.number(), assets: z.array(z.string()) }),
  ),
  riskOn: z.number(),
  summary: z.string(),
  watchlist: z.array(z.string()),
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9぀-ヿ一-龯]+/g, " ").trim();

/** id と正規化タイトルで重複除去 (先勝ち) */
export function dedupeItems(items: IntelItem[]): IntelItem[] {
  const ids = new Set<string>();
  const titles = new Set<string>();
  const out: IntelItem[] = [];
  for (const it of items) {
    const nt = it.kind === "news" || it.kind === "social" ? normTitle(it.title) : "";
    if (ids.has(it.id) || (nt && titles.has(nt))) continue;
    ids.add(it.id);
    if (nt) titles.add(nt);
    out.push(it);
  }
  return out;
}

/** 重要度と新しさで未分析記事の上位 N 件を選ぶ */
export function selectForAi(items: IntelItem[], now: number, n: number): IntelItem[] {
  const cands = items.filter((i) => (i.kind === "news" || i.kind === "social") && i.sentiment === undefined);
  const score = (i: IntelItem) => {
    const rec = 0.5 ** (Math.max(0, now - i.publishedAt) / DEFAULT_HALF_LIFE_MS);
    return (0.3 + (i.importance ?? 0.5)) * rec + (i.assets.length > 0 ? 0.1 : 0);
  };
  return cands.sort((a, b) => score(b) - score(a)).slice(0, n);
}

function fallbackRiskOn(biases: MarketBrief["biases"]): number {
  const xs = ["CRYPTO", "STOCKS", "MEME"].map((k) => biases[k]).filter(Boolean);
  if (xs.length === 0) return 0;
  return clamp(xs.reduce((s, b) => s + b.sentiment, 0) / xs.length, -1, 1);
}

function fallbackWatchlist(items: IntelItem[]): string[] {
  return items
    .filter((i) => i.source === "dexscreener" && (i.metrics?.rugRisk ?? 1) < 0.5)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .slice(0, 5)
    .map((i) => i.assets[0])
    .filter(Boolean);
}

export async function analyzeIntelDetailed(rawItems: IntelItem[], ctx: AnalyzeContext): Promise<AnalyzeResult> {
  const items = dedupeItems(rawItems);
  const byId = new Map(items.map((i) => [i.id, { ...i }]));
  const aiAnalyzedIds: string[] = [];
  let aiOut: z.infer<typeof AiSchema> | undefined;

  if (aiEnabled(ctx.ai)) {
    const picked = selectForAi(items, ctx.now, ctx.maxAiItems ?? 30);
    if (picked.length > 0) {
      try {
        const prompt = buildAnalyzerPrompt(
          picked.map((p) => ({ id: p.id, source: p.source, kind: p.kind, title: p.title, summary: p.summary?.slice(0, 300), assets: p.assets, metrics: p.metrics })),
          formatLessons(ctx.lessons, isIntelScope),
          new Date(ctx.now).toISOString(),
        );
        aiOut = await askStructured(ctx.ai!, AiSchema, ANALYZER_SYSTEM, prompt, "low");
        const allowed = new Set(picked.map((p) => p.id));
        for (const a of aiOut.articles) {
          if (!allowed.has(a.id) || !Number.isFinite(a.sentiment) || !Number.isFinite(a.importance)) continue;
          const it = byId.get(a.id)!;
          it.sentiment = clamp(a.sentiment, -1, 1);
          it.importance = clamp(a.importance, 0, 1);
          const extra = a.assets.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{1,10}$/.test(s));
          it.assets = [...new Set([...it.assets, ...extra, ...tagAssets(a.assets.join(" "))])].sort();
          aiAnalyzedIds.push(a.id);
        }
      } catch (e) {
        log.warn("AI 分析に失敗したためフォールバックを使用", { error: e instanceof Error ? e.message : String(e) });
        aiOut = undefined;
      }
    }
  }

  const analyzed = applyFallbackSentiment([...byId.values()]);
  const biases = buildBiases(analyzed, {
    now: ctx.now,
    halfLifeMs: ctx.halfLifeMs,
    reliability: ctx.reliability,
    events: ctx.events,
  });
  const usedAi = aiOut !== undefined;
  const riskOn = usedAi && Number.isFinite(aiOut!.riskOn) ? clamp(aiOut!.riskOn, -1, 1) : fallbackRiskOn(biases);
  const watchlist = usedAi
    ? [...new Set(aiOut!.watchlist.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9/]{1,20}$/.test(s)))].slice(0, 5)
    : fallbackWatchlist(analyzed);
  const summary =
    usedAi && aiOut!.summary.trim()
      ? aiOut!.summary.trim()
      : `ルールベース集計 (AI 未使用): ${analyzed.length} 件を分析。リスクオン指数 ${riskOn.toFixed(2)}。` +
        Object.values(biases)
          .filter((b) => b.confidence >= 0.3)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5)
          .map((b) => `${b.asset}:${b.sentiment.toFixed(2)}`)
          .join(" ");

  return {
    brief: { generatedAt: ctx.now, riskOn, summary, biases, watchlist, events: ctx.events, stub: !usedAi },
    items: analyzed,
    aiAnalyzedIds,
  };
}

export async function analyzeIntel(items: IntelItem[], ctx: AnalyzeContext): Promise<MarketBrief> {
  return (await analyzeIntelDetailed(items, ctx)).brief;
}
