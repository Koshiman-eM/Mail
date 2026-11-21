/**
 * Jupiter / GeckoTerminal の応答を読むための共通の補助 (純粋関数)。
 *
 * この環境からは api.jup.ag / api.geckoterminal.com に接続できず、実際の応答の形は未確認 (公式資料の記述だけ)。
 * そのため読み方は防御的にする:
 * - 数値は number でも数値の文字列でも受ける。null・空文字・NaN・Infinity・数値でない文字列は「不明 (undefined)」にする (例外にしない)。
 * - 真偽値は true / false のほか "true" / "false"・1 / 0 も受ける。
 * - オブジェクトは未知のキーを捨てずに通す (zod の looseObject)。
 * - 欠かせない項目 (mint・価格・数量など) が無いときだけ、その要素を「不正」として報告する。
 * 実際の応答の形は `runJupiterCheck` (src/market/jupiter/check.ts) で確かめる。
 */
import { z } from "zod";
import { redactSecrets } from "../../core/http";

/** 応答の形が想定と違う。issues は「項目名: 内容」の一覧 */
export class JupiterShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: string[],
  ) {
    super(
      redactSecrets(
        `${path}: 応答の形が想定と違います: ${issues.slice(0, 8).join("; ")}${issues.length > 8 ? ` ほか ${issues.length - 8} 件` : ""}`,
      ),
    );
    this.name = "JupiterShapeError";
  }
}

const NUM_STR_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** 有限の数値にする (number・数値の文字列)。それ以外 (null・NaN・Infinity・空文字・"abc") は undefined */
export function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!NUM_STR_RE.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 真偽値にする (true/false・"true"/"false"・1/0)。それ以外は undefined */
export function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1") return true;
  if (v === 0 || v === "0") return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

/** 空でない文字列にする (前後の空白を除く)。それ以外は undefined */
export function toStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s;
}

/** 整数の数量 (最小単位) を 10 進の文字列にする。負・小数・非数は undefined */
export function toAtomicString(v: unknown): string | undefined {
  if (typeof v === "string") return /^\d+$/.test(v.trim()) ? v.trim().replace(/^0+(?=\d)/, "") : undefined;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
  if (typeof v === "bigint") return v >= 0n ? v.toString() : undefined;
  return undefined;
}

/**
 * 時刻をミリ秒にする。number は 1e11 未満なら秒とみなす (2001 年以降のミリ秒は 1e12 以上)。
 * 文字列は数値なら同じ規則、それ以外は ISO 8601 として読む。読めなければ undefined
 */
export function toMs(v: unknown): number | undefined {
  const n = toFiniteNumber(v);
  if (n !== undefined) {
    if (n <= 0) return undefined;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** zod: 欠けていても・不正でも例外にしない数値 (number | undefined) */
export const looseNum = z.unknown().transform(toFiniteNumber).optional();
/** zod: 欠けていても・不正でも例外にしない真偽値 */
export const looseBool = z.unknown().transform(toBool).optional();
/** zod: 欠けていても・不正でも例外にしない文字列 */
export const looseStr = z.unknown().transform(toStr).optional();
/** zod: 欠けていても・不正でも例外にしない時刻 (ミリ秒) */
export const looseMs = z.unknown().transform(toMs).optional();
/** zod: 文字列の配列 (文字列以外の要素は捨てる。配列でなければ空) */
export const looseStrArray = z
  .unknown()
  .transform((v) => (Array.isArray(v) ? v.map(toStr).filter((s): s is string => s !== undefined) : []))
  .optional();

/** Solana のアドレス (base58、32〜44 文字) */
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolanaAddress = (s: unknown): boolean => typeof s === "string" && SOLANA_ADDRESS_RE.test(s);

/** zod のエラーを「項目名: 内容」の一覧にする */
export function issuesOf(e: z.ZodError, prefix: string): string[] {
  return e.issues.map((i) => `${[prefix, ...i.path.map(String)].join(".")}: ${i.message}`);
}

/** 配列を n 件ずつに分ける */
export function chunk<T>(arr: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 空文字を除いて重複を除く (順序は最初の出現順) */
export function uniqueNonEmpty(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const s = raw.trim();
    if (s === "" || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
