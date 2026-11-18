import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalGuardError,
  BlacklistedSupplierError,
  ConcurrentModificationError,
  approveForSending,
  attachDraft,
  createManualOutbound,
  rejectMessage,
  sendApprovedMessage,
} from "@/lib/chat/service";
import {
  HandoffSupplierAdapter,
  InvalidChatUrlError,
  MockSupplierAdapter,
  __resetSupplierAdapterForTest,
  getSupplierAdapter,
  normalizeChatUrl,
  selectSupplierAdapterKind,
  sendModeOf,
} from "@/lib/suppliers";
import { AlibabaSupplierAdapter } from "@/lib/suppliers/alibabaAdapter";
import { FakeChatDb } from "./helpers/fakeChatDb";

describe("HandoffSupplierAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ネットワーク I/O を行わず handoff:<冪等キー> を返す", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const a = new HandoffSupplierAdapter();
    expect(a.name).toBe("handoff");
    expect(a.isExternal).toBe(false);
    const r = await a.sendMessage({ supplierExternalId: "ext", threadId: "t", text: "hello", idempotencyKey: "msg9" });
    expect(r.externalMsgId).toBe("handoff:msg9");
    expect(r.sentAt).toBeInstanceOf(Date);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("アダプター選択", () => {
  it.each([
    ["handoff", "production", "handoff"],
    ["handoff", "development", "handoff"],
    ["alibaba", "production", "alibaba"],
    ["alibaba", "development", "mock"],
    ["mock", "production", "mock"],
    ["", "production", "mock"],
    ["handoff", "test", "mock"],
    ["alibaba", "test", "mock"],
  ] as const)("SUPPLIER_ADAPTER=%s, NODE_ENV=%s → %s", (adapter, nodeEnv, expected) => {
    expect(selectSupplierAdapterKind(adapter, nodeEnv)).toBe(expected);
  });

  it("テスト環境では SUPPLIER_ADAPTER=handoff でも Mock が返る", () => {
    const prev = process.env.SUPPLIER_ADAPTER;
    process.env.SUPPLIER_ADAPTER = "handoff";
    __resetSupplierAdapterForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(getSupplierAdapter()).toBeInstanceOf(MockSupplierAdapter);
    } finally {
      process.env.SUPPLIER_ADAPTER = prev;
      __resetSupplierAdapterForTest();
      warn.mockRestore();
    }
  });

  it("UI 向け送信方式", () => {
    expect(sendModeOf(new HandoffSupplierAdapter())).toBe("handoff");
    expect(sendModeOf(new MockSupplierAdapter())).toBe("mock");
    expect(sendModeOf(new AlibabaSupplierAdapter())).toBe("external");
  });
});

describe("手渡し送信フロー (承認 → 業者アプリで送信 → 送信しました)", () => {
  let db: FakeChatDb;
  let adapter: HandoffSupplierAdapter;

  beforeEach(() => {
    db = new FakeChatDb();
    db.seedSupplier();
    adapter = new HandoffSupplierAdapter();
  });

  it("承認すると APPROVED (approvedAt/approvedBy あり) で止まり、何も送信されない", async () => {
    db.seedMessage();
    const d = await attachDraft(db, "msg1", { draftText: "Can you do 1.90 USD?", draftTextJa: null, source: "MANUAL" }, "alice");
    const send = vi.spyOn(adapter, "sendMessage");
    const a = await approveForSending(db, "msg1", { expectedVersion: d.version, finalText: "Can you do 1.85 USD?" }, "alice");
    expect(a).toMatchObject({ status: "APPROVED", approvedBy: "alice", finalText: "Can you do 1.85 USD?", sentAt: null, externalMsgId: null });
    expect(a.approvedAt).toBeInstanceOf(Date);
    expect(send).not.toHaveBeenCalled();
    expect(db.audits.map((x) => x.action)).toEqual(["chat.draft.manual", "chat.approve"]);
  });

  it("「送信しました」でガードを通して SENT (externalMsgId=handoff:<id>) を記録する", async () => {
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t1", text: "您好", textJa: "こんにちは", lang: "zh" }, "alice");
    await approveForSending(db, out.id, { expectedVersion: out.version }, "alice");
    const sent = await sendApprovedMessage(db, adapter, out.id, "alice");
    expect(sent.status).toBe("SENT");
    expect(sent.externalMsgId).toBe(`handoff:${out.id}`);
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.approvedBy).toBe("alice");
    expect(db.audits.map((x) => x.action)).toEqual(["chat.compose", "chat.approve", "chat.send.start", "chat.send.success"]);
    expect(db.audits.find((x) => x.action === "chat.send.start")?.after).toMatchObject({ adapter: "handoff" });

    // 二重報告はガードで拒否
    await expect(sendApprovedMessage(db, adapter, out.id, "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
  });

  it("承認なしで「送信しました」は ApprovalGuardError (状態は変わらない)", async () => {
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t1", text: "hello", textJa: null, lang: "en" }, "alice");
    const send = vi.spyOn(adapter, "sendMessage");
    await expect(sendApprovedMessage(db, adapter, out.id, "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    expect(send).not.toHaveBeenCalled();
    expect(db.messages.get(out.id)!.status).toBe("DRAFT_READY");
    expect(db.messages.get(out.id)!.externalMsgId).toBeNull();
  });

  it("「まだ送っていない / 取り消す」で REJECTED に戻り、以後の送信報告は拒否・再ドラフト可能", async () => {
    db.seedMessage();
    const d = await attachDraft(db, "msg1", { draftText: "x", draftTextJa: null, source: "AI" }, "ai");
    const a = await approveForSending(db, "msg1", { expectedVersion: d.version }, "alice");
    const r = await rejectMessage(db, "msg1", { expectedVersion: a.version, reason: "承認取消 (未送信)" }, "alice");
    expect(r).toMatchObject({ status: "REJECTED", approvedAt: null, approvedBy: null, finalText: null });
    await expect(sendApprovedMessage(db, adapter, "msg1", "alice")).rejects.toBeInstanceOf(ApprovalGuardError);
    const again = await attachDraft(db, "msg1", { draftText: "y", draftTextJa: null, source: "MANUAL" }, "alice");
    expect(again.status).toBe("DRAFT_READY");
  });

  it("ブラックリスト業者は承認前に拒否し、承認記録を残さない", async () => {
    db.seedSupplier({ isBlacklisted: true });
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t", text: "hello", textJa: null, lang: "en" }, "alice");
    await expect(approveForSending(db, out.id, { expectedVersion: out.version }, "alice")).rejects.toBeInstanceOf(BlacklistedSupplierError);
    const row = db.messages.get(out.id)!;
    expect(row.status).toBe("DRAFT_READY");
    expect(row.approvedAt).toBeNull();
    expect(row.approvedBy).toBeNull();
  });

  it("承認後にブラックリスト登録された場合も「送信しました」は拒否される", async () => {
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t", text: "hello", textJa: null, lang: "en" }, "alice");
    await approveForSending(db, out.id, { expectedVersion: out.version }, "alice");
    db.seedSupplier({ isBlacklisted: true });
    await expect(sendApprovedMessage(db, adapter, out.id, "alice")).rejects.toBeInstanceOf(BlacklistedSupplierError);
    expect(db.messages.get(out.id)!.status).toBe("APPROVED");
  });

  it("古い version での承認は ConcurrentModificationError", async () => {
    const out = await createManualOutbound(db, { supplierId: "sup1", threadId: "t", text: "hello", textJa: null, lang: "en" }, "alice");
    await expect(approveForSending(db, out.id, { expectedVersion: out.version + 1 }, "alice")).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});

describe("業者チャット URL の検証", () => {
  it("http/https を受け付け、空は解除 (null)", () => {
    expect(normalizeChatUrl("https://message.alibaba.com/msgsend/contact.htm?id=1")).toBe("https://message.alibaba.com/msgsend/contact.htm?id=1");
    expect(normalizeChatUrl("  http://example.com  ")).toBe("http://example.com/");
    expect(normalizeChatUrl("")).toBeNull();
    expect(normalizeChatUrl(null)).toBeNull();
  });

  it.each(["javascript:alert(1)", "ftp://example.com", "weixin://dl/chat", "example.com", "data:text/html,x"])("%s は拒否", (v) => {
    expect(() => normalizeChatUrl(v)).toThrow(InvalidChatUrlError);
  });
});
