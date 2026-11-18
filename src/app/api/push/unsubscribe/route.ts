import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

const schema = z.object({ endpoint: z.string().min(1).max(2048) });

/** この端末の購読を解除する (自分の購読のみ) */
export const POST = handler(async (req, _ctx, user) => {
  const { endpoint } = schema.parse(await req.json());
  const r = await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
  return NextResponse.json({ removed: r.count });
});
