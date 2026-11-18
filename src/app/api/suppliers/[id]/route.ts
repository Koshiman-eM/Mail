import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { actorOf, handler } from "../../_lib/http";

const patchSchema = z.object({
  isBlacklisted: z.boolean().optional(),
  blacklistNote: z.string().nullable().optional(),
  rating: z.string().regex(/^\d+(\.\d+)?$/).nullable().optional(),
});

export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  const data = patchSchema.parse(await req.json());
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.supplier.findUniqueOrThrow({ where: { id } });
    const after = await tx.supplier.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        actor: actorOf(user),
        action: "supplier.update",
        entityType: "Supplier",
        entityId: id,
        before: { isBlacklisted: before.isBlacklisted, blacklistNote: before.blacklistNote, rating: before.rating?.toString() ?? null },
        after: data,
      },
    });
    return after;
  });
  return NextResponse.json(updated);
});
