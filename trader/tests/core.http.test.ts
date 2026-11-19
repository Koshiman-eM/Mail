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
