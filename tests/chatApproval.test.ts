import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalGuardError,
  BlacklistedSupplierError,
  ConcurrentModificationError,
  approveMessage,
  attachDraft,
  rejectMessage,
  sendApprovedMessage,
} from "@/lib/chat/service";
import { InvalidTransitionError, canTransition } from "@/lib/chat/stateMachine";
import { MockSupplierAdapter, getSupplierAdapter, __resetSupplierAdapterForTest } from "@/lib/suppliers";
import { FakeChatDb } from "./helpers/fakeChatDb";

const draft = { draftText: "Could you offer USD 2.10 at 300 pcs?", draftTextJa: "300個で2.10ドルは可能ですか？" };

describe("チャット承認ステートマシン", () => {
  it("定義された遷移のみ許可する", () => {
    expect(canTransition("RECEIVED", "DRAFT_READY")).toBe(true);
    expect(canTransition("DRAFT_READY", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "SENDING")).toBe(true);
    expect(canTransition("SENDING", "SENT")).toBe(true);
    expect(canTransition("RECEIVED", "SENDING")).toBe(false);
    expect(canTransition("DRAFT_READY", "SENDING")).toBe(false);
    expect(canTransition("REJECTED", "SENDING")).toBe(false);
    expect(canTransition("SEND_FAILED", "SENDING")).toBe(false);
    expect(canTransition("SENT", "DRAFT_READY")).toBe(false);
  });
});

describe("承認・送信フロー", () => {
  let db: FakeChatDb;
  let adapter: MockSupplierAdapter;

  beforeEach(() => {
    db = new FakeChatDb();
    db.seedSupplier();
    db.seedMessage();
    adapter = new MockSupplierAdapter();
  });

  it("RECEIVED → DRAFT_READY → APPROVED → SENT を通過し、監査ログを残す", async () => {
    let m = await attachDraft(db, "msg1", draft, "alice");
    expect(m.status).toBe("DRAFT_READY");
    m = await approveMessage(db, "msg1", { expectedVersion: m.version, finalText: "Could you offer USD 2.05 at 300 pcs?" }, "alice");
    expect(m.status).toBe("APPROVED");
    expect(m.approvedAt).toBeInstanceOf(Date);
    expect(m.approvedBy).toBe("alice");

    m = await sendApprovedMessage(db, adapter, "msg1", "alice");
    expect(m.status).toBe("SENT");
    expect(m.externalMsgId).toMatch(/^mock-/);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].text).toBe("Could you offer USD 2.05 at 300 pcs?");
    expect(db.audits.map((a) => a.action)).toEqual([
      "chat.draft",
      "chat.approve",
      "chat.send.start",
      "chat.send.success",
    ]);
  });

  it.each(["RECEIVED", "DRAFT_READY", "REJECTED", "SEND_FAILED", "SENT"] as const)(
    "status=%s のメッセージ送信は ApprovalGuardError となり外部送信しない",
    async (status) => {
      db.seedMessage({ status, draftText: draft.draftText, finalText: draft.draftText, approvedAt: new Date() });
      await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
      expect(adapter.sent).toHaveLength(0);
      expect(db.messages.get("msg1")!.status).toBe(status);
    },
  );

  it("status=APPROVED でも approvedAt が null なら ApprovalGuardError", async () => {
    db.seedMessage({ status: "APPROVED", finalText: "hello", approvedAt: null });
    const send = vi.spyOn(adapter, "sendMessage");
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(send).not.toHaveBeenCalled();
    expect(db.messages.get("msg1")!.status).toBe("APPROVED");
  });

  it("読み取り後・更新前に承認が取り消された場合 (競合) も ApprovalGuardError で送信しない", async () => {
    db.seedMessage({ status: "APPROVED", finalText: "hello", approvedAt: new Date(), version: 3 });
    db.onAfterFind = (id) => {
      // 別トランザクションが割り込んで却下したことを再現
      const r = db.messages.get(id)!;
      r.status = "REJECTED";
      r.approvedAt = null;
      r.version += 1;
      db.onAfterFind = undefined;
    };
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("二重送信リクエストは2回目が ApprovalGuardError になる", async () => {
    db.seedMessage({ status: "APPROVED", finalText: "hello", approvedAt: new Date() });
    await sendApprovedMessage(db, adapter, "msg1", "alice");
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(adapter.sent).toHaveLength(1);
  });

  it("finalText が空なら承認済みでも送信しない", async () => {
    db.seedMessage({ status: "APPROVED", finalText: "  ", approvedAt: new Date() });
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("ブラックリスト業者へは送信しない", async () => {
    db.seedSupplier({ isBlacklisted: true });
    db.seedMessage({ status: "APPROVED", finalText: "hello", approvedAt: new Date() });
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(BlacklistedSupplierError);
    expect(adapter.sent).toHaveLength(0);
    expect(db.messages.get("msg1")!.status).toBe("APPROVED");
  });

  it("送信失敗時は SEND_FAILED と CRITICAL 通知、再送には再ドラフト・再承認が必要", async () => {
    db.seedMessage({ status: "APPROVED", finalText: "hello", approvedAt: new Date() });
    adapter.failNextWith(new Error("network down"));
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toThrow("network down");
    const row = db.messages.get("msg1")!;
    expect(row.status).toBe("SEND_FAILED");
    expect(db.notifications[0]).toMatchObject({ type: "SEND_FAILED", severity: "CRITICAL" });

    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    const redrafted = await attachDraft(db, "msg1", draft, "alice");
    expect(redrafted.approvedAt).toBeNull();
    expect(redrafted.finalText).toBeNull();
  });

  it("却下すると承認情報がクリアされ送信不可", async () => {
    const d = await attachDraft(db, "msg1", draft, "alice");
    const a = await approveMessage(db, "msg1", { expectedVersion: d.version }, "alice");
    const r = await rejectMessage(db, "msg1", { expectedVersion: a.version, reason: "価格が高すぎる" }, "bob");
    expect(r.status).toBe("REJECTED");
    expect(r.approvedAt).toBeNull();
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
  });

  it("古い version での承認は ConcurrentModificationError", async () => {
    const d = await attachDraft(db, "msg1", draft, "alice");
    await expect(approveMessage(db, "msg1", { expectedVersion: d.version - 1 }, "alice")).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
  });

  it("RECEIVED から直接承認はできない", async () => {
    await expect(approveMessage(db, "msg1", { expectedVersion: 0, finalText: "x" }, "alice")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });
});

describe("外部誤送信防止", () => {
  it("テスト環境では SUPPLIER_ADAPTER=alibaba でも Mock が返る", () => {
    const prev = process.env.SUPPLIER_ADAPTER;
    process.env.SUPPLIER_ADAPTER = "alibaba";
    __resetSupplierAdapterForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = getSupplierAdapter();
      expect(a.isExternal).toBe(false);
      expect(a).toBeInstanceOf(MockSupplierAdapter);
    } finally {
      process.env.SUPPLIER_ADAPTER = prev;
      __resetSupplierAdapterForTest();
      warn.mockRestore();
    }
  });
});
