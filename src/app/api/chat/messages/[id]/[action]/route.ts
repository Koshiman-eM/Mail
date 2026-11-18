import { NextResponse } from "next/server";
import { z } from "zod";
import { approveMessage, rejectMessage, sendApprovedMessage } from "@/lib/chat/service";
import { chatDb, generateDraftFor } from "@/lib/chat/drafting";
import { getSupplierAdapter } from "@/lib/suppliers";
import { actorOf, handler } from "../../../../_lib/http";

const approveSchema = z.object({ expectedVersion: z.number().int().nonnegative(), finalText: z.string().max(10_000).optional() });
const rejectSchema = z.object({ expectedVersion: z.number().int().nonnegative(), reason: z.string().max(1000).optional() });

/**
 * POST /api/chat/messages/:id/draft   AI 返信案を (再) 生成
 * POST /api/chat/messages/:id/approve 承認 (送信本文確定)
 * POST /api/chat/messages/:id/reject  却下
 * POST /api/chat/messages/:id/send    承認済みを送信 (トランザクション内で承認状態を再検証)
 */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string; action: string }> }, user) => {
  const { id, action } = await params;
  const actor = actorOf(user);
  switch (action) {
    case "draft":
      return NextResponse.json(await generateDraftFor(id, actor));
    case "approve":
      return NextResponse.json(await approveMessage(chatDb(), id, approveSchema.parse(await req.json()), actor));
    case "reject":
      return NextResponse.json(await rejectMessage(chatDb(), id, rejectSchema.parse(await req.json()), actor));
    case "send":
      return NextResponse.json(await sendApprovedMessage(chatDb(), getSupplierAdapter(), id, actor));
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
});
