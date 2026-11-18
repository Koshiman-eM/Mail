import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { enqueueScrape } from "@/lib/scraper/queue";
import { NotFoundError } from "@/lib/chat/service";
import { handler } from "../../../_lib/http";

export const POST = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw new NotFoundError(`Product(${id})`);
  if (product.platform === "OTHER") return NextResponse.json({ error: "このプラットフォームは巡回対象外です" }, { status: 422 });
  const job = await enqueueScrape({ productId: id, url: product.url, platform: product.platform });
  return NextResponse.json({ jobId: job.id }, { status: 202 });
});
