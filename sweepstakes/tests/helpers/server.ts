// テスト用ローカル HTTP サーバー (127.0.0.1 のみ。外部には一切アクセスしない)
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const FORMS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "forms");

export interface Received {
  path: string;
  body: Record<string, string | string[]>;
}

export interface TestServer {
  baseUrl: string;
  received: Received[];
  close(): Promise<void>;
}

function parseBody(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else out[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

export async function startTestServer(): Promise<TestServer> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const send = (status: number, html: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      };
      if (req.method === "GET" && url.pathname.startsWith("/forms/")) {
        try {
          return send(200, readFileSync(join(FORMS, url.pathname.slice("/forms/".length).replace(/[^\w.-]/g, "")), "utf8"));
        } catch {
          return send(404, page("not found", "not found"));
        }
      }
      if (req.method === "POST") {
        const body = parseBody(raw);
        received.push({ path: url.pathname, body });
        if (url.pathname === "/confirm") {
          // 確認画面: 入力内容を表示し、hidden で引き継いで /complete へ
          const rows = Object.entries(body)
            .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`)
            .join("");
          const hidden = Object.entries(body)
            .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
            .join("");
          return send(
            200,
            page(
              "入力内容の確認",
              `<h1>入力内容の確認</h1><p>以下の内容でよろしければ「送信する」を押してください。</p><table>${rows}</table>
               <form action="/back" method="post">${hidden}<button type="submit">戻る</button></form>
               <form action="/complete" method="post">${hidden}<button type="submit">送信する</button></form>`,
            ),
          );
        }
        if (url.pathname === "/complete" || url.pathname === "/submit") {
          return send(200, page("完了", "<h1>応募完了</h1><p>ご応募ありがとうございました。</p>"));
        }
        return send(200, page("戻る", "<p>戻りました</p>"));
      }
      send(404, page("not found", "not found"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
