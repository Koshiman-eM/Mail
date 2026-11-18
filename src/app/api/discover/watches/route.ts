import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { watchCreateSchema } from "@/lib/discovery/schema";
import { readLimitedJson } from "../../_lib/body";
import { actorOf, handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

/** 実行中 (RUNNING) とみなす最長時間。これを過ぎた RUNNING は異常終了として扱う */
const RUNNING_STALE_MS = 15 * 60_000;

/** 探索条件の一覧 (ステータス別の件数・実行中かどうか付き) */
export const GET = handler(async () => {
  const [watches, counts] = await Promise.all([
    prisma.discoveryWatch.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.discoveredItem.groupBy({ by: ["watchId", "status"], _count: { _all: true } }),
  ]);
  const now = Date.now();
  return NextResponse.json(
    watches.map((w) => ({
      ...w,
      running: w.lastRunStatus === "RUNNING" && !!w.lastRunAt && now - w.lastRunAt.getTime() < RUNNING_STALE_MS,
      counts: Object.fromEntries(counts.filter((c) => c.watchId === w.id).map((c) => [c.status, c._count._all])),
    })),
  );
});

export const POST = handler(async (req: Request, _ctx, user) => {
  const raw = await readLimitedJson(req, 64 * 1024);
  if (!raw.ok) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  const b = watchCreateSchema.parse(raw.json);
  const watch = await prisma.$transaction(async (tx) => {
    const w = await tx.discoveryWatch.create({
      data: {
        name: b.name,
        keywordJa: b.keywordJa,
        foreignKeywords: (b.foreignKeywords ?? {}) as Prisma.InputJsonValue,
        platforms: b.platforms,
        enabled: b.enabled ?? true,
        estWeightKg: b.estWeightKg,
        estLengthCm: b.estLengthCm ?? null,
        estWidthCm: b.estWidthCm ?? null,
        estHeightCm: b.estHeightCm ?? null,
        targetQuantity: b.targetQuantity ?? 1,
        minRoiPercent: b.minRoiPercent,
        minProfitJpy: b.minProfitJpy ?? null,
        maxMoq: b.maxMoq ?? null,
        maxUnitPriceJpy: b.maxUnitPriceJpy ?? null,
        autoAdd: b.autoAdd ?? true,
        maxAutoAddPerRun: b.maxAutoAddPerRun ?? 5,
        createdById: user.id,
      },
    });
    await tx.auditLog.create({ data: { actor: actorOf(user), action: "discovery.watch.create", entityType: "DiscoveryWatch", entityId: w.id, after: { name: w.name, keywordJa: w.keywordJa } } });
    return w;
  });
  return NextResponse.json(watch, { status: 201 });
});
