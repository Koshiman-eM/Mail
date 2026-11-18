/**
 * Web Push の純粋ロジック (DB・ネットワークに依存しない)。
 * Next.js 固有のモジュールを import しないこと (ワーカープロセスからも使われる)。
 */

export type PushSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface PushPayload {
  title: string;
  body: string;
  /** 通知タップ時に開くアプリ内パス (同一オリジンの "/..." のみ) */
  url: string;
  /** 同じ tag の通知は端末上で置き換えられる */
  tag: string;
  severity: PushSeverity;
}

export interface NotificationLike {
  id: string;
  type: string;
  severity: PushSeverity;
  title: string;
  body?: string | null;
  link?: string | null;
}

/** INFO でもプッシュする通知種別 (業者からの受信・返信案の準備完了) */
const INFO_PUSH_TYPES = new Set(["CHAT_RECEIVED", "DRAFT_READY"]);

/** この通知を端末へプッシュすべきか */
export function shouldPush(n: Pick<NotificationLike, "type" | "severity">): boolean {
  if (n.severity === "WARNING" || n.severity === "CRITICAL") return true;
  return INFO_PUSH_TYPES.has(n.type);
}

const MAX_TITLE = 80;
const MAX_BODY = 180;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * 通知リンクを安全なアプリ内パスに正規化する。
 * 外部 URL やプロトコル相対 URL ("//evil") はトップページに置き換える。
 */
export function safeAppPath(link: string | null | undefined): string {
  if (!link) return "/";
  const s = link.trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return "/";
  return s;
}

/** 保存済みの通知からプッシュ送信用ペイロードを組み立てる */
export function buildPushPayload(n: NotificationLike): PushPayload {
  return {
    title: truncate(n.title.trim() || "越境せどり", MAX_TITLE),
    body: truncate((n.body ?? "").trim(), MAX_BODY),
    url: safeAppPath(n.link),
    tag: `notif-${n.id}`,
    severity: n.severity,
  };
}

/** 送信オプション: 24 時間で失効。CRITICAL は高優先度 (端末のスリープ中でも即時配信を要求) */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

export function pushRequestOptions(severity: PushSeverity): { TTL: number; urgency: "high" | "normal" } {
  return { TTL: PUSH_TTL_SECONDS, urgency: severity === "CRITICAL" ? "high" : "normal" };
}

/** 連続失敗がこの回数に達した購読は削除する */
export const MAX_PUSH_FAILURES = 5;

export type FailureAction = { action: "delete"; reason: "gone" | "too-many-failures" } | { action: "increment"; failures: number };

/**
 * 送信失敗時の購読の扱いを決める。
 * - 404 / 410: 購読が失効 (ブラウザ側で解除・アンインストール) → 即削除
 * - それ以外: 失敗回数を加算し、連続 MAX_PUSH_FAILURES 回で削除
 */
export function decideOnFailure(statusCode: number | undefined, currentFailures: number): FailureAction {
  if (statusCode === 404 || statusCode === 410) return { action: "delete", reason: "gone" };
  const failures = currentFailures + 1;
  if (failures >= MAX_PUSH_FAILURES) return { action: "delete", reason: "too-many-failures" };
  return { action: "increment", failures };
}
