import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handler } from "../../_lib/http";

/** ブラウザの PushSubscription.toJSON() の形式 */
const schema = z.object({
  endpoint: z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https の endpoint のみ受け付けます"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(256) }),
});

/** 現在のユーザーの端末として購読を登録する (endpoint 単位で上書き) */
export const POST = handler(async (req, _ctx, user) => {
  const sub = schema.parse(await req.json());
  const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null;
  const data = { userId: user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, failures: 0 };
  const saved = await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { endpoint: sub.endpoint, ...data },
    update: data,
  });
  return NextResponse.json({ id: saved.id });
});
