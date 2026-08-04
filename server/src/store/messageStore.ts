import { db } from "../db.js";
import type { MessageSource, UnifiedMessage } from "../types.js";

interface MessageRow {
  id: number;
  source: MessageSource;
  external_id: string;
  account_id: number | null;
  sender: string;
  subject: string | null;
  body: string;
  received_at: string;
  processed: number;
  created_at: string;
}

function toMessage(row: MessageRow): UnifiedMessage {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    accountId: row.account_id,
    sender: row.sender,
    subject: row.subject,
    body: row.body,
    receivedAt: row.received_at,
    processed: Boolean(row.processed),
    createdAt: row.created_at,
  };
}

export function messageExists(source: MessageSource, externalId: string): boolean {
  const row = db
    .prepare("SELECT id FROM messages WHERE source = ? AND external_id = ?")
    .get(source, externalId);
  return Boolean(row);
}

export function insertMessage(params: {
  source: MessageSource;
  externalId: string;
  accountId: number | null;
  sender: string;
  subject: string | null;
  body: string;
  receivedAt: string;
}): UnifiedMessage {
  const info = db
    .prepare(
      `INSERT INTO messages (source, external_id, account_id, sender, subject, body, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.source,
      params.externalId,
      params.accountId,
      params.sender,
      params.subject,
      params.body,
      params.receivedAt
    );
  return getMessage(Number(info.lastInsertRowid))!;
}

export function getMessage(id: number): UnifiedMessage | null {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  return row ? toMessage(row) : null;
}

export function markProcessed(id: number): void {
  db.prepare("UPDATE messages SET processed = 1 WHERE id = ?").run(id);
}

export function listMessages(limit = 100): UnifiedMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages ORDER BY received_at DESC LIMIT ?")
    .all(limit) as unknown as MessageRow[];
  return rows.map(toMessage);
}
