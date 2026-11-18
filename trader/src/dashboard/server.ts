/**
 * 閲覧専用のダッシュボード (node:http)。既定は 127.0.0.1 のみで待ち受ける。
 * 変更系のエンドポイントは作らない (GET / HEAD 以外は 405)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { systemClock, type Clock, type Store } from "../core/types";
import { quoteCurrencyOfSymbol } from "../engine/fx";
import { exitFxRates, exitReasonCounts, summarizeByStrategy, tradePnlAccount } from "../engine/report";
import { CAUSE_LABEL } from "../learning/attribution";
import type { LearningService } from "../learning/service";
import { DASHBOARD_HTML } from "./page";

export interface DashboardDeps {
  /** 状態 (TradingEngine.status) */
  status: () => unknown | Promise<unknown>;
  store: Store;
  learning: Pick<LearningService, "snapshot">;
  clock?: Clock;
  /** 口座通貨 (トレードの損益表示) */
  baseCurrency?: string;
  /** クオート通貨 → 口座通貨 (省略時は換算しない) */
  toAccount?: (ccy: string) => number;
  /** シンボル → クオート通貨 (省略時はシンボルから推定) */
  quoteCurrencyOf?: (symbol: string) => string | undefined;
}

export interface DashboardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

const json = (status: number, data: unknown): DashboardResponse => ({
  status,
  headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

/** limit のクエリ (1〜500, 既定 50) */
export function parseLimit(v: string | null, def = 50, max = 500): number {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : def;
}

/** トレード一覧 (新しい順) と要因分析 */
export function tradesPayload(deps: DashboardDeps, limit: number) {
  const trades = deps.store.listTrades({ limit }).reverse();
  const quoteOf = (sym: string) => deps.quoteCurrencyOf?.(sym) ?? quoteCurrencyOfSymbol(sym);
  const toAccount = deps.toAccount;
  // 決済時点の為替 (エンジンの監査ログ)。無ければ現在のレート
  const rates = trades.length ? exitFxRates(deps.store, trades[trades.length - 1].exitTs) : new Map<string, number>();
  return {
    baseCurrency: deps.baseCurrency ?? "",
    trades: trades.map((t) => {
      const att = deps.store.getAttribution(t.id);
      const pnl = toAccount ? tradePnlAccount(t, toAccount, quoteOf(t.symbol), rates.get(t.id)) : undefined;
      return {
        id: t.id,
        mode: t.mode,
        symbol: t.symbol,
        assetClass: t.assetClass,
        strategyId: t.strategyId,
        horizon: t.horizon,
        direction: t.direction,
        qty: t.qty,
        entryTs: t.entryTs,
        entryPrice: t.entryPrice,
        exitTs: t.exitTs,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason,
        netPnl: t.netPnl,
        fees: t.fees,
        ...(pnl ? { netPnlAccount: pnl.net } : {}),
        quoteCurrency: quoteOf(t.symbol),
        rMultiple: t.rMultiple,
        returnPct: t.returnPct,
        mfePct: t.mfePct,
        maePct: t.maePct,
        regime: t.entryContext.regime.label,
        reason: t.entryContext.reason,
        ...(t.postExitMovePct !== undefined ? { postExitMovePct: t.postExitMovePct } : {}),
        attribution: att
          ? {
              outcome: att.outcome,
              causes: att.causes.map((c) => ({ code: c.code, label: CAUSE_LABEL[c.code] ?? c.code, weight: c.weight, evidence: c.evidence })),
            }
          : null,
      };
    }),
    byStrategy: summarizeByStrategy(trades, toAccount ?? (() => 1), (t) => quoteOf(t.symbol), rates),
    exitReasons: exitReasonCounts(trades),
  };
}

/** ルーティング (listen せずにテストから呼べる) */
export async function routeDashboard(deps: DashboardDeps, method: string, rawUrl: string): Promise<DashboardResponse> {
  if (method !== "GET" && method !== "HEAD") {
    return { ...json(405, { error: "読み取り専用です" }), headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" } };
  }
  const url = new URL(rawUrl, "http://localhost");
  const now = (deps.clock ?? systemClock).now();
  try {
    switch (url.pathname) {
      case "/":
      case "/index.html":
        return { status: 200, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP }, body: DASHBOARD_HTML };
      case "/api/status":
        return json(200, await deps.status());
      case "/api/trades":
        return json(200, tradesPayload(deps, parseLimit(url.searchParams.get("limit"))));
      case "/api/learning":
        return json(200, { ...deps.learning.snapshot({ now }), causeLabels: CAUSE_LABEL });
      default:
        return json(404, { error: "見つかりません" });
    }
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** node:http 用のハンドラー */
export function createDashboardHandler(deps: DashboardDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const r = await routeDashboard(deps, req.method ?? "GET", req.url ?? "/");
    res.writeHead(r.status, r.headers);
    res.end(req.method === "HEAD" ? undefined : r.body);
  };
}

export interface DashboardServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** ループバック以外へ bind するか (認証が無いので外部公開は非推奨) */
export const isLoopbackHost = (host: string) => ["127.0.0.1", "localhost", "::1", ""].includes(host.trim().toLowerCase());

/** 待ち受け開始 (既定 127.0.0.1) */
export function startDashboard(deps: DashboardDeps, opts: { host?: string; port: number }): Promise<DashboardServer> {
  const host = opts.host || "127.0.0.1";
  const handler = createDashboardHandler(deps);
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(e));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const shownHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        url: `http://${shownHost}:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
