import { describe, expect, it } from "vitest";
import { bestSchedule, extractSchedules } from "../src/services/scheduleExtractor.js";

const REF = new Date("2026-08-04T09:00:00+09:00");

describe("extractSchedules", () => {
  it("returns no candidates for text without dates", () => {
    expect(extractSchedules("お疲れ様です。よろしくお願いします。")).toEqual([]);
  });

  it("detects a Japanese date + time with high confidence", () => {
    const candidates = extractSchedules("来週の8月10日 14時から打ち合わせをしましょう。", {
      referenceDate: REF,
    });
    expect(candidates.length).toBeGreaterThan(0);
    const [first] = candidates;
    expect(first.confidence).toBe("high");
    // Dates are assumed JST (UTC+9); "14時" on Aug 10 JST is 05:00 UTC.
    expect(first.start.toISOString()).toBe("2026-08-10T05:00:00.000Z");
  });

  it("detects an English date with a subject as title", () => {
    const candidate = bestSchedule("Let's meet on August 12th at 3pm to review the design.", {
      subject: "Design Review",
      referenceDate: REF,
    });
    expect(candidate).not.toBeNull();
    expect(candidate?.title).toBe("Design Review");
    expect(candidate?.confidence).toBe("high");
  });

  it("extracts a labeled location when present", () => {
    const candidate = bestSchedule("8月15日 10時から会議です。場所：会議室A", {
      referenceDate: REF,
    });
    expect(candidate?.location).toBe("会議室A");
  });

  it("falls back to message text as title when no subject is given", () => {
    const candidate = bestSchedule("明日の15時に渋谷で待ち合わせ", { referenceDate: REF });
    expect(candidate).not.toBeNull();
    expect(candidate?.title.length).toBeGreaterThan(0);
  });

  it("picks the highest confidence candidate as best", () => {
    const candidate = bestSchedule("8月20日 13時に確定。詳細は後日連絡します。", {
      referenceDate: REF,
    });
    expect(candidate?.confidence).toBe("high");
  });
});
