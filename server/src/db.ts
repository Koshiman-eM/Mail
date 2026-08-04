import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

if (config.dbPath !== ":memory:") {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expiry_date INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    account_id INTEGER,
    sender TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, external_id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    location TEXT,
    confidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    calendar_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
  CREATE INDEX IF NOT EXISTS idx_events_message_id ON events(message_id);
`);
