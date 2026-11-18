import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { parse } };
  },
}));

describe("Claude 連携 (SDK モック)", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    parse.mockReset();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("構造化出力・フォールバック付きでリクエストし、解析結果を返す", async () => {
    parse.mockResolvedValue({ stop_reason: "end_turn", parsed_output: { lang: "zh", translation: "こんにちは" } });
    const { translateToJapanese } = await import("@/lib/ai/claude");
    const r = await translateToJapanese("你好");
    expect(r).toEqual({ lang: "zh", translation: "こんにちは", stub: false });
    const req = parse.mock.calls[0][0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toContain("server-side-fallback-2026-07-01");
    expect(req.output_config.format).toBeDefined();
    expect(req.thinking).toBeUndefined();
  });

  it("refusal は AiRefusalError", async () => {
    parse.mockResolvedValue({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null });
    const { generateReplyDraft, AiRefusalError } = await import("@/lib/ai/claude");
    await expect(
      generateReplyDraft({ supplierName: "x", history: [], latestMessage: "hi", replyLang: "en" }),
    ).rejects.toBeInstanceOf(AiRefusalError);
  });
});
