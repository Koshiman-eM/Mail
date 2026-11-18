import * as webpush from "web-push";
import type { PushSubscription as PushSubscriptionRow } from "@prisma/client";
import { prisma } from "../db/prisma";
import { getVapidKeys, type VapidKeys } from "./vapid";
import { env } from "../env";
import { buildPushPayload, decideOnFailure, pushRequestOptions, shouldPush, type NotificationLike, type PushPayload } from "./payload";

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
}

const EMPTY: PushResult = { sent: 0, removed: 0, failed: 0 };

async function deliverOne(sub: PushSubscriptionRow, payload: PushPayload, keys: VapidKeys): Promise<"sent" | "removed" | "failed"> {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
      ...pushRequestOptions(payload.severity),
      // モジュールの多重読み込みでグローバル設定が失われても送れるよう毎回明示する
      vapidDetails: { subject: env.vapidSubject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    });
    await prisma.pushSubscription.updateMany({ where: { id: sub.id }, data: { failures: 0, lastUsedAt: new Date() } });
    return "sent";
  } catch (e) {
    const status = typeof (e as { statusCode?: unknown })?.statusCode === "number" ? (e as { statusCode: number }).statusCode : undefined;
    const decision = decideOnFailure(status, sub.failures);
    if (decision.action === "delete") {
      await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
      if (decision.reason === "too-many-failures") console.warn(`[push] 連続失敗のため購読を削除しました (${sub.id})`, status ?? e);
      return "removed";
    }
    await prisma.pushSubscription.updateMany({ where: { id: sub.id }, data: { failures: decision.failures } });
    console.warn(`[push] 送信失敗 (${sub.id}, ${decision.failures} 回目)`, status ?? (e instanceof Error ? e.message : e));
    return "failed";
  }
}

async function deliver(where: { userId?: string }, payload: PushPayload): Promise<PushResult> {
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { ...where, user: { disabled: false } } });
    if (subs.length === 0) return { ...EMPTY };
    const keys = await getVapidKeys();
    const results = await Promise.all(subs.map((s) => deliverOne(s, payload, keys).catch(() => "failed" as const)));
    return {
      sent: results.filter((r) => r === "sent").length,
      removed: results.filter((r) => r === "removed").length,
      failed: results.filter((r) => r === "failed").length,
    };
  } catch (e) {
    console.error("[push] 送信処理でエラー", e);
    return { ...EMPTY };
  }
}

/** 無効化されていない全ユーザーの全端末へ送信する。例外は投げない */
export function sendPushToAll(payload: PushPayload): Promise<PushResult> {
  return deliver({}, payload);
}

/** 指定ユーザーの端末にだけ送信する (テスト通知用)。例外は投げない */
export function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  return deliver({ userId }, payload);
}

const pending = new Set<Promise<unknown>>();

/** 通知がプッシュ対象なら全端末へ送る。例外は投げない */
export function pushForNotification(n: NotificationLike): Promise<PushResult> {
  if (!shouldPush(n)) return Promise.resolve({ ...EMPTY });
  const p = sendPushToAll(buildPushPayload(n));
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

/**
 * 実行中のプッシュ送信の完了を待つ (短命なスクリプトが終了する前に呼ぶ)。
 * timeoutMs を過ぎたら待たずに戻る。
 */
export async function flushPendingPushes(timeoutMs = 10_000): Promise<void> {
  if (pending.size === 0) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
}
