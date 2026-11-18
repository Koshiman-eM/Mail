import { NextResponse } from "next/server";
import { z } from "zod";
import { detectBlock } from "@/lib/scraper/detect";
import { parseProductPage } from "@/lib/scraper/parse";
import { handler } from "../../_lib/http";

const schema = z.object({
  platform: z.enum(["ALIBABA", "ALI1688", "ALIEXPRESS", "OTHER"]),
  html: z.string().min(1).max(5_000_000),
  url: z.string().optional(),
});

/** 貼り付けた HTML でパーサーの抽出結果を確認する (外部アクセスなし) */
export const POST = handler(async (req: Request) => {
  const { platform, html, url } = schema.parse(await req.json());
  return NextResponse.json({
    block: detectBlock({ url: url ?? "", html }),
    parsed: parseProductPage(html, platform === "OTHER" ? undefined : platform),
  });
});
