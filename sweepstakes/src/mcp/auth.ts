// MCP サーバーの認証 (Bearer トークン / URL パス方式) と認証失敗のレート制限
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

/** トークンの検証 (起動時)。未設定・短すぎる場合は例外 */
export function validateServerToken(token: string | undefined): string {
  if (!token || !token.trim()) throw new Error("SWEEP_MCP_TOKEN が未設定です (例: openssl rand -hex 32 で生成して設定してください)");
  const t = token.trim();
  if (t.length < MIN_TOKEN_LENGTH) throw new Error(`SWEEP_MCP_TOKEN は ${MIN_TOKEN_LENGTH} 文字以上にしてください`);
  if (!/^[\x21-\x7e]+$/.test(t) || t.includes("/")) throw new Error("SWEEP_MCP_TOKEN には空白・制御文字・スラッシュを含めないでください");
  return t;
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** 定数時間比較 (長さの違いも漏らさないようハッシュ同士を比較する) */
export function tokenEquals(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== "string" || !given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/** Authorization ヘッダーから Bearer トークンを取り出す */
export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

export interface FailureLimiterOptions {
  /** この期間内の失敗回数を数える (ms) */
  windowMs?: number;
  /** windowMs 内にこの回数失敗したらブロック */
  maxFailures?: number;
  /** ブロック期間 (ms) */
  blockMs?: number;
  now?: () => number;
}

/** 認証失敗が続く IP をしばらくブロックする簡易レート制限 (メモリ内) */
export class FailureLimiter {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(opts: FailureLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxFailures = opts.maxFailures ?? 10;
    this.blockMs = opts.blockMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** ブロック中なら残りミリ秒、そうでなければ 0 */
  blockedFor(ip: string): number {
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left <= 0) {
      this.blockedUntil.delete(ip);
      return 0;
    }
    return left;
  }

  /** 失敗を記録する。ブロックに移行したら true */
  recordFailure(ip: string): boolean {
    const t = this.now();
    const list = (this.failures.get(ip) ?? []).filter((x) => t - x < this.windowMs);
    list.push(t);
    if (list.length >= this.maxFailures) {
      this.failures.delete(ip);
      this.blockedUntil.set(ip, t + this.blockMs);
      return true;
    }
    this.failures.set(ip, list);
    this.prune(t);
    return false;
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }

  /** 古いエントリを掃除してメモリを抑える */
  private prune(t: number): void {
    if (this.failures.size < 10_000) return;
    for (const [ip, list] of this.failures) if (!list.some((x) => t - x < this.windowMs)) this.failures.delete(ip);
    for (const [ip, until] of this.blockedUntil) if (until <= t) this.blockedUntil.delete(ip);
  }
}
