import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env";
import {
  DRAFT_SYSTEM,
  OUTBOUND_TRANSLATION_SYSTEM,
  SEARCH_KEYWORD_SYSTEM,
  TITLE_FILTER_SYSTEM,
  TRANSLATION_SYSTEM,
  buildDraftPrompt,
  buildSearchKeywordPrompt,
  buildTitleFilterPrompt,
  buildOutboundTranslationPrompt,
  buildTranslationPrompt,
  type NegotiationContext,
} from "./prompts";

export interface TranslationResult {
  lang: string;
  translation: string;
  stub: boolean;
}

export interface DraftResult {
  reply: string;
  replyJa: string;
  stub: boolean;
}

const TranslationSchema = z.object({
  lang: z.string().describe("ISO 639-1 code of the source message, e.g. zh, en"),
  translation: z.string().describe("Natural Japanese translation"),
});

const OutboundSchema = z.object({
  translation: z.string().describe("The message translated into the requested language"),
});

const KeywordSchema = z.object({
  query: z.string().describe("The search query in the requested language"),
});

const TitleFilterSchema = z.object({
  keep: z.array(z.number().int()).describe("Indices of listings that match the keyword"),
});

const DraftSchema = z.object({
  reply: z.string().describe("Reply to send to the supplier, in the requested language"),
  replyJa: z.string().describe("Japanese translation of the reply for the approver"),
});

let client: Anthropic | undefined;
const getClient = () => (client ??= new Anthropic({ apiKey: env.anthropicApiKey }));

export class AiRefusalError extends Error {
  constructor(public readonly category: string | null) {
    super(`AI が応答を拒否しました${category ? ` (${category})` : ""}`);
    this.name = "AiRefusalError";
  }
}

/**
 * Claude に構造化出力 (JSON スキーマ) で問い合わせる。
 * 安全分類器による拒否時は fallbacks: "default" でサーバー側が別モデルへ自動切替する。
 */
async function ask<T extends z.ZodType>(
  schema: T,
  system: string,
  prompt: string,
  effort: "low" | "medium",
): Promise<z.infer<T>> {
  const res = await getClient().beta.messages.parse({
    model: env.anthropicModel,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort, format: zodOutputFormat(schema) },
  });
  if (res.stop_reason === "refusal") throw new AiRefusalError(res.stop_details?.category ?? null);
  if (!res.parsed_output) throw new Error(`AI 応答を解析できませんでした (stop_reason=${res.stop_reason})`);
  return res.parsed_output as z.infer<T>;
}

/** 簡易言語判定 (API キー未設定時のフォールバック) */
export function guessLang(text: string): "zh" | "ja" | "en" {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

export const aiConfigured = () => Boolean(env.anthropicApiKey);

export async function translateToJapanese(text: string): Promise<TranslationResult> {
  if (!aiConfigured()) {
    return { lang: guessLang(text), translation: `【未翻訳: ANTHROPIC_API_KEY 未設定】${text}`, stub: true };
  }
  const r = await ask(TranslationSchema, TRANSLATION_SYSTEM, buildTranslationPrompt(text), "low");
  return { lang: r.lang, translation: r.translation, stub: false };
}

/** 手動返信の補助: 日本語で書いた本文をサプライヤーの言語へ翻訳する */
export async function translateForSupplier(textJa: string, to: "zh" | "en"): Promise<{ translation: string; stub: boolean }> {
  if (!aiConfigured()) {
    return { translation: textJa, stub: true };
  }
  const r = await ask(OutboundSchema, OUTBOUND_TRANSLATION_SYSTEM, buildOutboundTranslationPrompt(textJa, to), "low");
  return { translation: r.translation, stub: false };
}

export async function generateReplyDraft(ctx: NegotiationContext): Promise<DraftResult> {
  if (!aiConfigured()) {
    const price = ctx.targetUnitPrice ? `${ctx.targetUnitPrice} ${ctx.currency ?? ""}`.trim() : null;
    const reply =
      ctx.replyLang === "zh"
        ? `您好，感谢您的回复。${price ? `如果单价能做到 ${price}，` : ""}${ctx.targetMoq ? `起订量 ${ctx.targetMoq} 件，` : ""}我们可以考虑下单。请问可以吗？`
        : `Hello, thank you for your reply. ${price ? `If you could offer ${price} per unit` : "If the terms work"}${ctx.targetMoq ? ` with an MOQ of ${ctx.targetMoq} pcs` : ""}, we would consider placing an order. Would that be possible?`;
    return {
      reply,
      replyJa: `【スタブ案: ANTHROPIC_API_KEY 未設定】ご返信ありがとうございます。${price ? `単価 ${price} ` : ""}${ctx.targetMoq ? `MOQ ${ctx.targetMoq} 個 ` : ""}で対応いただけるなら発注を検討します。可能でしょうか？`,
      stub: true,
    };
  }
  const r = await ask(DraftSchema, DRAFT_SYSTEM, buildDraftPrompt(ctx), "medium");
  return { reply: r.reply, replyJa: r.replyJa, stub: false };
}

/**
 * 自動探索: 日本語キーワードを海外サイトの検索語へ翻訳する (Alibaba / AliExpress は英語、1688 は簡体字中国語)。
 * キー未設定時は日本語のまま返す (stub: true)。
 */
export async function translateSearchKeyword(keywordJa: string, to: "en" | "zh"): Promise<{ text: string; stub: boolean }> {
  if (!aiConfigured()) return { text: keywordJa, stub: true };
  const r = await ask(KeywordSchema, SEARCH_KEYWORD_SYSTEM, buildSearchKeywordPrompt(keywordJa, to), "low");
  const text = r.query.replace(/\s+/g, " ").trim().slice(0, 100);
  return text ? { text, stub: false } : { text: keywordJa, stub: true };
}

/** 自動探索: 国内の販売例のうちキーワードと明らかに一致しないものを除くため、残す添字を返す (キー設定時のみ使う) */
export async function filterDomesticTitles(keywordJa: string, titles: string[]): Promise<number[]> {
  const r = await ask(TitleFilterSchema, TITLE_FILTER_SYSTEM, buildTitleFilterPrompt(keywordJa, titles), "low");
  return [...new Set(r.keep.filter((i) => Number.isInteger(i) && i >= 0 && i < titles.length))];
}
