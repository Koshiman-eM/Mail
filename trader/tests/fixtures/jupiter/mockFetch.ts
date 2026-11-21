/**
 * Jupiter / GeckoTerminal のテスト用のモック (すべてオフライン。実 API へは送信しない)。
 * - createMockFetch: URL のパスで応答を返す fetch。呼び出し (URL・ヘッダー・時刻) を記録する
 * - fakeClock: sleep で時計を進める時刻 (レート制限・バックオフの待ちを実時間で待たない)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(here, name), "utf8")) as T;
}

export interface RecordedCall {
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  at: number;
}

export type MockReply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
export type MockRoute = (call: RecordedCall, index: number) => MockReply | Promise<MockReply>;

export function fakeClock(start = 1_750_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
    sleeps,
  };
}

export function createMockFetch(route: MockRoute, now: () => number = Date.now) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      h[k] = v;
    });
    if ((init?.method ?? "GET") !== "GET") throw new Error(`mock: GET 以外は想定していません (${init?.method})`);
    const call: RecordedCall = { url, path: u.pathname, query: u.searchParams, headers: h, at: now() };
    calls.push(call);
    const r = await route(call, calls.length - 1);
    const text = r.text ?? JSON.stringify(r.body ?? null);
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
