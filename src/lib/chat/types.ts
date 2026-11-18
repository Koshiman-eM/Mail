import type { ChatStatus } from "./stateMachine";

/**
 * チャット承認フローが依存する DB 操作の最小インターフェース。
 * 本番では PrismaClient がそのまま適合し、テストではインメモリ実装を差し込む。
 */
export interface ChatMessageRow {
  id: string;
  supplierId: string;
  threadId: string;
  direction: "INBOUND" | "OUTBOUND";
  originalText: string;
  originalLang: string | null;
  translatedText: string | null;
  draftText: string | null;
  draftTextJa: string | null;
  draftSource: "AI" | "MANUAL" | null;
  finalText: string | null;
  status: ChatStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedReason: string | null;
  sentAt: Date | null;
  externalMsgId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierRow {
  id: string;
  externalId: string;
  name: string;
  isBlacklisted: boolean;
}

type Where = Record<string, unknown>;

export interface ChatTx {
  chatMessage: {
    findUnique(args: { where: { id: string } }): Promise<ChatMessageRow | null>;
    updateMany(args: { where: Where; data: Where }): Promise<{ count: number }>;
    update(args: { where: { id: string }; data: Where }): Promise<ChatMessageRow>;
    create(args: { data: Where }): Promise<ChatMessageRow>;
  };
  supplier: {
    findUnique(args: { where: { id: string } }): Promise<SupplierRow | null>;
  };
  auditLog: {
    create(args: { data: { actor: string; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown } }): Promise<unknown>;
  };
  notification: {
    create(args: { data: { type: string; severity: string; title: string; body?: string; link?: string; meta?: unknown } }): Promise<unknown>;
  };
}

export interface ChatDb extends ChatTx {
  $transaction<T>(fn: (tx: ChatTx) => Promise<T>): Promise<T>;
}
