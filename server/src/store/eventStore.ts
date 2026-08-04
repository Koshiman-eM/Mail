import { db } from "../db.js";
import type { Confidence, DetectedEvent, EventStatus } from "../types.js";

interface EventRow {
  id: number;
  message_id: number;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  confidence: Confidence;
  status: EventStatus;
  calendar_event_id: string | null;
  created_at: string;
}

function toEvent(row: EventRow): DetectedEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    location: row.location,
    confidence: row.confidence,
    status: row.status,
    calendarEventId: row.calendar_event_id,
    createdAt: row.created_at,
  };
}

export function insertEvent(params: {
  messageId: number;
  title: string;
  startAt: string;
  endAt: string | null;
  location: string | null;
  confidence: Confidence;
  status: EventStatus;
}): DetectedEvent {
  const info = db
    .prepare(
      `INSERT INTO events (message_id, title, start_at, end_at, location, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.messageId,
      params.title,
      params.startAt,
      params.endAt,
      params.location,
      params.confidence,
      params.status
    );
  return getEvent(Number(info.lastInsertRowid))!;
}

export function getEvent(id: number): DetectedEvent | null {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  return row ? toEvent(row) : null;
}

export function updateEventStatus(
  id: number,
  status: EventStatus,
  calendarEventId: string | null = null
): void {
  db.prepare("UPDATE events SET status = ?, calendar_event_id = COALESCE(?, calendar_event_id) WHERE id = ?").run(
    status,
    calendarEventId,
    id
  );
}

export function listEvents(limit = 100): DetectedEvent[] {
  const rows = db
    .prepare("SELECT * FROM events ORDER BY start_at DESC LIMIT ?")
    .all(limit) as unknown as EventRow[];
  return rows.map(toEvent);
}
