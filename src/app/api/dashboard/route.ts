import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { PLATFORMS } from "@/lib/scraper/policy";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

const PENDING = ["RECEIVED", "DRAFT_READY", "APPROVED", "SEND_FAILED"] as const;

/** ダッシュボード / サイドバー用の集計 */
export const GET = handler(async () => {
  const [productCount, outOfStock, pendingByStatus, unread, queue, recentAlerts, latestSims, scraperStates, supplierCount] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { inStock: false } }),
    prisma.chatMessage.groupBy({ by: ["status"], where: { status: { in: [...PENDING] } }, _count: { _all: true } }),
    prisma.notification.groupBy({ by: ["severity"], where: { readAt: null }, _count: { _all: true } }),
    prisma.chatMessage.findMany({
      where: { status: { in: ["DRAFT_READY", "APPROVED", "SEND_FAILED"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: { supplier: { select: { name: true } } },
    }),
    prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.profitSimulation.findMany({
      distinct: ["productId"],
      orderBy: [{ productId: "asc" }, { createdAt: "desc" }],
      include: { product: { select: { title: true, titleJa: true } } },
    }),
    prisma.scraperState.findMany(),
    prisma.supplier.count({ where: { isBlacklisted: false } }),
  ]);

  const pending = Object.fromEntries(pendingByStatus.map((p) => [p.status, p._count._all])) as Record<string, number>;
  const unreadMap = Object.fromEntries(unread.map((u) => [u.severity, u._count._all])) as Record<string, number>;
  const rois = latestSims.map((s) => Number(s.roiPercent));
  const pausedSet = new Set(scraperStates.filter((s) => s.paused).map((s) => s.platform));

  return NextResponse.json({
    productCount,
    outOfStock,
    supplierCount,
    awaitingApproval: pending.DRAFT_READY ?? 0,
    awaitingSend: pending.APPROVED ?? 0,
    sendFailed: pending.SEND_FAILED ?? 0,
    awaitingDraft: pending.RECEIVED ?? 0,
    unreadCritical: unreadMap.CRITICAL ?? 0,
    unreadTotal: Object.values(unreadMap).reduce((a, b) => a + b, 0),
    avgRoi: rois.length ? rois.reduce((a, b) => a + b, 0) / rois.length : null,
    profitableCount: latestSims.filter((s) => Number(s.profitJpy) > 0).length,
    simulatedCount: latestSims.length,
    topRoi: latestSims
      .map((s) => ({ id: s.productId, label: s.product.titleJa ?? s.product.title, roi: Number(s.roiPercent), profitJpy: s.profitJpy.toString(), quantity: s.quantity }))
      .sort((a, b) => b.roi - a.roi)
      .slice(0, 6),
    queue: queue.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      supplier: m.supplier.name,
      status: m.status,
      text: m.translatedText ?? m.originalText,
      updatedAt: m.updatedAt,
    })),
    recentAlerts,
    scrapers: PLATFORMS.map((p) => ({ platform: p, paused: pausedSet.has(p) })),
  });
});
