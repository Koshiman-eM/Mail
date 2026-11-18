/**
 * 業者チャット承認ステートマシン
 *
 *   RECEIVED ──▶ DRAFT_READY ──▶ APPROVED ──▶ SENDING ──▶ SENT
 *                  ▲    │            │            │
 *                  │    ▼            ▼            ▼
 *                  └─ REJECTED ◀─────┘       SEND_FAILED ──▶ DRAFT_READY (再承認が必要)
 *
 * - 送信 (SENDING) へ遷移できるのは APPROVED からのみ。
 * - 送信失敗後の再送は必ずドラフトへ戻し、人間の再承認を経由させる。
 */
export const CHAT_STATUSES = [
  "RECEIVED",
  "DRAFT_READY",
  "APPROVED",
  "REJECTED",
  "SENDING",
  "SENT",
  "SEND_FAILED",
] as const;
export type ChatStatus = (typeof CHAT_STATUSES)[number];

export const TRANSITIONS: Readonly<Record<ChatStatus, readonly ChatStatus[]>> = {
  RECEIVED: ["DRAFT_READY"],
  DRAFT_READY: ["DRAFT_READY", "APPROVED", "REJECTED"],
  APPROVED: ["SENDING", "REJECTED"],
  REJECTED: ["DRAFT_READY"],
  SENDING: ["SENT", "SEND_FAILED"],
  SENT: [],
  SEND_FAILED: ["DRAFT_READY"],
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: ChatStatus, public readonly to: ChatStatus) {
    super(`不正な状態遷移です: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ChatStatus, to: ChatStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ChatStatus, to: ChatStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
