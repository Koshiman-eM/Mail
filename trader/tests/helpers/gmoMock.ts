/**
 * GMOコイン API のモック (fetch を差し替える。実際の api.coin.z.com には送信しない)。応答はすべて合成データ。
 * routes のキーは "GET /v1/ticker" のような "メソッド パス" (パスは /public・/private を除く)。
 * 値は応答の data (関数なら URL と本文から作る)。{ __status, __messages } を返すとエラー応答、
 * { __raw } はそのまま本文、{ __http } は HTTP ステータス、Error を投げると通信エラーになる。
 */
export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

export type RouteValue = unknown | ((req: RecordedRequest) => unknown);

export function gmoOk(data: unknown) {
  return { status: 0, data, responsetime: "2025-01-01T00:00:00.000Z" };
}
export function gmoErr(code: string, message = "error") {
  return { __status: 1, __messages: [{ message_code: code, message_string: message }] };
}

export function createGmoMock(routes: Record<string, RouteValue>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/(public|private)/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: RecordedRequest = { method, url, path, query: u.searchParams, headers, body: typeof init?.body === "string" ? init.body : "" };
    requests.push(req);
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ status: 1, messages: [{ message_code: "ERR-404", message_string: `no route ${key}` }] }), { status: 200 });
    const r = routes[key];
    const v = typeof r === "function" ? (r as (q: RecordedRequest) => unknown)(req) : r;
    if (v instanceof Error) throw v;
    if (v && typeof v === "object" && "__http" in v) {
      const o = v as { __http: number; __body?: unknown };
      return new Response(typeof o.__body === "string" ? o.__body : JSON.stringify(o.__body ?? {}), { status: o.__http });
    }
    if (v && typeof v === "object" && "__raw" in v) return new Response(String((v as { __raw: unknown }).__raw), { status: 200 });
    if (v && typeof v === "object" && "__status" in v) {
      const o = v as { __status: number; __messages: unknown };
      return new Response(JSON.stringify({ status: o.__status, messages: o.__messages }), { status: 200 });
    }
    return new Response(JSON.stringify(gmoOk(v)), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** /v1/symbols の合成データ (レバレッジ銘柄と現物銘柄) */
export const SYMBOLS_DATA = [
  { symbol: "BTC", minOrderSize: "0.0001", maxOrderSize: "5", sizeStep: "0.0001", tickSize: "1", takerFee: "0.0005", makerFee: "-0.0001" },
  { symbol: "BTC_JPY", minOrderSize: "0.01", maxOrderSize: "5", sizeStep: "0.01", tickSize: "1", takerFee: "0", makerFee: "0" },
  { symbol: "ETH_JPY", minOrderSize: "0.1", maxOrderSize: "100", sizeStep: "0.1", tickSize: "1", takerFee: "0", makerFee: "0" },
  { symbol: "XRP_JPY", minOrderSize: "10", maxOrderSize: "100000", sizeStep: "10", tickSize: "0.001", takerFee: "0", makerFee: "0" },
];

/** 即時に進む時計と sleep (レート制限の待ちを実時間で待たない) */
export function fakeTime(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
