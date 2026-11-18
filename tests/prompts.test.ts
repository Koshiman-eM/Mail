import { describe, expect, it } from "vitest";
import { buildDraftPrompt } from "@/lib/ai/prompts";
import { generateReplyDraft, guessLang } from "@/lib/ai/claude";

describe("AI ドラフトプロンプト", () => {
  it("交渉ゴールをコンテキストに含める", () => {
    const p = buildDraftPrompt({
      supplierName: "Yiwu Trading",
      currency: "USD",
      currentUnitPrice: "2.50",
      targetUnitPrice: "2.10",
      currentMoq: 500,
      targetMoq: 300,
      wantsOem: true,
      history: [],
      latestMessage: "MOQ is 500 pcs.",
      replyLang: "en",
    });
    expect(p).toContain("目標単価: 2.10 USD");
    expect(p).toContain("目標MOQ: 300");
    expect(p).toContain("OEM");
    expect(p).toContain("English");
  });

  it("API キー未設定時はスタブ案を返し、外部呼び出ししない", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await generateReplyDraft({ supplierName: "x", history: [], latestMessage: "你好", replyLang: "zh", targetMoq: 300 });
    expect(r.stub).toBe(true);
    expect(r.reply).toContain("300");
  });

  it("簡易言語判定", () => {
    expect(guessLang("您好，最低起订量")).toBe("zh");
    expect(guessLang("Hello there")).toBe("en");
    expect(guessLang("こんにちは")).toBe("ja");
  });
});
