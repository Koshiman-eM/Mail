/**
 * 閲覧専用のダッシュボード (node:http)。既定は 127.0.0.1 のみで待ち受ける。
 * 変更系のエンドポイントは作らない (GET / HEAD 以外は 405)。
 * DNS rebinding 対策として Host ヘッダーを検証し、許可外は 403 にする。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redactSecrets } from "../core/http";
import { createLogger } from "../core/logger";
import { systemClock, type Clock, type Store, type TradingMode } from "../core/types";
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
  /** チャート用: 選べる時間足 (短い順) */
  chartTimeframes?: () => string[];
  /** チャート用: 監視銘柄のローソク足。監視していない銘柄・時間足は undefined (404) */
  candles?: (symbol: string, tf: string, limit: number) => { ts: number; open: number; high: number; low: number; close: number; volume: number }[] | undefined;
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

const log = createLogger("dashboard");

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
export function tradesPayload(deps: DashboardDeps, limit: number, mode?: TradingMode) {
  // mode 指定時はその mode だけ (paper と live を混ぜない)。集計 (byStrategy) は mode の全期間、一覧は直近 limit 件
  const allInMode = mode ? deps.store.listTrades({ mode }).filter((t) => t.mode === mode) : deps.store.listTrades();
  const trades = allInMode.slice(-limit).reverse();
  const quoteOf = (sym: string) => deps.quoteCurrencyOf?.(sym) ?? quoteCurrencyOfSymbol(sym);
  const toAccount = deps.toAccount;
  // 決済時点の為替 (エンジンの監査ログ)。無ければ現在のレート
  const rates = allInMode.length ? exitFxRates(deps.store, Math.min(...allInMode.map((t) => t.exitTs))) : new Map<string, number>();
  return {
    baseCurrency: deps.baseCurrency ?? "",
    ...(mode ? { mode } : {}),
    /** byStrategy の集計対象 (mode の全期間) の件数。trades は直近 limit 件だけ */
    totalTrades: allInMode.length,
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
        // 約定を確認できず建玉・手動の申告から推定した部分を含む (学習には使っていない)
        ...(t.estimated ? { estimated: true } : {}),
        attribution: att
          ? {
              outcome: att.outcome,
              causes: att.causes.map((c) => ({ code: c.code, label: CAUSE_LABEL[c.code] ?? c.code, weight: c.weight, evidence: c.evidence })),
            }
          : null,
      };
    }),
    byStrategy: summarizeByStrategy(allInMode, toAccount ?? (() => 1), (t) => quoteOf(t.symbol), rates),
    exitReasons: exitReasonCounts(trades),
  };
}

/** ライブ画面に出す監査ログの種類 (それ以外は出さない) */
const EVENT_KIND: Record<string, string> = {
  "engine.entry": "entry", "engine.exit": "exit", "engine.skip_summary": "skip", "engine.plan": "plan",
  "engine.order_rejected": "order", "engine.order_error": "order", "engine.order_cancel": "order", "order.unknown_escalated": "order",
  "order.resolved_by_position": "order", "order.manual_resolve": "order", "engine.entries_paused": "risk", "engine.entries_resumed": "risk",
  "risk.halt_daily": "risk", "risk.kill_switch": "risk", "risk.resume": "risk", "engine.kill_switch_close": "risk", "engine.account_degraded": "risk",
  "learning.param_adjust": "learning", "learning.param_revert": "learning", "learning.reflect": "learning", "engine.learning": "learning",
  "engine.start": "system", "engine.stop": "system", "engine.intel_error": "intel", "reconcile.external_close": "order",
};
/** 表示してよい項目だけを取り出す (文字列は伏せ字処理を通す) */
const EVENT_FIELDS = ["symbol", "strategyId", "direction", "reason", "price", "exitPrice", "netPnl", "rMultiple", "qty", "riskOn", "status", "estimated", "param", "from", "to"];

export interface LiveEvent {
  ts: number;
  type: string;
  kind: string;
  data: Record<string, string | number | boolean>;
}

/** 監査ログをライブ画面用に変換する (新しい順。since 以降。同じミリ秒の記録の取りこぼしを避けるため since 自体を含む。重複はクライアントで除く) */
export function liveEvents(store: Store, opts: { since?: number; limit: number }): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const e of store.listAudit({ ...(opts.since !== undefined ? { since: opts.since } : {}), limit: opts.limit * 4 }).slice().sort((a, b) => b.ts - a.ts)) {
    const kind = EVENT_KIND[e.type];
    if (!kind || (opts.since !== undefined && e.ts < opts.since)) continue;
    const data: Record<string, string | number | boolean> = {};
    for (const k of EVENT_FIELDS) {
      const v = (e.data as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) data[k] = v;
      else if (typeof v === "boolean") data[k] = v;
      else if (typeof v === "string") data[k] = redactSecrets(v).slice(0, 120);
    }
    if (e.type === "engine.skip_summary" && e.data.reasons && typeof e.data.reasons === "object") {
      const top = Object.entries(e.data.reasons as Record<string, { count?: number }>).slice(0, 3).map(([k, v]) => `${redactSecrets(k).slice(0, 40)}×${Number(v?.count) || 0}`);
      data.reason = top.join(" / ");
    }
    if (e.type === "engine.plan" && Array.isArray(e.data.activeSymbols)) data.active = e.data.activeSymbols.length;
    out.push({ ts: e.ts, type: e.type, kind, data });
    if (out.length >= opts.limit) break;
  }
  return out;
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
      case "/api/trades": {
        let mode: TradingMode | undefined;
        const q = url.searchParams.get("mode");
        if (q === "paper" || q === "live") mode = q;
        else {
          // 指定が無ければ現在の mode で絞る (取れなければ絞らない)
          try {
            const m = ((await deps.status()) as { mode?: unknown } | null)?.mode;
            if (m === "paper" || m === "live") mode = m;
          } catch { /* 絞り込みなしで返す */ }
        }
        return json(200, tradesPayload(deps, parseLimit(url.searchParams.get("limit")), mode));
      }
      case "/api/candles": {
        const symbol = url.searchParams.get("symbol") ?? "";
        const tfs = deps.chartTimeframes?.() ?? [];
        const tf = url.searchParams.get("tf") || tfs[0] || "";
        const candles = deps.candles && symbol ? deps.candles(symbol, tf, parseLimit(url.searchParams.get("limit"), 150, 500)) : undefined;
        if (!candles) return json(404, { error: "その銘柄・時間足のチャートはありません", timeframes: tfs });
        return json(200, { symbol, tf, timeframes: tfs, candles });
      }
      case "/api/events": {
        const sinceRaw = Number(url.searchParams.get("since"));
        return json(200, { events: liveEvents(deps.store, { ...(Number.isFinite(sinceRaw) && sinceRaw > 0 ? { since: sinceRaw } : {}), limit: parseLimit(url.searchParams.get("limit"), 30, 100) }) });
      }
      case "/api/learning":
        return json(200, { ...deps.learning.snapshot({ now }), causeLabels: CAUSE_LABEL });
      default:
        return json(404, { error: "見つかりません" });
    }
  } catch (e) {
    // 内部エラーの本文 (パス・設定値など) は応答に出さず、ログにだけ残す
    log.error("ダッシュボードの処理に失敗", { path: url.pathname, error: e instanceof Error ? e.message : String(e) });
    return json(500, { error: "内部エラー" });
  }
}

/** ループバック以外へ bind するか (認証が無いので外部公開は非推奨) */
export const isLoopbackHost = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]", ""].includes(host.trim().toLowerCase());

/** 待ち受けアドレス → Host ヘッダー表記 (IPv6 は角括弧で囲む) */
const hostForHeader = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

/**
 * 許可する Host ヘッダーの集合。
 * - 待ち受けがループバック (既定): ホスト名 127.0.0.1 / localhost / [::1] だけを検証し、ポートは問わない
 *   (SSH 転送で手元のポートが変わっても開けるように。エントリー末尾 ":*" = 任意のポート)。
 * - ループバック以外を明示 bind した場合 (DASHBOARD_HOST): ループバック名 + その値は従来どおり <host>:<port> に厳密一致。
 * どちらもホスト名の検証は維持する (DNS rebinding 対策)。
 */
export function dashboardAllowedHosts(port: number, bindHost?: string): Set<string> {
  const names = ["127.0.0.1", "localhost", "[::1]"];
  const b = bindHost?.trim().toLowerCase();
  const out = new Set<string>();
  if (!b || isLoopbackHost(b)) {
    for (const n of names) out.add(`${n}:*`);
    return out;
  }
  names.push(hostForHeader(b));
  for (const n of names) {
    out.add(`${n}:${port}`);
    if (port === 80) out.add(n); // 既定ポートではブラウザーがポートを省く
  }
  return out;
}

/** Host ヘッダー → [ホスト名, ポート文字列 ("" = 省略)]。形式が不正なら undefined */
function splitHost(h: string): [string, string] | undefined {
  const m = /^(\[[0-9a-f:.]+\]|[^:\[\]\s]+)(?::(\d{1,5}))?$/.exec(h);
  return m ? [m[1], m[2] ?? ""] : undefined;
}

/** Host ヘッダーが許可リストにあるか (大文字小文字は区別しない。欠落は不許可) */
export function isAllowedHost(hostHeader: string | string[] | undefined, allowed: Set<string>): boolean {
  if (typeof hostHeader !== "string") return false;
  const h = hostHeader.trim().toLowerCase();
  if (h === "") return false;
  if (allowed.has(h)) return true;
  const sp = splitHost(h);
  return sp !== undefined && allowed.has(`${sp[0]}:*`);
}

export interface DashboardHandlerOptions {
  /** 許可する Host (省略時は req.socket.localPort からループバック名だけを許可) */
  allowedHosts?: Set<string>;
}

const STATUS_TTL_MS = 2_000;
const LEARNING_TTL_MS = 30_000;

/**
 * 重い取得 (status はブローカー API を呼ぶことがある / learning snapshot は集計) の短いキャッシュ。
 * 失敗はキャッシュしない。同時の呼び出しは同じ Promise を共有する。サーバー単位で 1 つ作る。
 */
export function withDashboardCaches(deps: DashboardDeps, nowMs: () => number = Date.now): DashboardDeps {
  let st: { at: number; p: Promise<unknown> } | undefined;
  let le: { at: number; v: ReturnType<DashboardDeps["learning"]["snapshot"]> } | undefined;
  return {
    ...deps,
    status: () => {
      const t = nowMs();
      if (st && t - st.at < STATUS_TTL_MS) return st.p;
      const entry = { at: t, p: Promise.resolve().then(() => deps.status()) };
      st = entry;
      entry.p.catch(() => { if (st === entry) st = undefined; });
      return entry.p;
    },
    learning: {
      snapshot: (...args: Parameters<DashboardDeps["learning"]["snapshot"]>) => {
        const t = nowMs();
        if (le && t - le.at < LEARNING_TTL_MS) return le.v;
        const v = deps.learning.snapshot(...args);
        le = { at: t, v };
        return v;
      },
    },
  };
}

const forbidden = (): DashboardResponse => json(403, { error: "許可されていない Host です" });

/** node:http 用のハンドラー */
export function createDashboardHandler(
  deps: DashboardDeps,
  opts: DashboardHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const cached = withDashboardCaches(deps);
  return async (req, res) => {
    const port = req.socket?.localPort;
    const allowed = opts.allowedHosts ?? (port !== undefined ? dashboardAllowedHosts(port) : new Set<string>());
    const r = isAllowedHost(req.headers?.host, allowed)
      ? await routeDashboard(cached, req.method ?? "GET", req.url ?? "/")
      : forbidden();
    res.writeHead(r.status, r.headers);
    res.end(req.method === "HEAD" ? undefined : r.body);
  };
}

export interface DashboardServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** 待ち受け開始 (既定 127.0.0.1) */
export function startDashboard(deps: DashboardDeps, opts: { host?: string; port: number }): Promise<DashboardServer> {
  const host = opts.host || "127.0.0.1";
  // 許可 Host は listen 後に実ポートで確定する (port: 0 の場合があるため)。確定前は全て拒否
  const allowedHosts = new Set<string>();
  const handler = createDashboardHandler(deps, { allowedHosts });
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      log.error("ダッシュボードの応答に失敗", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) res.writeHead(500, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("内部エラー");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      for (const h of dashboardAllowedHosts(port, host)) allowedHosts.add(h);
      const shownHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        url: `http://${shownHost}:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
