import { EventEmitter } from "node:events";
import IORedis from "ioredis";
import { env } from "../env";

/**
 * 通知のプロセス間配信バス。
 * - ワーカー (別プロセス) で発生した通知も Next.js の SSE に届くよう Redis Pub/Sub を使う。
 * - REDIS_URL 未設定時はプロセス内 EventEmitter のみで動作。
 */
export const NOTIFICATION_CHANNEL = "sedori:notifications";

export interface NotificationEvent {
  id: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
}

const g = globalThis as unknown as {
  __notifEmitter?: EventEmitter;
  __notifPub?: IORedis;
  __notifSubStarted?: boolean;
};

const emitter = (g.__notifEmitter ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  return e;
})());

function publisher(): IORedis | undefined {
  if (!env.redisUrl) return undefined;
  return (g.__notifPub ??= new IORedis(env.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }));
}

function ensureSubscriber() {
  if (!env.redisUrl || g.__notifSubStarted) return;
  g.__notifSubStarted = true;
  const sub = new IORedis(env.redisUrl);
  sub.subscribe(NOTIFICATION_CHANNEL).catch((e) => console.error("[notif] subscribe failed", e));
  sub.on("message", (_ch, raw) => {
    try {
      emitter.emit("notification", JSON.parse(raw) as NotificationEvent);
    } catch {
      /* ignore malformed */
    }
  });
}

export async function publishNotification(ev: NotificationEvent): Promise<void> {
  const pub = publisher();
  if (pub) {
    // Redis 経由で全プロセス (自プロセス含む) に配信される
    await pub.publish(NOTIFICATION_CHANNEL, JSON.stringify(ev));
  } else {
    emitter.emit("notification", ev);
  }
}

export function subscribeNotifications(fn: (ev: NotificationEvent) => void): () => void {
  ensureSubscriber();
  emitter.on("notification", fn);
  return () => emitter.off("notification", fn);
}
