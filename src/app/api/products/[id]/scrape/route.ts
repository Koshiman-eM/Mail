import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { scrapeProduct } from "@/lib/jobs/scrapeProduct";
import { createHttpFetcher } from "@/lib/scraper/httpFetcher";
import { enqueueScrape } from "@/lib/scraper/queue";
import { NotFoundError } from "@/lib/chat/service";
import { readLimitedJson } from "../../../_lib/body";
import { actorOf, handler } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({ html: z.string().min(1).max(5_000_000).optional() });

/**
 * 商品ページの再取得。
 * - `{ html }` を渡すと、貼り付けたページソースを解析する (サイトへはアクセスしない)。
 * - REDIS_URL があれば BullMQ に投入 (202)。結果は通知で届く。
 * - Redis が無い (無料プラン) 場合は HTTP 取得でその場で実行し結果を返す (200)。
 *   利用者の操作による単発の取得なので、CAPTCHA 等を検知しても定期巡回は止めず、理由を返して手動対応 (ソース貼り付け・手入力) を促す。
 */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  // 本文は貼り付けソース (最大 5MB) を含みうるため、約 6MB を超えるものは読む前/読みながら拒否する (413)
  const body = await readLimitedJson(req);
  if (!body.ok) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  const { html } = bodySchema.parse(body.json);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new NotFoundError(`Product(${id})`);

  if (html !== undefined) {
    const result = await scrapeProduct(id, null, { html, trigger: "product.update" });
    await prisma.auditLog.create({
      data: { actor: actorOf(user), action: "product.parse_html", entityType: "Product", entityId: id, after: { status: result.status, note: "note" in result ? result.note : null } },
    });
    return NextResponse.json({ mode: "pasted", result });
  }

  if (product.platform === "OTHER") return NextResponse.json({ error: "このプラットフォームは自動取得の対象外です" }, { status: 422 });
  if (env.redisUrl) {
    const job = await enqueueScrape({ productId: id, url: product.url, platform: product.platform });
    return NextResponse.json({ mode: "queued", jobId: job.id }, { status: 202 });
  }
  const fetcher = createHttpFetcher();
  try {
    const result = await scrapeProduct(id, fetcher, { respectPause: false, pauseOnBlock: false });
    return NextResponse.json({ mode: "inline", result });
  } finally {
    await fetcher.close();
  }
});
