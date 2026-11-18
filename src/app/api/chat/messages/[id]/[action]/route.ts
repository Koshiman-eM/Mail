import { NextResponse } from "next/server";
import { z } from "zod";
import { approveAndSend, approveMessage, attachDraft, rejectMessage, sendApprovedMessage } from "@/lib/chat/service";
import { chatDb, generateDraftFor } from "@/lib/chat/drafting";
import { getSupplierAdapter } from "@/lib/suppliers";
import { actorOf, handler } from "../../../../_lib/http";

const approveSchema = z.object({ expectedVersion: z.number().int().nonnegative(), finalText: z.string().max(10_000).optional() });
const manualSchema = z.object({ draftText: z.string().min(1).max(10_000), draftTextJa: z.string().max(10_000).nullable().optional() });
const rejectSchema = z.object({ expectedVersion: z.number().int().nonnegative(), reason: z.string().max(1000).optional() });

/**
 * POST /api/chat/messages/:id/draft   AI 返信案を (再) 生成
 * POST /api/chat/messages/:id/approve 承認 (送信本文確定)
 * POST /api/chat/messages/:id/reject  却下
 * POST /api/chat/messages/:id/send    承認済みを送信 (トランザクション内で承認状態を再検証)
 * POST /api/chat/messages/:id/manual  自分で書いた返信本文を設定 (DRAFT_READY, source=MANUAL)
 * POST /api/chat/messages/:id/approve-send  本人確認をもって承認し、続けて送信 (送信は通常のガードを通る)
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
    case "manual": {
      const b = manualSchema.parse(await req.json());
      return NextResponse.json(await attachDraft(chatDb(), id, { draftText: b.draftText, draftTextJa: b.draftTextJa ?? null, source: "MANUAL" }, actor));
    }
    case "approve-send":
      return NextResponse.json(await approveAndSend(chatDb(), getSupplierAdapter(), id, approveSchema.parse(await req.json()), actor));
    case "send":
      return NextResponse.json(await sendApprovedMessage(chatDb(), getSupplierAdapter(), id, actor));
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 404 });
  }
});
