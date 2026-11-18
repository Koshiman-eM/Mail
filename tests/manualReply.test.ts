import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalGuardError,
  BlacklistedSupplierError,
  ConcurrentModificationError,
  approveAndSend,
  attachDraft,
  createManualOutbound,
  sendApprovedMessage,
} from "@/lib/chat/service";
import { MockSupplierAdapter } from "@/lib/suppliers";
import { FakeChatDb } from "./helpers/fakeChatDb";

describe("手動返信", () => {
  let db: FakeChatDb;
  let adapter: MockSupplierAdapter;

  beforeEach(() => {
    db = new FakeChatDb();
    db.seedSupplier();
    adapter = new MockSupplierAdapter();
  });

  it("受信メッセージに自分で書いた返信を付けると MANUAL として DRAFT_READY", async () => {
    db.seedMessage();
    const m = await attachDraft(db, "msg1", { draftText: "Can you do 1.90 USD?", draftTextJa: "1.90ドルにできますか？", source: "MANUAL" }, "alice");
    expect(m).toMatchObject({ status: "DRAFT_READY", draftSource: "MANUAL", approvedAt: null });
    expect(db.audits.at(-1)?.action).toBe("chat.draft.manual");
  });

  it("承認して送信: 承認記録を残してからガード付きで送信する", async () => {
    db.seedMessage();
    const d = await attachDraft(db, "msg1", { draftText: "Can you do 1.90 USD?", draftTextJa: null, source: "MANUAL" }, "alice");
    const sent = await approveAndSend(db, adapter, "msg1", { expectedVersion: d.version }, "alice");
    expect(sent.status).toBe("SENT");
    expect(sent.approvedBy).toBe("alice");
    expect(sent.approvedAt).toBeInstanceOf(Date);
    expect(adapter.sent.map((s) => s.text)).toEqual(["Can you do 1.90 USD?"]);
    expect(db.audits.map((a) => a.action)).toEqual(["chat.draft.manual", "chat.approve", "chat.send.start", "chat.send.success"]);
  });

  it("こちらから新規メッセージを作成して送信できる (受信メッセージ不要)", async () => {
    const out = await createManualOutbound(
      db,
      { supplierId: "sup1", threadId: "new-thread", text: "您好，请问这款可以做OEM吗？", textJa: "こんにちは、この商品は OEM 対応できますか？", lang: "zh" },
      "alice",
    );
    expect(out).toMatchObject({ direction: "OUTBOUND", status: "DRAFT_READY", draftSource: "MANUAL", approvedAt: null });
    // 承認なしの直接送信はガードで拒否
    await expect(sendApprovedMessage(db, adapter, out.id, "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(adapter.sent).toHaveLength(0);

    const sent = await approveAndSend(db, adapter, out.id, { expectedVersion: out.version }, "alice");
    expect(sent.status).toBe("SENT");
    expect(adapter.sent[0].threadId).toBe("new-thread");
  });

  it("古い version では承認も送信も行わない", async () => {
    db.seedMessage();
    const d = await attachDraft(db, "msg1", { draftText: "x", draftTextJa: null, source: "MANUAL" }, "alice");
    const send = vi.spyOn(adapter, "sendMessage");
    await expect(approveAndSend(db, adapter, "msg1", { expectedVersion: d.version - 1 }, "alice")).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(send).not.toHaveBeenCalled();
    expect(db.messages.get("msg1")!.status).toBe("DRAFT_READY");
  });

  it("ブラックリスト業者には承認して送信でも送らず、承認記録も残さない", async () => {
    db.seedSupplier({ isBlacklisted: true });
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t", text: "hello", textJa: null, lang: "en" }, "alice");
    await expect(approveAndSend(db, adapter, out.id, { expectedVersion: out.version }, "alice")).rejects.toBeInstanceOf(BlacklistedSupplierError);
    expect(adapter.sent).toHaveLength(0);
    expect(db.messages.get(out.id)!.status).toBe("DRAFT_READY");
    expect(db.messages.get(out.id)!.approvedAt).toBeNull();
  });

  it("空の本文は作成・添付できない", async () => {
    db.seedMessage();
    await expect(createManualOutbound(db, { supplierId: "sup1", threadId: "t", text: "  ", textJa: null, lang: null }, "a")).rejects.toThrow();
    await expect(attachDraft(db, "msg1", { draftText: " ", draftTextJa: null, source: "MANUAL" }, "a")).rejects.toThrow();
  });
});
