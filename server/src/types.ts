export type MessageSource = "gmail" | "line";

export type EventStatus =
  | "pending" // schedule detected, not yet pushed to Google Calendar
  | "created" // pushed to Google Calendar
  | "dismissed" // user rejected the suggestion
  | "failed"; // attempted to create but Google API call failed

export type Confidence = "high" | "medium" | "low";

export interface UnifiedMessage {
  id: number;
  source: MessageSource;
  externalId: string;
  accountId: number | null;
  sender: string;
  subject: string | null;
  body: string;
  receivedAt: string; // ISO timestamp
  processed: boolean;
  createdAt: string;
}

export interface DetectedEvent {
  id: number;
  messageId: number;
  title: string;
  startAt: string; // ISO timestamp
  endAt: string | null; // ISO timestamp
  location: string | null;
  confidence: Confidence;
  status: EventStatus;
  calendarEventId: string | null;
  createdAt: string;
}

export interface Account {
  id: number;
  provider: MessageSource;
  label: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  createdAt: string;
}

export interface ScheduleCandidate {
  title: string;
  start: Date;
  end: Date | null;
  location: string | null;
  confidence: Confidence;
}
