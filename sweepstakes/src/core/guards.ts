// 送信前ガード (すべて純粋関数)
// CAPTCHA は「検出して人間に回す」だけで、突破・回避は一切実装しない。
import type { Entry, EntryStatus } from "./types.js";

export interface GuardResult {
  ok: boolean;
  /** ok=false のときに記録すべき Entry ステータス */
  status?: EntryStatus;
  reason?: string;
}

const OK: GuardResult = { ok: true };

// ---------------------------------------------------------------------------
// CAPTCHA 検出
// ---------------------------------------------------------------------------

export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile" | "cloudflare_challenge" | "generic_sitekey";

const CAPTCHA_PATTERNS: [CaptchaKind, RegExp][] = [
  // reCAPTCHA (v2/v3/Enterprise)
  ["recaptcha", /google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha|recaptcha\/(api|enterprise)\.js/i],
  ["recaptcha", /class\s*=\s*["'][^"']*\bg-recaptcha\b/i],
  ["recaptcha", /name\s*=\s*["']g-recaptcha-response["']|id\s*=\s*["']g-recaptcha-response/i],
  ["recaptcha", /<iframe[^>]*title\s*=\s*["'][^"']*recaptcha/i],
  // hCaptcha
  ["hcaptcha", /hcaptcha\.com|js\.hcaptcha|class\s*=\s*["'][^"']*\bh-captcha\b|name\s*=\s*["']h-captcha-response["']/i],
  // Cloudflare Turnstile
  ["turnstile", /challenges\.cloudflare\.com\/turnstile|class\s*=\s*["'][^"']*\bcf-turnstile\b|name\s*=\s*["']cf-turnstile-response["']/i],
  // Cloudflare のチャレンジページ
  ["cloudflare_challenge", /\/cdn-cgi\/challenge-platform|id\s*=\s*["']challenge-form["']|cf-chl-|<title>\s*Just a moment\.\.\.\s*<\/title>/i],
  // 上記に当てはまらない sitekey 付きウィジェット
  ["generic_sitekey", /data-sitekey\s*=/i],
];

export interface CaptchaInput {
  html: string;
  /** ページ内の iframe / フレームの URL */
  frameUrls?: string[];
}

export function detectCaptcha(input: CaptchaInput): { detected: boolean; kinds: CaptchaKind[] } {
  const haystack = [input.html, ...(input.frameUrls ?? [])].join("\n");
  const kinds = new Set<CaptchaKind>();
  for (const [kind, re] of CAPTCHA_PATTERNS) if (re.test(haystack)) kinds.add(kind);
  if (kinds.size > 1) kinds.delete("generic_sitekey");
  return { detected: kinds.size > 0, kinds: [...kinds] };
}

export function captchaGuard(input: CaptchaInput): GuardResult {
  const r = detectCaptcha(input);
  if (!r.detected) return OK;
  return {
    ok: false,
    status: "needs_manual",
    reason: `CAPTCHA を検出しました (${r.kinds.join(", ")})。自動送信は行いません。手動で応募してください`,
  };
}

// ---------------------------------------------------------------------------
// 規約の自動応募禁止検出
// ---------------------------------------------------------------------------

const AUTOMATION_TERMS =
  /自動応募|自動投稿|自動送信|自動入力|自動化|自動(?:的な)?(?:ツール|プログラム|操作)|ツール|ボット|bot(?![a-z])|プログラム|スクリプト|マクロ|機械的|automated|automation|automatic(?:ally)?\s+(?:entry|entries|submission)|script|macro|robot|robotic|software|\btools?\b/i;
const PROHIBITION_TERMS =
  /禁止|禁じ|無効|お断り|認め(?:ません|られません|ない)|できません|失格|対象外|取り消|取消|prohibit|forbid|not\s+(?:be\s+)?(?:allowed|permitted|accepted|eligible|valid)|void|disqualif|invalid/i;
const ENTRY_CONTEXT = /応募|参加|エントリー|投稿|送信|使用|利用|用い|entry|entries|enter|submission|participat|\buse\b|\bused\b|\busing\b/i;

/** 規約テキストから自動応募禁止の記述を探す。見つかればその文を返す */
export function findAutomationBan(text: string): string | null {
  if (!text) return null;
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[。．！？!?])|(?<=\.)\s|\n|・|●|■|※/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    if (AUTOMATION_TERMS.test(s) && PROHIBITION_TERMS.test(s) && ENTRY_CONTEXT.test(s)) return s.slice(0, 200);
  }
  return null;
}

export function termsGuard(texts: (string | undefined | null)[]): GuardResult {
  for (const t of texts) {
    const hit = t ? findAutomationBan(t) : null;
    if (hit) return { ok: false, status: "skipped", reason: `規約で自動応募が禁止されています: 「${hit}」` };
  }
  return OK;
}

// ---------------------------------------------------------------------------
// 重複応募
// ---------------------------------------------------------------------------

/** 応募済み (送信済み・手動完了) の記録があれば skipped */
export function duplicateGuard(entries: Pick<Entry, "status">[]): GuardResult {
  const done = entries.find((e) => e.status === "submitted" || e.status === "done_manual");
  if (!done) return OK;
  return { ok: false, status: "skipped", reason: "このキャンペーンには応募済みです" };
}

// ---------------------------------------------------------------------------
// レート制限
// ---------------------------------------------------------------------------

export interface RateLimitInput {
  now: Date;
  /** 本日 (ローカル 0 時以降) の送信数 */
  submittedToday: number;
  lastSubmittedAt: Date | null;
  dailyLimit: number;
  minIntervalSec: number;
  maxIntervalSec: number;
  /** 0〜1 の乱数 (テスト用に注入可能) */
  random?: () => number;
}

export interface RateLimitResult {
  /** 日次上限に達していないか */
  allowed: boolean;
  /** 送信前に待つべきミリ秒 (allowed=true のとき) */
  waitMs: number;
  reason?: string;
}

export function randomIntervalMs(minSec: number, maxSec: number, random: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return Math.round((lo + (hi - lo) * random()) * 1000);
}

export function rateLimitGuard(i: RateLimitInput): RateLimitResult {
  if (i.submittedToday >= i.dailyLimit) {
    return { allowed: false, waitMs: 0, reason: `本日の送信上限 (${i.dailyLimit} 件) に達しました` };
  }
  if (!i.lastSubmittedAt) return { allowed: true, waitMs: 0 };
  const interval = randomIntervalMs(i.minIntervalSec, i.maxIntervalSec, i.random);
  const waitMs = Math.max(0, i.lastSubmittedAt.getTime() + interval - i.now.getTime());
  return { allowed: true, waitMs };
}

/** ローカルタイムでの当日 0 時 */
export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 指定タイムゾーンでの時差 (ms。壁時計 - UTC) */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * 指定タイムゾーン (例 Asia/Tokyo) での当日 0 時。
 * OS のタイムゾーンや TZ 環境変数 (Windows では効かない場合がある) に依存しない。
 */
export function startOfDayInTimeZone(now: Date, timeZone: string): Date {
  const off = tzOffsetMs(now, timeZone);
  const wall = new Date(now.getTime() + off);
  const midnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  // 夏時間のある地域向けに、0 時時点の時差で補正する
  const guess = new Date(midnightWall - off);
  return new Date(midnightWall - tzOffsetMs(guess, timeZone));
}

// ---------------------------------------------------------------------------
// 必須欄
// ---------------------------------------------------------------------------

export interface FieldFillPlanItem {
  label: string;
  required: boolean;
  /** 入力値を信頼度高く決められたか */
  resolved: boolean;
}

/** 必須欄のうち、信頼度高く埋められないものがあれば needs_manual */
export function requiredFieldsGuard(items: FieldFillPlanItem[]): GuardResult {
  const unknown = items.filter((f) => f.required && !f.resolved);
  if (unknown.length === 0) return OK;
  const names = unknown.map((f) => f.label || "(ラベル不明)").join(", ");
  return { ok: false, status: "needs_manual", reason: `自動入力できない必須欄があります: ${names}` };
}
