import { NextResponse } from "next/server";
import type { Prisma, Severity } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

const SEVERITIES: Severity[] = ["INFO", "WARNING", "CRITICAL"];

export const GET = handler(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const severity = sp.get("severity") as Severity | null;
  const where: Prisma.NotificationWhereInput = {};
  if (severity && SEVERITIES.includes(severity)) where.severity = severity;
  if (sp.get("unread") === "1") where.readAt = null;
  const [items, unreadCounts] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.notification.groupBy({ by: ["severity"], where: { readAt: null }, _count: { _all: true } }),
  ]);
  const unread = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const c of unreadCounts) unread[c.severity] = c._count._all;
  return NextResponse.json({ items, unread, unreadTotal: Object.values(unread).reduce((a, b) => a + b, 0) });
});
