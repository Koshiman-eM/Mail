import type { ChatDb, ChatMessageRow, ChatTx, SupplierRow } from "@/lib/chat/types";

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && "not" in cond) {
      return v !== (cond as { not: unknown }).not;
    }
    if (cond instanceof Date && v instanceof Date) return cond.getTime() === v.getTime();
    return v === cond;
  });
}

function apply(row: Record<string, unknown>, data: Where) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
}

/** トランザクションのロールバックを再現するインメモリ DB (チャット承認フローのテスト用) */
export class FakeChatDb implements ChatDb {
  messages = new Map<string, ChatMessageRow>();
  suppliers = new Map<string, SupplierRow>();
  audits: { actor: string; action: string; entityId: string; after?: unknown }[] = [];
  notifications: { type: string; severity: string; title: string }[] = [];
  /** findUnique の直後に割り込ませる処理 (競合状態の再現用) */
  onAfterFind?: (id: string) => void;

  chatMessage: ChatTx["chatMessage"] = {
    findUnique: async ({ where }) => {
      const r = this.messages.get(where.id);
      const copy = r ? { ...r } : null;
      this.onAfterFind?.(where.id);
      return copy;
    },
    updateMany: async ({ where, data }) => {
      let count = 0;
      for (const r of this.messages.values()) {
        if (matches(r as unknown as Record<string, unknown>, where)) {
          apply(r as unknown as Record<string, unknown>, data);
          count++;
        }
      }
      return { count };
    },
    update: async ({ where, data }) => {
      const r = this.messages.get(where.id);
      if (!r) throw new Error("not found");
      apply(r as unknown as Record<string, unknown>, data);
      return { ...r };
    },
  };

  supplier: ChatTx["supplier"] = {
    findUnique: async ({ where }) => this.suppliers.get(where.id) ?? null,
  };

  auditLog: ChatTx["auditLog"] = {
    create: async ({ data }) => {
      this.audits.push(data);
      return data;
    },
  };

  notification: ChatTx["notification"] = {
    create: async ({ data }) => {
      this.notifications.push(data);
      return data;
    },
  };

  async $transaction<T>(fn: (tx: ChatTx) => Promise<T>): Promise<T> {
    const snapshot = {
      messages: new Map([...this.messages].map(([k, v]) => [k, { ...v }])),
      audits: [...this.audits],
      notifications: [...this.notifications],
    };
    try {
      return await fn(this);
    } catch (e) {
      this.messages = snapshot.messages;
      this.audits = snapshot.audits;
      this.notifications = snapshot.notifications;
      throw e;
    }
  }

  seedSupplier(s: Partial<SupplierRow> = {}): SupplierRow {
    const row: SupplierRow = { id: "sup1", externalId: "ext-sup1", name: "Shenzhen Test Co.", isBlacklisted: false, ...s };
    this.suppliers.set(row.id, row);
    return row;
  }

  seedMessage(m: Partial<ChatMessageRow> = {}): ChatMessageRow {
    const now = new Date();
    const row: ChatMessageRow = {
      id: "msg1",
      supplierId: "sup1",
      threadId: "thread1",
      direction: "INBOUND",
      originalText: "您好，最低起订量是500件。",
      originalLang: "zh",
      translatedText: "こんにちは、最低発注数量は500個です。",
      draftText: null,
      draftTextJa: null,
      finalText: null,
      status: "RECEIVED",
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      sentAt: null,
      externalMsgId: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...m,
    };
    this.messages.set(row.id, row);
    return row;
  }
}
