import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/**
 * Claude API 共通呼び出し (構造化出力)。
 * - 拒否 (refusal) 時はサーバー側フォールバック (fallbacks: "default") で別モデルへ自動切替。
 * - API キー未設定時は呼び出し側がルールベースのフォールバックを使うこと (aiEnabled() で判定)。
 */
export interface AiOptions {
  apiKey: string;
  model: string;
}

export class AiRefusalError extends Error {
  constructor(public readonly category: string | null) {
    super(`AI が応答を拒否しました${category ? ` (${category})` : ""}`);
    this.name = "AiRefusalError";
  }
}

const clients = new Map<string, Anthropic>();
const clientFor = (apiKey: string) => {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey });
    clients.set(apiKey, c);
  }
  return c;
};

export const aiEnabled = (opts: Pick<AiOptions, "apiKey"> | undefined) => Boolean(opts?.apiKey);

export async function askStructured<T extends z.ZodType>(
  opts: AiOptions,
  schema: T,
  system: string,
  prompt: string,
  effort: "low" | "medium" | "high" = "medium",
): Promise<z.infer<T>> {
  const res = await clientFor(opts.apiKey).beta.messages.parse({
    model: opts.model,
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
