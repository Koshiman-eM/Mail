import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { chatDb } from "@/lib/chat/drafting";
import { BlacklistedSupplierError, approveForSending, createManualOutbound } from "@/lib/chat/service";
import { actorOf, handler } from "../../_lib/http";

const schema = z.object({
  supplierId: z.string().min(1),
  /** 省略時は新しいスレッドを作成 */
  threadId: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(10_000),
  textJa: z.string().max(10_000).nullable().optional(),
  lang: z.enum(["zh", "en", "ja"]).nullable().optional(),
  /**
   * true: 作成と同時に承認する (送信前提の承認)。送信はしない: APPROVED の行を返し、
   * UI の手渡しパネルから業者アプリで送ったのち /api/chat/messages/:id/send で記録する。
   */
  send: z.boolean().default(false),
});

/** こちらから送るメッセージを (人が書いた本文で) 作成する */
export const POST = handler(async (req: Request, _ctx, user) => {
  const b = schema.parse(await req.json());
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: b.supplierId } });
  if (b.send && supplier.isBlacklisted) throw new BlacklistedSupplierError(supplier.name);
  const threadId = b.threadId ?? `thread-${b.supplierId}-${Date.now().toString(36)}`;
  const actor = actorOf(user);
  const row = await createManualOutbound(chatDb(), { supplierId: b.supplierId, threadId, text: b.text, textJa: b.textJa ?? null, lang: b.lang ?? null }, actor);
  if (!b.send) return NextResponse.json(row, { status: 201 });
  return NextResponse.json(await approveForSending(chatDb(), row.id, { expectedVersion: row.version }, actor), { status: 201 });
});
