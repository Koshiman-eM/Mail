import { prisma } from "../db/prisma";
import { generateReplyDraft } from "../ai/gemini";
import { attachDraft } from "./service";
import type { ChatDb } from "./types";

export const chatDb = () => prisma as unknown as ChatDb;

/** 交渉ゴール・商品情報・履歴を集約して AI 返信案を生成し、DRAFT_READY にする */
export async function generateDraftFor(messageId: string, actor: string) {
  const msg = await prisma.chatMessage.findUnique({ where: { id: messageId }, include: { supplier: true } });
  if (!msg) throw new Error("メッセージが見つかりません");

  const goal = await prisma.negotiationGoal.findFirst({
    where: { supplierId: msg.supplierId, active: true },
    orderBy: { updatedAt: "desc" },
  });
  const product = goal?.productId ? await prisma.product.findUnique({ where: { id: goal.productId } }) : null;
  const tiers = (product?.priceTiers as { minQty: number; unitPrice: string }[] | undefined) ?? [];

  const history = await prisma.chatMessage.findMany({
    where: { threadId: msg.threadId, createdAt: { lt: msg.createdAt } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  const historyLines = history.flatMap((h) => {
    const lines: { direction: "INBOUND" | "OUTBOUND"; text: string }[] = [{ direction: h.direction, text: h.originalText }];
    if (h.status === "SENT" && h.finalText) lines.push({ direction: "OUTBOUND", text: h.finalText });
    return lines;
  });

  const draft = await generateReplyDraft({
    supplierName: msg.supplier.name,
    productTitle: product?.title,
    currency: goal?.currency ?? product?.currency,
    currentUnitPrice: tiers[0]?.unitPrice,
    targetUnitPrice: goal?.targetUnitPrice?.toString(),
    currentMoq: product?.moq,
    targetMoq: goal?.targetMoq ?? undefined,
    wantsOem: goal?.wantsOem,
    notes: goal?.notes ?? undefined,
    history: historyLines,
    latestMessage: msg.originalText,
    replyLang: msg.originalLang === "zh" ? "zh" : "en",
  });

  return attachDraft(chatDb(), messageId, { draftText: draft.reply, draftTextJa: draft.replyJa }, actor);
}
