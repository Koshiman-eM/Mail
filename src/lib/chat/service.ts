import type { SupplierAdapter } from "../suppliers/adapter";
import { assertTransition, type ChatStatus } from "./stateMachine";
import type { ChatDb, ChatMessageRow, ChatTx } from "./types";

/** 承認ガードレール違反。送信直前の再検証で APPROVED / approvedAt が満たされない場合に送出 */
export class ApprovalGuardError extends Error {
  constructor(message: string, public readonly messageId: string) {
    super(message);
    this.name = "ApprovalGuardError";
  }
}

/** 楽観ロック競合 (別タブ・別ユーザーが先に更新した) */
export class ConcurrentModificationError extends Error {
  constructor(public readonly messageId: string) {
    super(`メッセージ ${messageId} は他の操作で更新されています。再読み込みしてください`);
    this.name = "ConcurrentModificationError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} が見つかりません`);
    this.name = "NotFoundError";
  }
}

export class BlacklistedSupplierError extends Error {
  constructor(supplierName: string) {
    super(`ブラックリスト登録済みの業者 (${supplierName}) へは送信できません`);
    this.name = "BlacklistedSupplierError";
  }
}

async function load(tx: ChatTx, id: string): Promise<ChatMessageRow> {
  const row = await tx.chatMessage.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(`ChatMessage(${id})`);
  return row;
}

/**
 * 状態と version が読み取り時から変わっていないことを条件に更新する (compare-and-swap)。
 * count !== 1 は他トランザクションによる先行更新を意味する。
 */
async function casUpdate(
  tx: ChatTx,
  row: ChatMessageRow,
  to: ChatStatus,
  data: Record<string, unknown>,
  extraWhere: Record<string, unknown> = {},
): Promise<void> {
  assertTransition(row.status, to);
  const res = await tx.chatMessage.updateMany({
    where: { id: row.id, status: row.status, version: row.version, ...extraWhere },
    data: { ...data, status: to, version: { increment: 1 } },
  });
  if (res.count !== 1) throw new ConcurrentModificationError(row.id);
}

async function audit(tx: ChatTx, actor: string, action: string, id: string, before: unknown, after: unknown) {
  await tx.auditLog.create({
    data: { actor, action, entityType: "ChatMessage", entityId: id, before, after },
  });
}

/** AI ドラフトを添付し DRAFT_READY にする。既存の承認情報は必ずクリアする。 */
export async function attachDraft(
  db: ChatDb,
  id: string,
  draft: { draftText: string; draftTextJa: string },
  actor: string,
): Promise<ChatMessageRow> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, id);
    await casUpdate(tx, row, "DRAFT_READY", {
      draftText: draft.draftText,
      draftTextJa: draft.draftTextJa,
      finalText: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
    });
    await audit(tx, actor, "chat.draft", id, { status: row.status }, { status: "DRAFT_READY" });
    return load(tx, id);
  });
}

/**
 * 人間による承認。送信本文 (finalText) はこの時点で確定し、以後の変更は再ドラフト→再承認が必要。
 */
export async function approveMessage(
  db: ChatDb,
  id: string,
  opts: { expectedVersion: number; finalText?: string },
  actor: string,
): Promise<ChatMessageRow> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, id);
    if (row.version !== opts.expectedVersion) throw new ConcurrentModificationError(id);
    const finalText = (opts.finalText ?? row.draftText ?? "").trim();
    if (!finalText) throw new Error("送信本文が空のため承認できません");
    const approvedAt = new Date();
    await casUpdate(tx, row, "APPROVED", { finalText, approvedBy: actor, approvedAt });
    await audit(tx, actor, "chat.approve", id, { status: row.status, draftText: row.draftText }, { status: "APPROVED", finalText, approvedAt });
    return load(tx, id);
  });
}

export async function rejectMessage(
  db: ChatDb,
  id: string,
  opts: { expectedVersion: number; reason?: string },
  actor: string,
): Promise<ChatMessageRow> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, id);
    if (row.version !== opts.expectedVersion) throw new ConcurrentModificationError(id);
    await casUpdate(tx, row, "REJECTED", {
      rejectedReason: opts.reason ?? null,
      approvedBy: null,
      approvedAt: null,
      finalText: null,
    });
    await audit(tx, actor, "chat.reject", id, { status: row.status }, { status: "REJECTED", reason: opts.reason });
    return load(tx, id);
  });
}

/**
 * 承認済みメッセージを送信する。
 *
 * ガードレール:
 *  1. トランザクション内で最新行を再取得し、status === APPROVED かつ approvedAt !== null を再検証。
 *     満たさなければ ApprovalGuardError をスローし、アダプターは一切呼ばない。
 *  2. 同条件 (status/approvedAt/version) を WHERE に含めた CAS で SENDING へ遷移し、二重送信を防ぐ。
 *  3. 外部送信は DB トランザクション外で行い、結果を別トランザクションで SENT / SEND_FAILED に記録。
 */
export async function sendApprovedMessage(
  db: ChatDb,
  adapter: SupplierAdapter,
  id: string,
  actor: string,
): Promise<ChatMessageRow> {
  const claimed = await db.$transaction(async (tx) => {
    const row = await load(tx, id);
    if (row.status !== "APPROVED" || row.approvedAt === null) {
      throw new ApprovalGuardError(
        `承認済み (APPROVED かつ approvedAt あり) のメッセージのみ送信できます (status=${row.status}, approvedAt=${row.approvedAt?.toISOString() ?? "null"})`,
        id,
      );
    }
    if (!row.finalText || !row.finalText.trim()) {
      throw new ApprovalGuardError("承認済み送信本文 (finalText) が空です", id);
    }
    const supplier = await tx.supplier.findUnique({ where: { id: row.supplierId } });
    if (!supplier) throw new NotFoundError(`Supplier(${row.supplierId})`);
    if (supplier.isBlacklisted) throw new BlacklistedSupplierError(supplier.name);

    try {
      await casUpdate(tx, row, "SENDING", {}, { approvedAt: { not: null } });
    } catch (e) {
      if (e instanceof ConcurrentModificationError) {
        throw new ApprovalGuardError("送信直前の再検証で承認状態が変化していました", id);
      }
      throw e;
    }
    await audit(tx, actor, "chat.send.start", id, { status: "APPROVED" }, { status: "SENDING", adapter: adapter.name });
    return { row: { ...row, status: "SENDING" as const, version: row.version + 1 }, supplier };
  });

  try {
    const result = await adapter.sendMessage({
      supplierExternalId: claimed.supplier.externalId,
      threadId: claimed.row.threadId,
      text: claimed.row.finalText!,
      idempotencyKey: claimed.row.id,
    });
    return await db.$transaction(async (tx) => {
      const row = await load(tx, id);
      await casUpdate(tx, row, "SENT", { sentAt: result.sentAt, externalMsgId: result.externalMsgId });
      await audit(tx, actor, "chat.send.success", id, { status: "SENDING" }, { status: "SENT", externalMsgId: result.externalMsgId });
      return load(tx, id);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.$transaction(async (tx) => {
      const row = await load(tx, id);
      if (row.status !== "SENDING") return;
      await casUpdate(tx, row, "SEND_FAILED", {});
      await audit(tx, actor, "chat.send.failure", id, { status: "SENDING" }, { status: "SEND_FAILED", error: message });
      await tx.notification.create({
        data: {
          type: "SEND_FAILED",
          severity: "CRITICAL",
          title: `${claimed.supplier.name} への送信に失敗しました`,
          body: message,
          link: `/chat?thread=${encodeURIComponent(row.threadId)}`,
          meta: { messageId: id },
        },
      });
    });
    throw err;
  }
}
