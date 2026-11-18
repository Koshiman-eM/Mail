import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { translateToJapanese } from "@/lib/ai/claude";
import { generateDraftFor } from "@/lib/chat/drafting";
import { notify } from "@/lib/notifications/service";
import { actorOf, handler } from "../../_lib/http";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const threadId = new URL(req.url).searchParams.get("threadId");
  if (!threadId) return NextResponse.json({ error: "threadId は必須です" }, { status: 400 });
  const messages = await prisma.chatMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json(messages);
});

const ingestSchema = z.object({
  supplierId: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string().min(1).max(10_000),
  autoDraft: z.boolean().default(true),
});

/**
 * 受信メッセージの取り込み: 翻訳 → RECEIVED で保存 → (任意) AI ドラフト生成 → DRAFT_READY。
 * ここでは決して送信しない。送信は人間の承認後に /send からのみ行う。
 */
export const POST = handler(async (req: Request, _ctx, user) => {
  const body = ingestSchema.parse(await req.json());
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: body.supplierId } });
  const tr = await translateToJapanese(body.text);
  const msg = await prisma.chatMessage.create({
    data: {
      supplierId: supplier.id,
      threadId: body.threadId,
      direction: "INBOUND",
      originalText: body.text,
      originalLang: tr.lang,
      translatedText: tr.translation,
      status: "RECEIVED",
    },
  });
  await prisma.auditLog.create({
    data: { actor: actorOf(user), action: "chat.ingest", entityType: "ChatMessage", entityId: msg.id },
  });
  await notify({
    type: "CHAT_RECEIVED",
    title: `${supplier.name} から新着メッセージ`,
    body: tr.translation.slice(0, 140),
    link: `/chat?thread=${encodeURIComponent(body.threadId)}`,
  });
  if (!body.autoDraft) return NextResponse.json(msg, { status: 201 });

  try {
    const drafted = await generateDraftFor(msg.id, "ai");
    await notify({
      type: "DRAFT_READY",
      severity: "WARNING",
      title: `${supplier.name} への返信案が承認待ちです`,
      link: `/chat?thread=${encodeURIComponent(body.threadId)}`,
    });
    return NextResponse.json(drafted, { status: 201 });
  } catch (e) {
    console.error("[chat] draft generation failed", e);
    await notify({
      type: "SYSTEM",
      severity: "WARNING",
      title: "AI 返信案の生成に失敗しました",
      body: e instanceof Error ? e.message : String(e),
      link: `/chat?thread=${encodeURIComponent(body.threadId)}`,
    });
    return NextResponse.json({ ...msg, draftError: true }, { status: 201 });
  }
});
