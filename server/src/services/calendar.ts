import { google } from "googleapis";
import { config } from "../config.js";
import { getAuthenticatedClient } from "./gmail.js";
import type { ScheduleCandidate } from "../types.js";

const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1 hour, used when no end time was detected

/**
 * Creates an event on the connected Google Calendar. Throws if no Google
 * account is connected — callers should catch and mark the event as
 * "failed" rather than crash the request.
 */
export async function createCalendarEvent(
  candidate: ScheduleCandidate,
  description: string
): Promise<string> {
  const client = getAuthenticatedClient();
  if (!client) throw new Error("Google Calendar account is not connected");

  const calendar = google.calendar({ version: "v3", auth: client });
  const end = candidate.end ?? new Date(candidate.start.getTime() + DEFAULT_DURATION_MS);

  const { data } = await calendar.events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary: candidate.title,
      location: candidate.location ?? undefined,
      description,
      start: { dateTime: candidate.start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });

  if (!data.id) throw new Error("Google Calendar did not return an event id");
  return data.id;
}
