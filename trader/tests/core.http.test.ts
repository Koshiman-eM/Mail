import { describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError, redactSecrets, redactUrl } from "../src/core/http";
import { createCryptoPanicSource, redactToken } from "../src/intel/sources/cryptopanic";

describe("HTTP エラーの伏せ字", () => {
  it("redactUrl: クエリ文字列を伏せる", () => {
    expect(redactUrl("https://api.example.com/v1/posts/?auth_token=SECRET&public=true")).toBe("https://api.example.com/v1/posts/?***");
    expect(redactUrl("https://api.example.com/v3/accounts/101-1/orders")).toBe("https://api.example.com/v3/accounts/101-1/orders");
  });

  it("redactSecrets: key=value / JSON / Bearer / 長いトークンらしき文字列を伏せる。UUID は残す", () => {
    expect(redactSecrets("bad auth_token=abc123&x=1")).toBe("bad auth_token=***&x=1");
    expect(redactSecrets('{"apiKey":"k-1","msg":"no"}')).toBe('{"apiKey":"***","msg":"no"}');
    expect(redactSecrets("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer ***");
    const tok = "0123456789abcdef0123456789abcdef-0123456789abcdef0123456789abcdef";
    expect(redactSecrets(`invalid token ${tok} given`)).toBe("invalid token *** given");
    expect(redactSecrets("order 0b0e8a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b not found")).toContain("0b0e8a43-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(redactSecrets("insufficient margin")).toBe("insufficient margin");
  });

  it("HttpError のメッセージと url プロパティにクエリのトークンを含めない", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad","token":"SECRET42"}', { status: 401 })) as unknown as typeof fetch;
    const err = (await fetchJson("https://api.example.com/x?auth_token=SECRET42&q=1", { fetchImpl, retries: 0 }).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toMatch(/^HTTP 401 https:\/\/api\.example\.com\/x\?\*\*\*: /);
    expect(err.message).not.toContain("SECRET42");
    expect(err.url).not.toContain("SECRET42");
    expect(JSON.stringify({ ...err })).not.toMatch(/auth_token=SECRET42/);
    // 呼び出し側の判定用に本文は生のまま保持する
    expect(err.body).toContain("SECRET42");
  });
});

describe("cryptopanic のトークン伏せ字", () => {
  it("生のトークンと encodeURIComponent したトークンの両方を伏せる", () => {
    const token = "a+b/c=d&e";
    const msg = `fail https://x/?auth_token=${encodeURIComponent(token)} raw=${token}`;
    const out = redactToken(msg, token);
    expect(out).not.toContain(token);
    expect(out).not.toContain(encodeURIComponent(token));
  });

  it("取得エラーのメッセージにエンコード済みトークンが残らない", async () => {
    const token = "tok en+/=";
    const src = createCryptoPanicSource({
      token,
      fetchJson: async (u) => {
        throw new Error(`fail ${u}`);
      },
    })!;
    const err = (await src.fetch(0).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(encodeURIComponent(token));
    expect(err.message).not.toContain(token);
  });
});

import { BodyTooLargeError, fetchText, fetchWithRetry, parseRetryAfter } from "../src/core/http";

describe("fetchWithRetry の本文タイムアウト・サイズ上限・Retry-After", () => {
  it("ヘッダー受信後に本文が止まったらタイムアウトで失敗する", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("par"));
          init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchText("https://x.example/a", { fetchImpl, retries: 0, timeoutMs: 30 })).rejects.toThrow(/abort/);
  });

  it("本文が上限を超えたら再試行せずエラー", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(100), { status: 200 })) as unknown as typeof fetch;
    const err = await fetchText("https://x.example/a", { fetchImpl, maxBodyBytes: 50, retries: 3, sleep: async () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("通常の応答は json / text として読める", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"a":1}', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchJson("https://x.example/a", { fetchImpl })).toEqual({ a: 1 });
    const res = await fetchWithRetry("https://x.example/a", { fetchImpl });
    expect(res.status).toBe(200);
  });

  it("429 の Retry-After を尊重する (上限付き)。retries: 0 なら再試行しない", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "3" } }) : new Response("ok", { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchText("https://x.example/a", { fetchImpl, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 10 })).toBe("ok");
    expect(sleeps[0]).toBe(3000);
    const sleeps2: number[] = [];
    const f2 = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "9999" } })) as unknown as typeof fetch;
    await expect(fetchText("https://x.example/a", { fetchImpl: f2, retries: 1, sleep: async (ms) => void sleeps2.push(ms), maxRetryAfterMs: 5000 })).rejects.toThrow();
    expect(sleeps2).toEqual([5000]);
    const f3 = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchText("https://x.example/a", { fetchImpl: f3, retries: 0 })).rejects.toThrow();
    expect(f3).toHaveBeenCalledTimes(1);
  });

  it("parseRetryAfter: 秒・日付・不正値", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("abc")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
