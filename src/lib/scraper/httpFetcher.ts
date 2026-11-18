import { scanTags, tagAttr } from "./html";
import type { FetchedPage, PageFetcher } from "./types";
import { isAllowedFetchHost } from "./url";

/** デスクトップ版 Chrome 相当のヘッダー (モバイル版ページは埋め込みデータの構造が異なるため) */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8,zh;q=0.6",
  "Cache-Control": "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

export const HTTP_TIMEOUT_MS = 20_000;
export const HTTP_MAX_BYTES = 5 * 1024 * 1024;
/** 追従するリダイレクトの最大回数 */
export const HTTP_MAX_REDIRECTS = 5;

/** 対応サイト以外 (社内ネットワーク・IP 直指定など) への取得・リダイレクトを拒否した (SSRF 対策) */
export class DisallowedUrlError extends Error {
  constructor(public readonly url: string, reason = "対応サイト以外の URL へのアクセスは許可されていません") {
    super(`${reason}: ${url.slice(0, 200)}`);
    this.name = "DisallowedUrlError";
  }
}

export class TooManyRedirectsError extends Error {
  constructor(public readonly url: string) {
    super(`リダイレクトが多すぎます (${HTTP_MAX_REDIRECTS} 回超): ${url.slice(0, 200)}`);
    this.name = "TooManyRedirectsError";
  }
}

export class FetchTimeoutError extends Error {
  constructor(public readonly url: string, ms: number) {
    super(`タイムアウトしました (${Math.round(ms / 1000)} 秒): ${url}`);
    this.name = "FetchTimeoutError";
  }
}

export interface HttpFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** テスト用。未指定ならグローバル fetch */
  fetchImpl?: typeof fetch;
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  // <meta charset="gbk"> 等 (1688 の古いページは GBK)
  const sniff = new TextDecoder("latin1").decode(head.subarray(0, 4096));
  for (const { tag } of scanTags(sniff, "meta")) {
    const cs = tagAttr(tag, "charset") ?? tagAttr(tag, "content")?.match(/charset=([\w-]{1,40})/i)?.[1];
    if (cs && /^[\w-]{1,40}$/.test(cs)) return cs.toLowerCase();
  }
  return "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * fetch による軽量な商品ページ取得 (ブラウザ不要。無料ホスティングの Web プロセスでも動く)。
 * - リダイレクトは自前で最大 5 回まで追従し、最終 URL を返す (短縮リンクの展開・ログインページ検知に使う)。
 *   各段の URL は isAllowedFetchHost (対応サイトのドメインのみ・IP 直指定や localhost は不可) で検証する (SSRF 対策)
 * - タイムアウト (既定 20 秒) と受信サイズ上限 (既定 5MB。超過分は切り捨て) を設ける
 * - Cookie やログインは扱わず、CAPTCHA 等の自動突破も行わない
 */
export function createHttpFetcher(opts: HttpFetcherOptions = {}): PageFetcher {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? HTTP_MAX_BYTES;
  return {
    async fetch(url: string): Promise<FetchedPage> {
      const doFetch = opts.fetchImpl ?? globalThis.fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        let current = url;
        let res: Response;
        for (let hop = 0; ; hop++) {
          if (!isAllowedFetchHost(current)) throw new DisallowedUrlError(current);
          res = await doFetch(current, { headers: BROWSER_HEADERS, redirect: "manual", signal: ctrl.signal });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (!location) break;
          await res.body?.cancel().catch(() => undefined);
          if (hop >= HTTP_MAX_REDIRECTS) throw new TooManyRedirectsError(url);
          let next: URL;
          try {
            next = new URL(location, current); // 相対パスの Location も解決する
          } catch {
            throw new DisallowedUrlError(location, "リダイレクト先の URL が不正です");
          }
          current = next.toString();
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        let truncated = false;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (size + value.byteLength > maxBytes) {
              chunks.push(value.subarray(0, maxBytes - size));
              size = maxBytes;
              truncated = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
            size += value.byteLength;
          }
        }
        const bytes = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.byteLength;
        }
        const html = decode(bytes, charsetOf(res.headers.get("content-type"), bytes));
        return { finalUrl: current, status: res.status, html, truncated };
      } catch (e) {
        if (ctrl.signal.aborted) throw new FetchTimeoutError(url, timeoutMs);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      /* 保持する接続なし */
    },
  };
}
