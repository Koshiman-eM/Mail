import { describe, expect, it } from "vitest";
import { HttpError } from "../src/core/http";
import { assertReadOnlyPath, buildQuery, JupiterClient, scrubSecret, TokenBucket } from "../src/market/jupiter/client";
import { JupiterShapeError, toBool, toFiniteNumber, toMs } from "../src/market/jupiter/parse";
import { createMockFetch, fakeClock } from "./fixtures/jupiter/mockFetch";

/** Jupiter のクライアント (すべてモック。実 API へは送信しない) */
describe("TokenBucket", () => {
  it("0.5 回/秒・burst 1 なら 2 秒ごとに 1 回", async () => {
    const clk = fakeClock(0);
    const b = new TokenBucket({ ratePerSec: 0.5, burst: 1, now: clk.now, sleep: clk.sleep });
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await b.acquire();
      times.push(clk.now());
    }
    expect(times).toEqual([0, 2000, 4000, 6000]);
  });

  it("burst の分は待たずに取れ、その後は補充の速さ", async () => {
    const clk = fakeClock(0);
    const b = new TokenBucket({ ratePerSec: 2, burst: 3, now: clk.now, sleep: clk.sleep });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await b.acquire();
      times.push(clk.now());
    }
    expect(times).toEqual([0, 0, 0, 500, 1000]);
  });

  it("時間が経てば補充される (burst を超えては貯まらない)", () => {
    const clk = fakeClock(0);
    const b = new TokenBucket({ ratePerSec: 1, burst: 2, now: clk.now, sleep: clk.sleep });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(b.waitMs()).toBe(1000);
    clk.advance(10_000);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it("同時の acquire は呼び出し順に直列", async () => {
    const clk = fakeClock(0);
    const b = new TokenBucket({ ratePerSec: 1, now: clk.now, sleep: clk.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => b.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2]);
    expect(clk.now()).toBe(2000);
  });

  it("不正な rate は例外", () => {
    expect(() => new TokenBucket({ ratePerSec: 0 })).toThrow();
    expect(() => new TokenBucket({ ratePerSec: Number.NaN })).toThrow();
  });
});

describe("JupiterClient", () => {
  it("キーなしは 0.5 回/秒、キーありは 1 回/秒 (既定)。キーは x-api-key ヘッダーだけ", async () => {
    const clk = fakeClock(0);
    const { fetchImpl, calls } = createMockFetch(() => ({ body: {} }), clk.now);
    const keyless = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    expect(keyless.limiter.ratePerSec).toBe(0.5);
    expect(keyless.hasApiKey).toBe(false);
    await keyless.getJson("/price/v3", { ids: ["a", "b"] });
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
    expect(calls[0].url).toBe("https://api.jup.ag/price/v3?ids=a,b");

    const keyed = new JupiterClient({ apiKey: "secret-key-123", fetchImpl, now: clk.now, sleep: clk.sleep });
    expect(keyed.limiter.ratePerSec).toBe(1);
    expect(keyed.hasApiKey).toBe(true);
    await keyed.getJson("/tokens/v2/recent");
    expect(calls[1].headers["x-api-key"]).toBe("secret-key-123");
    expect(calls[1].url).not.toContain("secret-key-123");
    expect(JSON.stringify(keyed)).not.toContain("secret-key-123");
  });

  it("呼び出しはレート制限で間隔があく (キーなし 2 秒ごと)", async () => {
    const clk = fakeClock(0);
    const { fetchImpl, calls } = createMockFetch(() => ({ body: {} }), clk.now);
    const c = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    for (let i = 0; i < 3; i++) await c.getJson("/tokens/v2/recent");
    expect(calls.map((x) => x.at)).toEqual([0, 2000, 4000]);
  });

  it("429 と 5xx はバックオフして再試行し、再試行のたびにレート制限の枠を取り直す", async () => {
    const clk = fakeClock(0);
    const { fetchImpl, calls } = createMockFetch((_c, i) => (i === 0 ? { status: 429, body: { error: "rate" } } : i === 1 ? { status: 503, body: {} } : { body: { ok: 1 } }), clk.now);
    const c = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep, ratePerSec: 0.5, baseDelayMs: 100 });
    const r = await c.getJson("/tokens/v2/recent");
    expect(r).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    // 2 回目以降も 2 秒以上あく (バックオフの待ち + 枠の補充)
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(2000);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(2000);
  });

  it("Retry-After を尊重する", async () => {
    const clk = fakeClock(0);
    const { fetchImpl, calls } = createMockFetch((_c, i) => (i === 0 ? { status: 429, body: {}, headers: { "retry-after": "7" } } : { body: [] }), clk.now);
    const c = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep, ratePerSec: 100, burst: 5, baseDelayMs: 10 });
    await c.getJson("/tokens/v2/recent");
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(7000);
  });

  it("4xx は再試行しない。再試行が尽きたら最後のエラー", async () => {
    const clk = fakeClock(0);
    const m400 = createMockFetch(() => ({ status: 400, body: { error: "bad" } }), clk.now);
    const c400 = new JupiterClient({ fetchImpl: m400.fetchImpl, now: clk.now, sleep: clk.sleep });
    await expect(c400.getJson("/tokens/v2/recent")).rejects.toBeInstanceOf(HttpError);
    expect(m400.calls).toHaveLength(1);

    const m500 = createMockFetch(() => ({ status: 500, body: {} }), clk.now);
    const c500 = new JupiterClient({ fetchImpl: m500.fetchImpl, now: clk.now, sleep: clk.sleep, retries: 2 });
    await expect(c500.getJson("/tokens/v2/recent")).rejects.toMatchObject({ status: 500 });
    expect(m500.calls).toHaveLength(3);
  });

  it("エラー文・本文にキーを出さない (応答がキーを含んでいても伏せる)", async () => {
    const clk = fakeClock(0);
    const key = "my-plain-key-abc";
    const { fetchImpl } = createMockFetch(() => ({ status: 401, text: `invalid api key ${key}` }), clk.now);
    const c = new JupiterClient({ apiKey: key, fetchImpl, now: clk.now, sleep: clk.sleep });
    const e = await c.getJson("/tokens/v2/recent").catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(401);
    expect((e as Error).message).not.toContain(key);
    expect((e as HttpError).body).not.toContain(key);
    expect((e as Error).message).toContain("***");
  });

  it("通信エラーのメッセージからもキーを伏せる", async () => {
    const key = "k3y-in-message";
    const err = scrubSecret(new Error(`connect failed for ${key}`), key) as Error;
    expect(err.message).not.toContain(key);
  });

  it("JSON でない応答は JupiterShapeError", async () => {
    const clk = fakeClock(0);
    const { fetchImpl } = createMockFetch(() => ({ text: "<html>oops</html>" }), clk.now);
    const c = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    await expect(c.getJson("/tokens/v2/recent")).rejects.toBeInstanceOf(JupiterShapeError);
  });

  it("swap・execute・taker 付きは送信前に拒否する (読み取り専用)", async () => {
    const clk = fakeClock(0);
    const { fetchImpl, calls } = createMockFetch(() => ({ body: {} }), clk.now);
    const c = new JupiterClient({ fetchImpl, now: clk.now, sleep: clk.sleep });
    await expect(c.getJson("/swap/v1/swap")).rejects.toThrow(/読み取り専用/);
    await expect(c.getJson("/swap/v1/swap-instructions")).rejects.toThrow(/読み取り専用/);
    await expect(c.getJson("/ultra/v1/execute")).rejects.toThrow(/読み取り専用/);
    await expect(c.getJson("/ultra/v1/order", { inputMint: "a", taker: "wallet" })).rejects.toThrow(/taker/);
    await expect(c.getJson("/trigger/v1/createOrder")).rejects.toThrow(/読み取り専用/);
    await expect(c.getJson("/price/v3x")).rejects.toThrow(/読み取り専用/);
    expect(calls).toHaveLength(0);
    expect(() => assertReadOnlyPath("/swap/v1/quote")).not.toThrow();
    expect(() => assertReadOnlyPath("/tokens/v2/toptrending/1h")).not.toThrow();
  });

  it("buildQuery: undefined・空文字は省き、配列はカンマ区切り", () => {
    expect(buildQuery({ a: 1, b: undefined, c: "", d: ["x", "y"], e: true })).toBe("?a=1&d=x,y&e=true");
    expect(buildQuery({})).toBe("");
  });
});

describe("防御的な読み方 (parse)", () => {
  it("toFiniteNumber: 数値・数値の文字列だけ。null・NaN・Infinity・空文字・文字は undefined", () => {
    expect(toFiniteNumber(1.5)).toBe(1.5);
    expect(toFiniteNumber(" 2.5 ")).toBe(2.5);
    expect(toFiniteNumber("1e-5")).toBe(0.00001);
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(Number.NaN)).toBeUndefined();
    expect(toFiniteNumber(Infinity)).toBeUndefined();
    expect(toFiniteNumber("")).toBeUndefined();
    expect(toFiniteNumber("NaN")).toBeUndefined();
    expect(toFiniteNumber("12abc")).toBeUndefined();
    expect(toFiniteNumber({})).toBeUndefined();
  });

  it("toBool / toMs", () => {
    expect(toBool("true")).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool("yes")).toBeUndefined();
    expect(toMs(1735689600)).toBe(1735689600000);
    expect(toMs(1735689600000)).toBe(1735689600000);
    expect(toMs("2025-01-01T00:00:00Z")).toBe(1735689600000);
    expect(toMs("not a date")).toBeUndefined();
    expect(toMs(null)).toBeUndefined();
  });
});
