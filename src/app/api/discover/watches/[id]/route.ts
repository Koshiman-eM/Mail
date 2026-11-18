import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { DiscoveryNotFoundError } from "@/lib/discovery/errors";
import { watchUpdateSchema } from "@/lib/discovery/schema";
import { readLimitedJson } from "../../../_lib/body";
import { actorOf, handler } from "../../../_lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handler(async (req: Request, { params }: Ctx, user) => {
  const { id } = await params;
  const raw = await readLimitedJson(req, 64 * 1024);
  if (!raw.ok) return NextResponse.json({ error: "リクエストの形式が不正です" }, { status: 400 });
  const b = watchUpdateSchema.parse(raw.json);
  const before = await prisma.discoveryWatch.findUnique({ where: { id } });
  if (!before) throw new DiscoveryNotFoundError("探索条件");
  const { foreignKeywords, ...rest } = b;
  const data: Prisma.DiscoveryWatchUpdateInput = { ...rest };
  if (foreignKeywords) data.foreignKeywords = foreignKeywords as Prisma.InputJsonValue;
  const updated = await prisma.$transaction(async (tx) => {
    const w = await tx.discoveryWatch.update({ where: { id }, data });
    await tx.auditLog.create({ data: { actor: actorOf(user), action: "discovery.watch.update", entityType: "DiscoveryWatch", entityId: id, after: b as Prisma.InputJsonValue } });
    return w;
  });
  return NextResponse.json(updated);
});

/** 探索条件と、その探索結果を削除する (登録済みの商品は残る) */
export const DELETE = handler(async (_req: Request, { params }: Ctx, user) => {
  const { id } = await params;
  const before = await prisma.discoveryWatch.findUnique({ where: { id } });
  if (!before) throw new DiscoveryNotFoundError("探索条件");
  await prisma.$transaction([
    prisma.discoveryWatch.delete({ where: { id } }),
    prisma.auditLog.create({ data: { actor: actorOf(user), action: "discovery.watch.delete", entityType: "DiscoveryWatch", entityId: id, before: { name: before.name, keywordJa: before.keywordJa } } }),
  ]);
  return NextResponse.json({ ok: true });
});
