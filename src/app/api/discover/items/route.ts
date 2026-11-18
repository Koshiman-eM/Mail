import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

const STATUSES = ["AUTO_ADDED", "ADDED", "QUALIFIED", "BELOW_THRESHOLD", "NO_DOMESTIC_PRICE", "DUPLICATE", "DISMISSED", "ERROR"] as const;
const querySchema = z.object({
  status: z
    .string()
    .max(200)
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : []))
    .pipe(z.array(z.enum(STATUSES, "ステータスの指定が不正です"))),
  watchId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(300).default(150),
});

/** 探索結果の一覧。status 未指定なら除外 (DISMISSED) 以外。条件達成・自動追加を先に、ROI の高い順 */
export const GET = handler(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const q = querySchema.parse({ status: sp.get("status") ?? undefined, watchId: sp.get("watchId") ?? undefined, limit: sp.get("limit") ?? undefined });
  const where: Prisma.DiscoveredItemWhereInput = {
    ...(q.watchId && { watchId: q.watchId }),
    status: q.status.length ? { in: q.status } : { not: "DISMISSED" },
  };
  const items = await prisma.discoveredItem.findMany({
    where,
    orderBy: [{ lastSeenAt: "desc" }, { estRoiPercent: { sort: "desc", nulls: "last" } }],
    take: q.limit,
    include: { watch: { select: { name: true } } },
  });
  return NextResponse.json(items);
});
