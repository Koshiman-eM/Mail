import type { NotificationType, Prisma, Severity } from "@prisma/client";
import { prisma } from "../db/prisma";
import { publishNotification } from "./bus";
import { pushForNotification } from "../push/send";

export interface CreateNotificationInput {
  type: NotificationType;
  severity?: Severity;
  title: string;
  body?: string;
  link?: string;
  meta?: Prisma.InputJsonValue;
}

/**
 * 通知を永続化し、SSE 購読者へリアルタイム配信する。
 * 重要度 WARNING / CRITICAL (と業者チャットの受信・返信案準備) は Web Push でも端末へ送る。
 * プッシュは待たずにバックグラウンドで実行し、失敗しても呼び出し元へは影響させない。
 */
export async function notify(input: CreateNotificationInput) {
  const n = await prisma.notification.create({
    data: { ...input, severity: input.severity ?? "INFO" },
  });
  await publishNotification({
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    link: n.link,
    createdAt: n.createdAt.toISOString(),
  }).catch((e) => console.error("[notif] publish failed", e));
  void pushForNotification(n).catch((e) => console.error("[notif] push failed", e));
  return n;
}
