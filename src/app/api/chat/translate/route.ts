import { NextResponse } from "next/server";
import { z } from "zod";
import { translateForSupplier } from "@/lib/ai/claude";
import { handler } from "../../_lib/http";

const schema = z.object({ text: z.string().min(1).max(10_000), to: z.enum(["zh", "en"]) });

/** 手動返信の補助: 日本語 → 中国語 / 英語 */
export const POST = handler(async (req: Request) => {
  const { text, to } = schema.parse(await req.json());
  return NextResponse.json(await translateForSupplier(text, to));
});
