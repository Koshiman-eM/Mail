export type MessageSource = "gmail" | "line";
export type EventStatus = "pending" | "created" | "dismissed" | "failed";
export type Confidence = "high" | "medium" | "low";

export interface UnifiedMessage {
  id: number;
  source: MessageSource;
  externalId: string;
  accountId: number | null;
  sender: string;
  subject: string | null;
  body: string;
  receivedAt: string;
  processed: boolean;
  createdAt: string;
}

export interface DetectedEvent {
  id: number;
  messageId: number;
  title: string;
  startAt: string;
  endAt: string | null;
  location: string | null;
  confidence: Confidence;
  status: EventStatus;
  calendarEventId: string | null;
  createdAt: string;
}

export interface AccountsResponse {
  accounts: { id: number; provider: MessageSource; label: string; createdAt: string }[];
  line: { configured: boolean; ready: boolean };
  google: { configured: boolean; connected: boolean };
}
