/** 貼り付けソース (最大 5MB) を含むリクエストの上限 */
export const MAX_HTML_REQUEST_BYTES = 6 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`リクエストが大きすぎます (上限 ${Math.round(limit / 1024 / 1024)}MB)`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * 本文をサイズ上限付きで文字列として読む。
 * Content-Length が上限を超えていれば読む前に拒否し、ヘッダーが無い/偽りの場合も読みながら上限で打ち切る。
 */
export async function readLimitedText(req: Request, maxBytes = MAX_HTML_REQUEST_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** サイズ上限付きで JSON を読む。空なら {}。不正な JSON は ok: false */
export async function readLimitedJson(req: Request, maxBytes = MAX_HTML_REQUEST_BYTES): Promise<{ ok: true; json: unknown } | { ok: false }> {
  const raw = await readLimitedText(req, maxBytes);
  try {
    return { ok: true, json: raw.trim() ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false };
  }
}

