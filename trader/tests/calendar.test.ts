import { describe, expect, it } from "vitest";
import { ALWAYS_OPEN, openDurationMs, weeklySessionCalendar } from "../src/core/calendar";

const T = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

/** NY 株式 (9:30〜16:00 ET、月〜金) */
const nyse = weeklySessionCalendar({ tz: "America/New_York", sessions: [{ open: "09:30", close: "16:00" }], weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-03"] });
/** 東証 (昼休みあり) */
const tse = weeklySessionCalendar({ tz: "Asia/Tokyo", sessions: [{ open: "09:00", close: "11:30" }, { open: "12:30", close: "15:30" }], weekdays: [1, 2, 3, 4, 5] });
/** FX (NY 17:00 で日を区切る。日曜 17:00 〜 金曜 17:00) */
const fx = weeklySessionCalendar({ tz: "America/New_York", sessions: [{ open: "17:00", close: "17:00" }], weekdays: [1, 2, 3, 4, 5], dayRollover: "17:00" });

describe("ALWAYS_OPEN (暗号資産。従来どおり)", () => {
  it("常に開いていて、日の区切りは UTC の 0 時", () => {
    const t = T("2026-01-05T13:45:00Z");
    expect(ALWAYS_OPEN.isOpen(t)).toBe(true);
    expect(ALWAYS_OPEN.nextOpen(t)).toBe(t);
    expect(ALWAYS_OPEN.nextClose(t)).toBe(Infinity);
    expect(ALWAYS_OPEN.tradingDayKey(t)).toBe("2026-01-05");
    expect(ALWAYS_OPEN.nextTradingDayStart(t)).toBe(T("2026-01-06T00:00:00Z"));
    expect(openDurationMs(ALWAYS_OPEN, t, t + HOUR)).toBe(HOUR);
  });
});

describe("weeklySessionCalendar", () => {
  it("夏時間: NY の 9:30 は冬 14:30Z・夏 13:30Z", () => {
    expect(nyse.isOpen(T("2026-01-05T14:30:00Z"))).toBe(true);
    expect(nyse.isOpen(T("2026-01-05T14:29:59Z"))).toBe(false);
    expect(nyse.isOpen(T("2026-07-06T13:30:00Z"))).toBe(true);
    expect(nyse.isOpen(T("2026-07-06T20:00:00Z"))).toBe(false); // 16:00 EDT で閉じる
    // 夏時間に切り替わる週末をまたぐ (2026-03-08)
    expect(nyse.nextOpen(T("2026-03-06T21:00:00Z"))).toBe(T("2026-03-09T13:30:00Z"));
    expect(nyse.nextClose(T("2026-03-09T14:00:00Z"))).toBe(T("2026-03-09T20:00:00Z"));
  });
  it("週末は閉じていて、次に開くのは月曜", () => {
    const sat = T("2026-01-10T15:00:00Z");
    expect(nyse.isOpen(sat)).toBe(false);
    expect(nyse.nextOpen(sat)).toBe(T("2026-01-12T14:30:00Z"));
    expect(nyse.nextClose(sat)).toBe(T("2026-01-12T21:00:00Z"));
    expect(nyse.tradingDayKey(sat)).toBe("2026-01-10");
    expect(nyse.nextTradingDayStart(T("2026-01-09T15:00:00Z"))).toBe(T("2026-01-12T05:00:00Z")); // 月曜 0:00 EST
  });
  it("昼休み: 11:30〜12:30 は閉じていて、閉じる時刻は昼休みの前", () => {
    expect(tse.isOpen(T("2026-01-05T01:00:00Z"))).toBe(true); // 10:00 JST
    expect(tse.isOpen(T("2026-01-05T02:45:00Z"))).toBe(false); // 11:45 JST
    expect(tse.nextClose(T("2026-01-05T01:00:00Z"))).toBe(T("2026-01-05T02:30:00Z"));
    expect(tse.nextOpen(T("2026-01-05T02:45:00Z"))).toBe(T("2026-01-05T03:30:00Z"));
    expect(openDurationMs(tse, T("2026-01-05T00:00:00Z"), T("2026-01-05T07:00:00Z"))).toBe(5.5 * HOUR);
  });
  it("休場日は閉じていて、次の取引日へ進む", () => {
    expect(nyse.isOpen(T("2026-07-03T15:00:00Z"))).toBe(false);
    expect(nyse.nextOpen(T("2026-07-02T21:00:00Z"))).toBe(T("2026-07-06T13:30:00Z"));
    expect(nyse.nextTradingDayStart(T("2026-07-02T15:00:00Z"))).toBe(T("2026-07-06T04:00:00Z"));
  });
  it("NY 17:00 の日の区切り (FX): 日曜 17:00 〜 金曜 17:00、取引日は 17:00 で進む", () => {
    expect(fx.isOpen(T("2026-01-11T21:59:00Z"))).toBe(false); // 日曜 16:59 EST
    expect(fx.isOpen(T("2026-01-11T22:00:00Z"))).toBe(true); // 日曜 17:00 EST = 月曜の取引日
    expect(fx.tradingDayKey(T("2026-01-11T22:00:00Z"))).toBe("2026-01-12");
    expect(fx.tradingDayKey(T("2026-01-12T21:59:00Z"))).toBe("2026-01-12");
    expect(fx.tradingDayKey(T("2026-01-12T22:00:00Z"))).toBe("2026-01-13");
    expect(fx.isOpen(T("2026-01-13T22:00:00Z"))).toBe(true); // 日の区切りでも閉じない
    expect(fx.nextClose(T("2026-01-13T12:00:00Z"))).toBe(T("2026-01-16T22:00:00Z")); // 続けて開く日はつなげ、金曜 17:00 で閉じる
    expect(fx.isOpen(T("2026-01-17T12:00:00Z"))).toBe(false); // 土曜
    expect(fx.nextOpen(T("2026-01-17T12:00:00Z"))).toBe(T("2026-01-18T22:00:00Z"));
    expect(fx.nextTradingDayStart(T("2026-01-13T12:00:00Z"))).toBe(T("2026-01-13T22:00:00Z"));
    // 夏時間 (EDT) では 21:00Z
    expect(fx.tradingDayKey(T("2026-07-07T21:00:00Z"))).toBe("2026-07-08");
    expect(openDurationMs(fx, T("2026-01-16T12:00:00Z"), T("2026-01-19T12:00:00Z"))).toBe(10 * HOUR + 14 * HOUR);
  });
  it("不正な設定は例外", () => {
    expect(() => weeklySessionCalendar({ tz: "UTC", sessions: [], weekdays: [1] })).toThrow();
    expect(() => weeklySessionCalendar({ tz: "UTC", sessions: [{ open: "10:00", close: "09:00" }], weekdays: [1] })).toThrow();
    expect(() => weeklySessionCalendar({ tz: "UTC", sessions: [{ open: "9:00", close: "12:00" }, { open: "11:00", close: "13:00" }], weekdays: [1] })).toThrow();
  });
});

describe("カレンダーの利用: テンポ・RiskManager の日の区切り", async () => {
  const { TempoController } = await import("../src/engine/tempo");
  const { RiskManager } = await import("../src/risk/manager");
  const { DEFAULT_RISK } = await import("../src/appConfig");
  const { MemoryStore } = await import("../src/storage/memory");

  it("テンポ: 閉まっている間は経過 (待ち) を進めない", () => {
    const fri = T("2026-01-16T20:00:00Z"); // 金曜 15:00 EST (FX は 17:00 で閉じる)
    const plain = new TempoController({ targetPerHour: 6, now: fri });
    const withCal = new TempoController({ targetPerHour: 6, now: fri, calendar: fx });
    const sat = T("2026-01-17T12:00:00Z");
    expect(plain.level(sat)).toBe(1);
    // 金曜 15:00 → 17:00 の 2 時間だけ経過 (待ちは 20 分で 1 に届く) なので 1。週末に入ったエントリーの窓も取引時間で測る
    expect(withCal.level(sat)).toBe(1);
    const c2 = new TempoController({ targetPerHour: 6, now: T("2026-01-16T21:55:00Z"), calendar: fx }); // 閉じる 5 分前
    expect(c2.level(T("2026-01-18T12:00:00Z"))).toBe(0); // 日曜の昼 (閉まっている): 取引時間の経過は 5 分 < 10 分
    expect(c2.level(T("2026-01-18T22:10:00Z"))).toBeCloseTo(0.5, 6); // 開いてから 10 分: 経過 15 分 → 待ち 0.5
  });

  it("RiskManager: 日次損失の日の区切りはカレンダーの取引日 (無ければ UTC)", () => {
    const store = new MemoryStore();
    const rm = new RiskManager({ ...DEFAULT_RISK, maxDailyLoss: 0.01 }, store, { mode: "paper", calendar: fx });
    rm.onEquity(1000, T("2026-01-13T21:00:00Z")); // 火曜の取引日
    const r = rm.onEquity(980, T("2026-01-13T21:30:00Z"));
    expect(r.halted).toBe(true);
    expect(rm.isHalted(T("2026-01-13T21:59:00Z")).halted).toBe(true);
    expect(rm.isHalted(T("2026-01-13T22:00:00Z")).halted).toBe(false); // NY 17:00 で次の取引日
    expect((store.kvGet<{ dayKey: string }>("risk:state:paper"))?.dayKey).toBe("2026-01-13");
  });
});
