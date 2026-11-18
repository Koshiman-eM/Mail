import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** スレッド一覧 (最新メッセージと承認待ち件数) */
export const GET = handler(async () => {
  const latest = await prisma.chatMessage.findMany({
    distinct: ["threadId"],
    orderBy: [{ threadId: "asc" }, { createdAt: "desc" }],
    include: { supplier: { select: { id: true, name: true, platform: true, isBlacklisted: true } } },
  });
  const pending = await prisma.chatMessage.groupBy({
    by: ["threadId"],
    where: { status: { in: ["RECEIVED", "DRAFT_READY", "APPROVED", "SEND_FAILED"] } },
    _count: { _all: true },
  });
  const pendingMap = new Map(pending.map((p) => [p.threadId, p._count._all]));
  const threads = latest
    .map((m) => ({
      threadId: m.threadId,
      supplier: m.supplier,
      lastText: m.translatedText ?? m.draftTextJa ?? m.originalText,
      lastAt: m.createdAt,
      pending: pendingMap.get(m.threadId) ?? 0,
    }))
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  return NextResponse.json(threads);
});
