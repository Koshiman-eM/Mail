#!/usr/bin/env node
// Meta Muse などから操作するためのリモート MCP サーバー (Streamable HTTP, ステートレス)
//
//   npm run mcp     (SWEEP_MCP_TOKEN 必須。HTTPS 終端は前段の Caddy)
//
// - POST /mcp           Authorization: Bearer <token>
// - POST /mcp/<token>   ヘッダーを設定できないクライアント向け
// - GET  /healthz       認証不要。"ok" のみ返す
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadProfile } from "../core/profile.js";
import { createContext } from "../core/service.js";
import { bearerToken, FailureLimiter, tokenEquals, validateServerToken } from "./auth.js";
import { JobManager } from "./jobs.js";
import { fileProfileStore } from "./profileStore.js";
import { registerTools, type ToolDeps } from "./tools.js";

export const SERVER_NAME = "sweepstakes";
export const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1024 * 1024;

const INSTRUCTIONS = `懸賞の収集・採点・Webフォーム自動応募 (ガード付き) と、手動で行う懸賞の「今日やること」を管理するツールです。
- enter_campaign / run_web_forms は既定で dry-run (送信しない) です。submit=true は利用者が明示的に送信を指示したときだけ指定してください。
- collect_sweepstakes / run_web_forms はジョブを開始してジョブ ID を返します。結果は get_job で確認してください (数分〜数十分かかります)。
- X / Instagram / 仮想通貨クエストの操作 (フォロー・RT・ウォレット署名など) は自動化しません。get_todo の手順を利用者に伝え、完了後に mark_done で記録します。
- 収集・応募は定期実行 (CLI) とも排他です。「他の処理が実行中」と返った場合は時間を置いて再実行してください。
- CAPTCHA・規約で自動応募禁止・重複・日次上限などで見送られた場合は、その理由を利用者に伝えてください。回避はしません。`;

export interface McpEnv {
  token: string;
  host: string;
  port: number;
  /** ループバックからの接続に限り X-Forwarded-For の右端を接続元 IP とみなす (Caddy 経由) */
  trustProxy: boolean;
}

/** 環境変数を読み込む。トークン未設定・短すぎる場合は例外 (起動拒否) */
export function loadMcpEnv(env: NodeJS.ProcessEnv = process.env): McpEnv {
  const token = validateServerToken(env.SWEEP_MCP_TOKEN);
  const port = env.SWEEP_MCP_PORT ? Number(env.SWEEP_MCP_PORT) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("SWEEP_MCP_PORT が不正です");
  return {
    token,
    host: env.SWEEP_MCP_HOST || "127.0.0.1",
    port,
    trustProxy: env.SWEEP_MCP_TRUST_PROXY !== "0",
  };
}

export interface McpHttpOptions {
  token: string;
  deps: ToolDeps;
  trustProxy?: boolean;
  limiter?: FailureLimiter;
  /** アクセスログ (トークンは含めない) */
  log?: (msg: string) => void;
}

/** ツールを登録した McpServer を作る (ステートレス運用のためリクエストごとに作る) */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, deps);
  return server;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (trustProxy && LOOPBACK.has(remote)) {
    const xff = req.headers["x-forwarded-for"];
    const v = Array.isArray(xff) ? xff.join(",") : xff;
    const last = v?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return remote;
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 401 ? -32001 : -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createMcpHttpServer(opts: McpHttpOptions): Server {
  const limiter = opts.limiter ?? new FailureLimiter();
  const log = opts.log ?? (() => undefined);
  const trustProxy = opts.trustProxy ?? true;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const ip = clientIp(req, trustProxy);
    // パスのトークンはログに出さない
    const logPath = path.startsWith("/mcp/") ? "/mcp/***" : path;
    res.on("finish", () => log(`${req.method} ${logPath} ${res.statusCode} ${ip}`));

    if (path === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET" });
        return void res.end();
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("ok");
    }

    if (path !== "/mcp" && !path.startsWith("/mcp/")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("not found");
    }

    const blocked = limiter.blockedFor(ip);
    if (blocked > 0) {
      return jsonRpcError(res, 429, "Too many failed authentication attempts", { "retry-after": String(Math.ceil(blocked / 1000)) });
    }

    let given: string | null;
    if (path.startsWith("/mcp/")) {
      const rest = path.slice("/mcp/".length);
      given = rest && !rest.includes("/") ? decodeURIComponent(rest) : null;
    } else {
      given = bearerToken(req.headers.authorization);
    }
    if (!tokenEquals(opts.token, given)) {
      const nowBlocked = limiter.recordFailure(ip);
      if (nowBlocked) log(`認証失敗が続いたため ${ip} を一時ブロックしました`);
      return jsonRpcError(res, 401, "Unauthorized", { "www-authenticate": 'Bearer realm="sweepstakes-mcp"' });
    }
    limiter.recordSuccess(ip);

    // ステートレス運用: セッションを持たないので GET (SSE ストリーム) / DELETE は不要
    if (req.method !== "POST") {
      return jsonRpcError(res, 405, "Method not allowed", { allow: "POST" });
    }

    void (async () => {
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch (e) {
        return jsonRpcError(res, (e as Error).message === "too large" ? 413 : 400, "Invalid request body");
      }
      const server = createMcpServer(opts.deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        log(`MCP リクエストの処理中にエラー: ${(e as Error).message}`);
        jsonRpcError(res, 500, "Internal server error");
      }
    })();
  });
}

export interface RunningMcpServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startMcpHttpServer(opts: McpHttpOptions & { host?: string; port?: number }): Promise<RunningMcpServer> {
  const server = createMcpHttpServer(opts);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const h = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    port,
    url: `http://${h}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function main(): Promise<void> {
  let env: McpEnv;
  try {
    env = loadMcpEnv();
  } catch (e) {
    console.error(`起動できません: ${(e as Error).message}`);
    process.exit(1);
  }
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  // MCP から profile.json を更新するので、プロフィールはキャッシュせず毎回読む
  const base = createContext({ log });
  const ctx = { ...base, profile: () => loadProfile(base.config.profilePath) };
  const deps: ToolDeps = { ctx, jobs: new JobManager(), profileStore: fileProfileStore(ctx.config.profilePath) };
  const running = await startMcpHttpServer({ token: env.token, deps, trustProxy: env.trustProxy, host: env.host, port: env.port, log });
  log(`MCP サーバーを起動しました: ${running.url}/mcp (healthz: ${running.url}/healthz)`);
  const shutdown = (sig: string) => {
    log(`${sig} を受信したため終了します`);
    void running.close().finally(() => {
      ctx.store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Windows: コンソールの Ctrl+Break。SIGTERM は Windows では届かない (タスク停止は強制終了になり、ロックは stale 判定で回収される)
  if (process.platform === "win32") process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
