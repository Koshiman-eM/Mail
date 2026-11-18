import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { InvalidChatUrlError, normalizeChatUrl } from "@/lib/suppliers";
import { actorOf, handler } from "../../../_lib/http";

const schema = z.object({ chatUrl: z.string().max(2000).nullable() });

/** PATCH /api/suppliers/:id/chat-url  業者チャットページの URL を登録/解除する (http/https のみ) */
export const PATCH = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }, user) => {
  const { id } = await params;
  const body = schema.parse(await req.json());
  let chatUrl: string | null;
  try {
    chatUrl = normalizeChatUrl(body.chatUrl);
  } catch (e) {
    if (e instanceof InvalidChatUrlError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.supplier.findUnique({ where: { id }, select: { chatUrl: true } });
    if (!before) return null;
    const after = await tx.supplier.update({ where: { id }, data: { chatUrl }, select: { id: true, chatUrl: true } });
    await tx.auditLog.create({
      data: {
        actor: actorOf(user),
        action: "supplier.chatUrl.update",
        entityType: "Supplier",
        entityId: id,
        before: { chatUrl: before.chatUrl },
        after: { chatUrl },
      },
    });
    return after;
  });
  if (!updated) return NextResponse.json({ error: "業者が見つかりません" }, { status: 404 });
  return NextResponse.json(updated);
});
