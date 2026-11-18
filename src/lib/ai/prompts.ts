/** Claude へ渡すプロンプトの組み立て (純粋関数・テスト対象)。出力形式は構造化出力のスキーマで指定する。 */

export const TRANSLATION_SYSTEM =
  "You translate messages from overseas suppliers (Chinese or English) into natural Japanese for a Japanese importer. " +
  "Keep numbers, prices, currency units, product codes and quantities exactly as written. Do not add commentary.";

export const OUTBOUND_TRANSLATION_SYSTEM =
  "You translate a Japanese importer's message to an overseas supplier. Keep the meaning, tone and every number, price, " +
  "currency unit, quantity and product code exactly. Write it the way a polite, concise business buyer would. Do not add new content.";

export function buildOutboundTranslationPrompt(textJa: string, to: "zh" | "en"): string {
  return [`Translate the message below into ${to === "zh" ? "Simplified Chinese" : "English"}.`, "", "<message>", textJa, "</message>"].join("\n");
}

export const DRAFT_SYSTEM =
  "あなたは日本の輸入事業者の購買担当として、海外サプライヤーとの価格交渉の返信文を作成します。" +
  "作成した返信は人間が確認・承認してから送信されます。" +
  "礼儀正しく簡潔に、具体的な数値を示して交渉してください。支払いや発注の確定など、承認者が判断すべき事項は約束しないでください。";

export interface NegotiationContext {
  supplierName: string;
  productTitle?: string;
  currency?: string;
  currentUnitPrice?: string;
  targetUnitPrice?: string;
  currentMoq?: number;
  targetMoq?: number;
  wantsOem?: boolean;
  notes?: string;
  /** 直近の会話履歴 (古い順) */
  history: { direction: "INBOUND" | "OUTBOUND"; text: string }[];
  /** 返信対象のメッセージ (原文) */
  latestMessage: string;
  /** 返信言語 (サプライヤーの使用言語) */
  replyLang: "zh" | "en";
}

export function buildTranslationPrompt(text: string): string {
  return [
    "Detect the language of the message below (ISO 639-1 code) and translate it into Japanese.",
    "",
    "<message>",
    text,
    "</message>",
  ].join("\n");
}

export function buildDraftPrompt(ctx: NegotiationContext): string {
  const goals: string[] = [];
  if (ctx.targetUnitPrice) goals.push(`- 目標単価: ${ctx.targetUnitPrice} ${ctx.currency ?? ""} (現在: ${ctx.currentUnitPrice ?? "不明"})`);
  if (ctx.targetMoq) goals.push(`- 目標MOQ: ${ctx.targetMoq} 個 (現在: ${ctx.currentMoq ?? "不明"})`);
  if (ctx.wantsOem) goals.push("- OEM (ロゴ印刷・専用パッケージ) の可否と追加費用を確認したい");
  if (ctx.notes) goals.push(`- 補足: ${ctx.notes}`);

  const history = ctx.history
    .slice(-10)
    .map((h) => `${h.direction === "INBOUND" ? "Supplier" : "Us"}: ${h.text}`)
    .join("\n");

  const lang = ctx.replyLang === "zh" ? "Simplified Chinese" : "English";

  return [
    `サプライヤー: ${ctx.supplierName}`,
    ctx.productTitle ? `商品: ${ctx.productTitle}` : "",
    "交渉ゴール:",
    goals.length ? goals.join("\n") : "- (特になし。情報収集を優先)",
    "",
    "これまでの会話:",
    history || "(なし)",
    "",
    "返信対象のメッセージ:",
    "<message>",
    ctx.latestMessage,
    "</message>",
    "",
    `返信本文 (reply) は ${lang} で作成し、承認者向けに同じ内容の日本語訳 (replyJa) も付けてください。`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 自動探索                                                           */
/* ------------------------------------------------------------------ */
export const SEARCH_KEYWORD_SYSTEM =
  "You convert a Japanese product keyword into a short search query for a B2B/B2C wholesale site. " +
  "Return only the product words a seller would use in listing titles (2-6 words). No quotes, no brand names unless given, no extra commentary.";

export function buildSearchKeywordPrompt(keywordJa: string, to: "en" | "zh"): string {
  const lang = to === "zh" ? "Simplified Chinese (as used on 1688.com)" : "English (as used on Alibaba.com / AliExpress)";
  return [`Write a search query in ${lang} for the Japanese keyword below.`, "", "<keyword>", keywordJa, "</keyword>"].join("\n");
}

export const TITLE_FILTER_SYSTEM =
  "You check Japanese marketplace listings against a product keyword. Keep a listing only if it is clearly the same kind of product " +
  "sold as a single unit (or a normal small set). Exclude accessories, replacement parts, unrelated products and large multi-pack / bulk listings.";

export function buildTitleFilterPrompt(keywordJa: string, titles: string[]): string {
  return [
    "Keyword:",
    keywordJa,
    "",
    "Listings (index: title):",
    ...titles.map((t, i) => `${i}: ${t.slice(0, 200)}`),
    "",
    "Return the indices of the listings to keep.",
  ].join("\n");
}
