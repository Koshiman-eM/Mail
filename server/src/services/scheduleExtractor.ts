import * as chrono from "chrono-node";
import type { Confidence, ScheduleCandidate } from "../types.js";

const JAPANESE_RE = /[぀-ヿ一-龯]/;

// This app targets a Japanese user (LINE + Gmail); dates without an explicit
// timezone are assumed to be JST (UTC+9) rather than the server's own TZ.
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 540;

function pickParser(text: string): chrono.Chrono {
  // Messages from LINE / Japanese Gmail correspondents are usually in
  // Japanese; the ja locale parser understands "8月10日 14時" etc. which
  // the default English parser does not.
  return JAPANESE_RE.test(text) ? chrono.ja.casual : chrono.casual;
}

function confidenceOf(result: chrono.ParsedResult): Confidence {
  const hasDay = result.start.isCertain("day");
  const hasHour = result.start.isCertain("hour");
  if (hasDay && hasHour) return "high";
  if (hasDay || hasHour) return "medium";
  return "low";
}

function extractLocation(text: string): string | null {
  const labeled = text.match(/場所[:：]\s*([^\n、。]+)/);
  if (labeled) return labeled[1].trim();

  const venuePhrase = text.match(/([^\s、。]{2,20}?)(?:にて|で)(?:開催|集合|行います|実施)/);
  if (venuePhrase) return venuePhrase[1].trim();

  const atLabel = text.match(/(?:location|at)[:：]\s*([^\n,.]+)/i);
  if (atLabel) return atLabel[1].trim();

  return null;
}

function buildTitle(text: string, matchedText: string, subject: string | null): string {
  if (subject && subject.trim().length > 0) {
    return subject.trim().slice(0, 80);
  }
  const withoutMatch = text
    .replace(matchedText, " ")
    .replace(/^\s*(?:に|で|から|の|、)+/u, " ") // stray leading particle left behind by the removed date phrase
    .replace(/\s+/g, " ")
    .trim();
  const firstSegment = withoutMatch.split(/[\n。.]/)[0]?.trim();
  const fallback = firstSegment && firstSegment.length > 0 ? firstSegment : text.trim();
  return fallback.slice(0, 80) || "予定";
}

/**
 * Scans free-form message text for date/time mentions and returns
 * candidate calendar events. Pure/offline (no network calls) so it can be
 * unit tested deterministically.
 */
export function extractSchedules(
  text: string,
  options: {
    subject?: string | null;
    referenceDate?: Date;
    timezoneOffsetMinutes?: number;
  } = {}
): ScheduleCandidate[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parser = pickParser(trimmed);
  const instant = options.referenceDate ?? new Date();
  const timezone = options.timezoneOffsetMinutes ?? DEFAULT_TIMEZONE_OFFSET_MINUTES;
  const results = parser.parse(trimmed, { instant, timezone }, { forwardDate: true });

  return results.map((result) => ({
    title: buildTitle(trimmed, result.text, options.subject ?? null),
    start: result.start.date(),
    end: result.end ? result.end.date() : null,
    location: extractLocation(trimmed),
    confidence: confidenceOf(result),
  }));
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

/** Returns the highest-confidence schedule candidate found in the text, if any. */
export function bestSchedule(
  text: string,
  options: {
    subject?: string | null;
    referenceDate?: Date;
    timezoneOffsetMinutes?: number;
  } = {}
): ScheduleCandidate | null {
  const candidates = extractSchedules(text, options);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
  )[0];
}
