/** Gemini へ渡すプロンプトの組み立て (純粋関数・テスト対象) */

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
    "You are a professional translator for Japanese importers negotiating with Chinese suppliers.",
    "Detect the language of the message below (ISO 639-1 code) and translate it into natural Japanese.",
    "Keep numbers, prices, currency units, product codes and quantities exactly as written.",
    'Respond ONLY as JSON: {"lang": "<code>", "translation": "<Japanese>"}',
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
    "あなたは日本の輸入事業者の購買担当として、海外サプライヤーとの価格交渉の返信文を作成します。",
    "礼儀正しく簡潔に、具体的な数値を示して交渉してください。確約できない事項 (支払・発注確定) は約束しないこと。",
    "",
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
    `返信本文は ${lang} で作成し、同じ内容の日本語訳も付けてください。`,
    'JSON のみで回答: {"reply": "<' + lang + ' reply>", "replyJa": "<日本語訳>"}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}
