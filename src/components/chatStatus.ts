import type { BadgeVariant } from "./ui/badge";

export type ChatStatusKey = "RECEIVED" | "DRAFT_READY" | "APPROVED" | "REJECTED" | "SENDING" | "SENT" | "SEND_FAILED";

export const CHAT_STATUS: Record<ChatStatusKey, { label: string; variant: BadgeVariant }> = {
  RECEIVED: { label: "受信", variant: "secondary" },
  DRAFT_READY: { label: "承認待ち", variant: "warning" },
  APPROVED: { label: "送信待ち", variant: "info" },
  REJECTED: { label: "却下", variant: "outline" },
  SENDING: { label: "送信中", variant: "info" },
  SENT: { label: "送信済み", variant: "success" },
  SEND_FAILED: { label: "送信失敗", variant: "destructive" },
};

/** 承認フローの段階表示用 */
export const FLOW_STEPS: { key: string; label: string; match: ChatStatusKey[] }[] = [
  { key: "received", label: "受信・翻訳", match: ["RECEIVED"] },
  { key: "draft", label: "返信案", match: ["DRAFT_READY", "REJECTED", "SEND_FAILED"] },
  { key: "approved", label: "承認", match: ["APPROVED", "SENDING"] },
  { key: "sent", label: "送信", match: ["SENT"] },
];
