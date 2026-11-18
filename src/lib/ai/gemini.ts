import { env } from "../env";
import { buildDraftPrompt, buildTranslationPrompt, type NegotiationContext } from "./prompts";

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

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

async function generateJson<T>(prompt: string): Promise<T> {
  const key = env.geminiApiKey;
  if (!key) throw new Error("GEMINI_API_KEY が未設定です");
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(env.geminiModel)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API エラー: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return JSON.parse(text) as T;
}

/** 簡易言語判定 (API キー未設定時のフォールバック) */
export function guessLang(text: string): "zh" | "ja" | "en" {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  return "en";
}

export async function translateToJapanese(text: string): Promise<TranslationResult> {
  if (!env.geminiApiKey) {
    return { lang: guessLang(text), translation: `【未翻訳: GEMINI_API_KEY 未設定】${text}`, stub: true };
  }
  const r = await generateJson<{ lang: string; translation: string }>(buildTranslationPrompt(text));
  return { lang: r.lang, translation: r.translation, stub: false };
}

export async function generateReplyDraft(ctx: NegotiationContext): Promise<DraftResult> {
  if (!env.geminiApiKey) {
    const reply =
      ctx.replyLang === "zh"
        ? `您好，感谢您的回复。${ctx.targetUnitPrice ? `如果单价能做到 ${ctx.targetUnitPrice} ${ctx.currency ?? ""}，` : ""}${ctx.targetMoq ? `起订量 ${ctx.targetMoq} 件，` : ""}我们可以考虑下单。请问可以吗？`
        : `Hello, thank you for your reply. ${ctx.targetUnitPrice ? `If you could offer ${ctx.targetUnitPrice} ${ctx.currency ?? ""} per unit` : "If the terms work"}${ctx.targetMoq ? ` with an MOQ of ${ctx.targetMoq} pcs` : ""}, we would consider placing an order. Would that be possible?`;
    return {
      reply,
      replyJa: `【スタブ案: GEMINI_API_KEY 未設定】ご返信ありがとうございます。${ctx.targetUnitPrice ? `単価 ${ctx.targetUnitPrice} ${ctx.currency ?? ""} ` : ""}${ctx.targetMoq ? `MOQ ${ctx.targetMoq} 個 ` : ""}で対応いただけるなら発注を検討します。可能でしょうか？`,
      stub: true,
    };
  }
  const r = await generateJson<{ reply: string; replyJa: string }>(buildDraftPrompt(ctx));
  return { reply: r.reply, replyJa: r.replyJa, stub: false };
}
