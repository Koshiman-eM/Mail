import { db } from "../db.js";
import type { Account, MessageSource } from "../types.js";

interface AccountRow {
  id: number;
  provider: MessageSource;
  label: string;
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
  created_at: string;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiryDate: row.expiry_date,
    createdAt: row.created_at,
  };
}

export function listAccounts(): Account[] {
  const rows = db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all() as unknown as AccountRow[];
  return rows.map(toAccount);
}

export function getAccountByProvider(provider: MessageSource): Account | null {
  const row = db
    .prepare("SELECT * FROM accounts WHERE provider = ? ORDER BY created_at DESC LIMIT 1")
    .get(provider) as AccountRow | undefined;
  return row ? toAccount(row) : null;
}

export function upsertGoogleAccount(params: {
  label: string;
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number | null;
}): Account {
  const existing = getAccountByProvider("gmail");
  if (existing) {
    db.prepare(
      `UPDATE accounts SET label = ?, access_token = ?, refresh_token = COALESCE(?, refresh_token), expiry_date = ? WHERE id = ?`
    ).run(params.label, params.accessToken, params.refreshToken, params.expiryDate, existing.id);
    return getAccountByProvider("gmail")!;
  }
  db.prepare(
    `INSERT INTO accounts (provider, label, access_token, refresh_token, expiry_date) VALUES ('gmail', ?, ?, ?, ?)`
  ).run(params.label, params.accessToken, params.refreshToken, params.expiryDate);
  return getAccountByProvider("gmail")!;
}
