/**
 * 取引時間 (マーケットカレンダー)。エンジンの新規エントリーの可否・テンポの経過時間・RiskManager の日の区切りに使う。
 *
 * - `ALWAYS_OPEN`: 24 時間 365 日 (暗号資産)。日の区切りは UTC の 0 時 (従来どおり)。
 * - `weeklySessionCalendar`: 曜日と取引時間 (現地時刻) の繰り返し + 休場日。タイムゾーンは Intl で扱う (夏時間に対応)。
 *   FX は NY 17:00 で日を区切る (dayRollover: "17:00")。東証のように昼休みがあればセッションを 2 つにする。
 * 時刻はすべて UNIX ミリ秒。純粋 (現在時刻は引数で渡す)。
 */
import { isoDayKey } from "./util";

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export interface MarketCalendar {
  /** ts に取引できるか */
  isOpen(ts: number): boolean;
  /** ts 以降で最初に開く時刻 (開いていれば ts)。開かなければ Infinity */
  nextOpen(ts: number): number;
  /** ts 以降で最初に閉じる時刻 (続けて開くセッションはつなげる。閉じていれば次のセッションの終わり)。閉じなければ Infinity */
  nextClose(ts: number): number;
  /** ts が属する取引日 (YYYY-MM-DD)。RiskManager の日次損失の区切り */
  tradingDayKey(ts: number): string;
  /** ts の次の取引日の始まり (日次損失で止めたときの再開の時刻) */
  nextTradingDayStart(ts: number): number;
}

/** 24 時間 365 日 (暗号資産)。日の区切りは UTC の 0 時 */
export const ALWAYS_OPEN: MarketCalendar = Object.freeze({
  isOpen: () => true,
  nextOpen: (ts: number) => ts,
  nextClose: () => Infinity,
  tradingDayKey: (ts: number) => isoDayKey(ts),
  nextTradingDayStart: (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS + DAY_MS,
});

/** 取引時間 (現地時刻 "HH:MM"。close は "24:00" も可) */
export interface SessionSpec {
  open: string;
  close: string;
}

export interface WeeklySessionOptions {
  /** IANA のタイムゾーン (例 "America/New_York", "Asia/Tokyo") */
  tz: string;
  /**
   * 取引日の時間帯 (現地時刻)。dayRollover より前の時刻はその取引日の日付、以降は前日の日付の時刻として読む
   * (例: dayRollover "17:00" で { open: "17:00", close: "17:00" } は前日 17:00 〜 当日 17:00)
   */
  sessions: readonly SessionSpec[];
  /** 取引する曜日 (取引日の曜日。0 = 日曜 〜 6 = 土曜) */
  weekdays: readonly number[];
  /** 休場日 (取引日の YYYY-MM-DD) */
  holidays?: readonly string[];
  /** 取引日の区切り (現地時刻 "HH:MM"、既定 "00:00")。FX は "17:00" (NY) */
  dayRollover?: string;
}

function parseHm(s: string, allow24: boolean): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`時刻は HH:MM で指定してください: ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && (mi !== 0 || !allow24))) throw new Error(`時刻が範囲外です: ${s}`);
  return h * 60 + mi;
}

interface Wall {
  y: number;
  m: number;
  d: number;
  /** 0 時からの分 (秒は小数) */
  min: number;
  /** 秒の切り捨てまでの壁時計の UTC 表現 (オフセットの計算用) */
  utcLike: number;
}

/** 日付 (y, m, d) に days 日を足す (暦の計算。UTC で行う) */
function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const dayKeyOf = (x: { y: number; m: number; d: number }) => `${String(x.y).padStart(4, "0")}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
const weekdayOf = (x: { y: number; m: number; d: number }) => new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay();

/** 曜日・取引時間・休場日の繰り返しのカレンダー (夏時間は tz の現地時刻で扱う) */
export function weeklySessionCalendar(o: WeeklySessionOptions): MarketCalendar {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: o.tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const rollover = parseHm(o.dayRollover ?? "00:00", false);
  const weekdays = new Set(o.weekdays);
  for (const w of weekdays) if (!(Number.isInteger(w) && w >= 0 && w <= 6)) throw new Error(`曜日は 0 (日) 〜 6 (土) で指定してください: ${w}`);
  const holidays = new Set(o.holidays ?? []);
  // 取引日の始まりからの分で表したセッション [a, b)
  const rel = (min: number) => (min - rollover + 1440) % 1440;
  const sessions = o.sessions
    .map((s) => {
      const a = rel(parseHm(s.open, false));
      const b0 = rel(parseHm(s.close, true) % 1440);
      const b = b0 === 0 ? 1440 : b0;
      if (!(a < b)) throw new Error(`取引時間が不正です (${s.open}〜${s.close}。取引日の区切り ${o.dayRollover ?? "00:00"} をまたげません)`);
      return { a, b };
    })
    .sort((x, y) => x.a - y.a);
  if (sessions.length === 0) throw new Error("取引時間 (sessions) を 1 つ以上指定してください");
  for (let i = 1; i < sessions.length; i++) if (sessions[i].a < sessions[i - 1].b) throw new Error("取引時間が重なっています");

  const wall = (ts: number): Wall => {
    const p: Record<string, number> = {};
    for (const x of fmt.formatToParts(new Date(ts))) if (x.type !== "literal") p[x.type] = Number(x.value);
    return { y: p.year, m: p.month, d: p.day, min: p.hour * 60 + p.minute + p.second / 60, utcLike: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) };
  };
  /** 現地の壁時計の時刻 → UTC (夏時間の飛びは後ろへずらす) */
  const instant = (y: number, m: number, d: number, min: number): number => {
    const guess = Date.UTC(y, m - 1, d) + min * MIN_MS;
    const offsetAt = (t: number) => wall(t).utcLike - Math.floor(t / 1000) * 1000;
    let t = guess - offsetAt(guess);
    const t2 = guess - offsetAt(t);
    if (t2 !== t) t = Math.max(t, t2);
    return t;
  };
  /** ts の取引日 (日付) と、取引日の始まりからの分 (壁時計) */
  const locate = (ts: number) => {
    const w = wall(ts);
    const date = rollover > 0 && w.min >= rollover ? addDays(w.y, w.m, w.d, 1) : { y: w.y, m: w.m, d: w.d };
    return { date, rel: rel(w.min) };
  };
  /** 取引日 date の始まりからの分 r の時刻 */
  const at = (date: { y: number; m: number; d: number }, r: number): number => {
    const startDate = rollover > 0 ? addDays(date.y, date.m, date.d, -1) : date;
    const total = rollover + r;
    const extra = Math.floor(total / 1440);
    const dd = addDays(startDate.y, startDate.m, startDate.d, extra);
    return instant(dd.y, dd.m, dd.d, total - extra * 1440);
  };
  const tradingDay = (date: { y: number; m: number; d: number }) => weekdays.has(weekdayOf(date)) && !holidays.has(dayKeyOf(date));
  const MAX_SCAN_DAYS = 400;

  /** ts 以降に終わるセッション [open, close) を順に (最大 MAX_SCAN_DAYS 日) */
  function* sessionsFrom(ts: number): Generator<{ open: number; close: number }> {
    const { date } = locate(ts);
    for (let i = -1; i < MAX_SCAN_DAYS; i++) {
      const d = addDays(date.y, date.m, date.d, i);
      if (!tradingDay(d)) continue;
      for (const s of sessions) {
        const close = at(d, s.b);
        if (close > ts) yield { open: at(d, s.a), close };
      }
    }
  }

  const cal: MarketCalendar = {
    isOpen(ts) {
      const { date, rel: r } = locate(ts);
      if (!tradingDay(date)) return false;
      return sessions.some((s) => r >= s.a && r < s.b);
    },
    nextOpen(ts) {
      if (cal.isOpen(ts)) return ts;
      for (const s of sessionsFrom(ts)) if (s.open >= ts) return s.open;
      return Infinity;
    },
    nextClose(ts) {
      let end: number | undefined;
      for (const s of sessionsFrom(ts)) {
        if (end === undefined) {
          end = s.close;
          continue;
        }
        if (s.open > end) break; // 間が空く = ここで閉じる
        end = s.close; // 続けて開く (FX の日の区切りなど) はつなげる
      }
      return end ?? Infinity;
    },
    tradingDayKey(ts) {
      return dayKeyOf(locate(ts).date);
    },
    nextTradingDayStart(ts) {
      const { date } = locate(ts);
      for (let i = 1; i <= MAX_SCAN_DAYS; i++) {
        const d = addDays(date.y, date.m, date.d, i);
        if (tradingDay(d)) return at(d, 0);
      }
      return at(addDays(date.y, date.m, date.d, 1), 0);
    },
  };
  return cal;
}

/**
 * from から to までのうち取引時間の長さ (ms)。テンポの経過時間 (閉まっている間は進めない) に使う。
 * カレンダーが無ければ to − from (負は 0)
 */
export function openDurationMs(calendar: MarketCalendar | undefined, from: number, to: number): number {
  if (!(to > from)) return 0;
  if (!calendar || calendar === ALWAYS_OPEN) return to - from;
  let t = from;
  let sum = 0;
  for (let guard = 0; guard < 10_000 && t < to; guard++) {
    const open = calendar.nextOpen(t);
    if (!(open < to)) break;
    const close = Math.min(calendar.nextClose(open), to);
    if (!(close > open)) break;
    sum += close - open;
    t = close;
  }
  return sum;
}
