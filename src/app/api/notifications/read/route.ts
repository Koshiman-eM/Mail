import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

const schema = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() });

export const POST = handler(async (req: Request) => {
  const { ids, all } = schema.parse(await req.json());
  const where = all ? { readAt: null } : { id: { in: ids ?? [] }, readAt: null };
  const r = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  return NextResponse.json({ updated: r.count });
});
