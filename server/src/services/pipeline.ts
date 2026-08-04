import { config } from "../config.js";
import { insertEvent, updateEventStatus } from "../store/eventStore.js";
import { markProcessed } from "../store/messageStore.js";
import type { DetectedEvent, UnifiedMessage } from "../types.js";
import { bestSchedule } from "./scheduleExtractor.js";
import { createCalendarEvent } from "./calendar.js";

/**
 * Runs schedule detection on a newly stored message and, when a candidate
 * is found, records it and (if enabled/possible) pushes it straight to
 * Google Calendar. Shared by both the Gmail sync job and the LINE webhook.
 */
export async function processMessage(message: UnifiedMessage): Promise<DetectedEvent | null> {
  const candidate = bestSchedule(message.body, {
    subject: message.subject,
    referenceDate: new Date(message.receivedAt),
  });

  markProcessed(message.id);

  if (!candidate) return null;

  let event = insertEvent({
    messageId: message.id,
    title: candidate.title,
    startAt: candidate.start.toISOString(),
    endAt: candidate.end ? candidate.end.toISOString() : null,
    location: candidate.location,
    confidence: candidate.confidence,
    status: "pending",
  });

  if (config.autoCreateEvents) {
    event = await pushEventToCalendar(event, message);
  }

  return event;
}

export async function pushEventToCalendar(
  event: DetectedEvent,
  message: UnifiedMessage
): Promise<DetectedEvent> {
  try {
    const calendarEventId = await createCalendarEvent(
      {
        title: event.title,
        start: new Date(event.startAt),
        end: event.endAt ? new Date(event.endAt) : null,
        location: event.location,
        confidence: event.confidence,
      },
      `${message.source === "gmail" ? "Gmail" : "LINE"} メッセージから自動検出\n\n${message.body.slice(0, 500)}`
    );
    updateEventStatus(event.id, "created", calendarEventId);
    return { ...event, status: "created", calendarEventId };
  } catch (err) {
    console.error("Failed to create calendar event:", err);
    updateEventStatus(event.id, "failed");
    return { ...event, status: "failed" };
  }
}
