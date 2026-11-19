/**
 * ダッシュボード (node:http)。既定は 127.0.0.1 のみで待ち受ける。
 * 変更系はリスク設定 (POST /api/risk-settings) だけ。それ以外は GET / HEAD のみ (他は 405)。
 * DNS rebinding 対策として Host ヘッダーを検証し、許可外は 403 にする。
 *
 * POST /api/risk-settings の防御 (順に判定):
 *   1. Host 検証 (従来どおり) 2. レート制限 (既定 1 分 10 回、超過は 429)
 *   3. 書き込み権限: ループバック待ち受けのときだけ許可。ループバック以外を bind した場合は
 *      DASHBOARD_WRITE_TOKEN (16 文字以上) と Authorization: Bearer が一致するときだけ (未設定なら 403)
 *   4. Content-Type: application/json 必須 (415) 5. Origin があれば Host と同じで許可 Host であること (403)
 *   6. X-CSRF-Token がページに埋め込んだプロセスごとのトークンと一致すること (403)
 *   7. 本文 8KB まで (413)、JSON として解釈できること (400)
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RiskLimits } from "../core/types";
import { redactSecrets } from "../core/http";
import { createLogger } from "../core/logger";
import { systemClock, type Clock, type Store, type TradingMode } from "../core/types";
import { riskStateKey } from "../risk/manager";
import { applyRiskSettingsChange, riskSettingsView, type RiskMetrics } from "../risk/settings";
import { quoteCurrencyOfSymbol } from "../engine/fx";
import { exitFxRates, exitReasonCounts, summarizeBySide, summarizeByStrategy, tradePnlAccount } from "../engine/report";
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
  /** リスク設定 (省略時は /api/risk-settings が 404) */
  riskSettings?: {
    /** エンジンの mode (上書き値は kv `risk:limits:<mode>`) */
    mode: TradingMode;
    /** .env の値 */
    envLimits: RiskLimits;
    /** 保存後に呼ぶ (動作中の RiskManager に即座に読み直させる。省略時は次のティックで反映) */
    onChange?: () => void;
  };
  /** 内部用: キャッシュの破棄 (withDashboardCaches が設定する) */
  invalidate?: () => void;
}

/** 書き込み (POST) の判定に使う要求の情報。routeDashboard の第 4 引数 */
export interface DashboardRequestContext {
  headers: Record<string, string | string[] | undefined>;
  body?: string;
  /** ページに埋め込んだ CSRF トークン */
  csrfToken: string;
  /** 許可 Host (Origin の検証に使う) */
  allowedHosts: Set<string>;
  /** 待ち受けがループバックか */
  loopback: boolean;
  /** ループバック以外での書き込みトークン (DASHBOARD_WRITE_TOKEN) */
  writeToken?: string;
  rateLimiter: RateLimiter;
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
        // paper で再現した空売り (live では実行できない取引)
        ...(t.simulatedShort ? { simulatedShort: true } : {}),
        attribution: att
          ? {
              outcome: att.outcome,
              causes: att.causes.map((c) => ({ code: c.code, label: CAUSE_LABEL[c.code] ?? c.code, weight: c.weight, evidence: c.evidence })),
            }
          : null,
      };
    }),
    byStrategy: summarizeByStrategy(allInMode, toAccount ?? (() => 1), (t) => quoteOf(t.symbol), rates),
    /** 方向別 (買い / 売り / 空売り (paper 再現))。live で実際にできる成績は空売り (paper 再現) を除いたもの */
    bySide: summarizeBySide(allInMode, toAccount ?? (() => 1), (t) => quoteOf(t.symbol), rates),
    exitReasons: exitReasonCounts(trades),
  };
}

/** ライブ画面に出す監査ログの種類 (それ以外は出さない) */
const EVENT_KIND: Record<string, string> = {
  "engine.entry": "entry", "engine.exit": "exit", "engine.skip_summary": "skip", "engine.plan": "plan",
  "engine.order_rejected": "order", "engine.order_error": "order", "engine.order_cancel": "order", "order.unknown_escalated": "order",
  "order.resolved_by_position": "order", "order.manual_resolve": "order", "engine.entries_paused": "risk", "engine.entries_resumed": "risk",
  "risk.halt_daily": "risk", "risk.kill_switch": "risk", "risk.resume": "risk", "risk.limits_changed": "risk", "engine.kill_switch_close": "risk", "engine.account_degraded": "risk",
  "learning.param_adjust": "learning", "learning.param_revert": "learning", "learning.reflect": "learning", "engine.learning": "learning",
  "engine.start": "system", "engine.stop": "system", "engine.intel_error": "intel", "reconcile.external_close": "order",
};
/** 表示してよい項目だけを取り出す (文字列は伏せ字処理を通す) */
const EVENT_FIELDS = ["symbol", "strategyId", "direction", "reason", "price", "exitPrice", "netPnl", "rMultiple", "qty", "riskOn", "status", "estimated", "param", "from", "to", "action", "raised", "mode"];

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

// ───────── 書き込み (リスク設定) の防御 ─────────

export const RISK_SETTINGS_PATH = "/api/risk-settings";
/** POST 本文の上限 */
export const MAX_POST_BODY_BYTES = 8 * 1024;
/** DASHBOARD_WRITE_TOKEN の最短長 (短いトークンは推測されやすいので無効扱い) */
export const MIN_WRITE_TOKEN_LENGTH = 16;
/** ページに埋め込む CSRF トークンの置き換え位置 (page.ts) */
export const CSRF_PLACEHOLDER = "__CSRF_TOKEN__";
/** プロセスごとの CSRF トークン (起動のたびに変わる。ページを開き直せば新しいトークンになる) */
const PROCESS_CSRF_TOKEN = randomBytes(32).toString("hex");

export interface RateLimiter {
  /** 1 回分を数えて、上限内なら true */
  take(): boolean;
}

/** 固定窓ではなく直近 windowMs の回数で数える簡易レート制限 (プロセス内・全クライアント共通) */
export function createRateLimiter(opts: { limit?: number; windowMs?: number; now?: () => number } = {}): RateLimiter {
  const limit = opts.limit ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let hits: number[] = [];
  return {
    take() {
      const t = now();
      hits = hits.filter((h) => t - h < windowMs);
      if (hits.length >= limit) return false;
      hits.push(t);
      return true;
    },
  };
}

/** 長さに依存しない比較 (ハッシュ同士を timingSafeEqual) */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const header = (h: DashboardRequestContext["headers"], name: string): string | undefined => {
  const v = h[name];
  return typeof v === "string" ? v : undefined;
};

/** 書き込み権限 (ループバック、またはトークン一致)。理由は利用者向けの文言 */
export function writeAccess(ctx: Pick<DashboardRequestContext, "headers" | "loopback" | "writeToken">): { allowed: boolean; needsToken: boolean; reason?: string } {
  if (ctx.loopback) return { allowed: true, needsToken: false };
  const token = ctx.writeToken ?? "";
  if (token.length < MIN_WRITE_TOKEN_LENGTH) {
    return { allowed: false, needsToken: false, reason: `ループバック以外で待ち受けているため変更できません (DASHBOARD_WRITE_TOKEN を ${MIN_WRITE_TOKEN_LENGTH} 文字以上で設定すると、トークンを入力して変更できます)` };
  }
  const auth = header(ctx.headers, "authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m && safeEqual(m[1], token)) return { allowed: true, needsToken: true };
  return { allowed: false, needsToken: true, reason: "書き込みトークンが無いか一致しません" };
}

/** Origin があれば、Host ヘッダーと同じで、かつ許可 Host であること */
function originOk(ctx: DashboardRequestContext): boolean {
  const origin = header(ctx.headers, "origin");
  if (origin === undefined) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // "null" (サンドボックス・file://) など
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = (header(ctx.headers, "host") ?? "").trim().toLowerCase();
  return u.host.toLowerCase() === host && isAllowedHost(u.host, ctx.allowedHosts);
}

/** 現在のドローダウン・日次損失 (status から。取れなければ kv のリスク状態と最新の評価額) */
async function currentRiskMetrics(deps: DashboardDeps, mode: TradingMode): Promise<RiskMetrics> {
  let equity: number | undefined, peak: number | undefined, dayStart: number | undefined, killSwitch: boolean | undefined;
  try {
    const s = (await deps.status()) as { equity?: { current?: unknown }; risk?: { peakEquity?: unknown; dayStartEquity?: unknown; killSwitch?: unknown } } | null;
    if (typeof s?.equity?.current === "number") equity = s.equity.current;
    if (typeof s?.risk?.peakEquity === "number") peak = s.risk.peakEquity;
    if (typeof s?.risk?.dayStartEquity === "number") dayStart = s.risk.dayStartEquity;
    if (s?.risk) killSwitch = Boolean(s.risk.killSwitch);
  } catch { /* 下の kv から */ }
  if (equity === undefined || peak === undefined) {
    const st = deps.store.kvGet<{ peakEquity?: number; dayStartEquity?: number; killSwitch?: unknown }>(riskStateKey(mode));
    peak ??= typeof st?.peakEquity === "number" ? st.peakEquity : undefined;
    dayStart ??= typeof st?.dayStartEquity === "number" ? st.dayStartEquity : undefined;
    killSwitch ??= Boolean(st?.killSwitch);
    equity ??= deps.store.listEquity({ mode }).at(-1)?.equity;
  }
  const fin = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);
  return {
    ...(fin(equity) && fin(peak) && peak > 0 ? { drawdownPct: Math.max(0, (peak - equity) / peak) } : {}),
    ...(fin(equity) && fin(dayStart) && dayStart > 0 ? { dailyLossPct: (dayStart - equity) / dayStart } : {}),
    ...(killSwitch !== undefined ? { killSwitch } : {}),
  };
}

const methodNotAllowed = (allow: string): DashboardResponse => {
  const r = json(405, { error: allow === "GET, HEAD" ? "読み取り専用です" : "このメソッドは使えません" });
  return { ...r, headers: { ...r.headers, allow } };
};

async function postRiskSettings(deps: DashboardDeps, ctx: DashboardRequestContext | undefined, now: number): Promise<DashboardResponse> {
  const rs = deps.riskSettings;
  if (!rs) return json(404, { error: "見つかりません" });
  if (!ctx) return json(403, { error: "書き込みできません" });
  if (!ctx.rateLimiter.take()) return json(429, { error: "変更の回数が多すぎます。1 分ほど待ってから再度お試しください" });
  const access = writeAccess(ctx);
  if (!access.allowed) return json(403, { error: access.reason ?? "書き込みできません" });
  const ct = (header(ctx.headers, "content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") return json(415, { error: "Content-Type は application/json にしてください" });
  if (!originOk(ctx)) return json(403, { error: "許可されていない Origin です" });
  const csrf = header(ctx.headers, "x-csrf-token");
  if (!csrf || !ctx.csrfToken || !safeEqual(csrf, ctx.csrfToken)) return json(403, { error: "CSRF トークンが無いか一致しません。ページを再読み込みしてください" });
  const body = ctx.body ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_POST_BODY_BYTES) return json(413, { error: "本文が大きすぎます" });
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return json(400, { error: "本文が JSON ではありません" });
  }
  const metrics = await currentRiskMetrics(deps, rs.mode);
  const r = applyRiskSettingsChange({ store: deps.store, mode: rs.mode, envLimits: rs.envLimits, request, metrics, now, source: "dashboard" });
  if (!r.ok) {
    const { ok: _ok, status, ...rest } = r;
    return json(status, rest);
  }
  if (r.changed) {
    try {
      rs.onChange?.();
    } catch (e) {
      log.warn("リスク上限の即時反映に失敗 (次のティックで反映します)", { error: e instanceof Error ? e.message : String(e) });
    }
    deps.invalidate?.();
  }
  return json(200, {
    changed: r.changed, raised: r.raised, warnings: r.warnings,
    changes: r.changes,
    settings: riskSettingsView({ store: deps.store, mode: rs.mode, envLimits: rs.envLimits, metrics }),
  });
}

/** ルーティング (listen せずにテストから呼べる)。POST には ctx (要求の情報) が必要 */
export async function routeDashboard(deps: DashboardDeps, method: string, rawUrl: string, ctx?: DashboardRequestContext): Promise<DashboardResponse> {
  const url = new URL(rawUrl, "http://localhost");
  if (method !== "GET" && method !== "HEAD") {
    if (url.pathname !== RISK_SETTINGS_PATH) return methodNotAllowed("GET, HEAD");
    if (method !== "POST") return methodNotAllowed("GET, HEAD, POST");
  }
  const now = (deps.clock ?? systemClock).now();
  try {
    if (method === "POST") return await postRiskSettings(deps, ctx, now);
    switch (url.pathname) {
      case "/":
      case "/index.html":
        return {
          status: 200,
          headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": CSP },
          // トークンは 16 進のみ (属性値にそのまま入れてよい)。ctx が無いときは空 (書き込みできない)
          body: DASHBOARD_HTML.replace(CSRF_PLACEHOLDER, ctx?.csrfToken && /^[0-9a-f]+$/.test(ctx.csrfToken) ? ctx.csrfToken : ""),
        };
      case RISK_SETTINGS_PATH: {
        const rs = deps.riskSettings;
        if (!rs) return json(404, { error: "見つかりません" });
        const metrics = await currentRiskMetrics(deps, rs.mode);
        const access = ctx ? writeAccess(ctx) : { allowed: false, needsToken: false, reason: "書き込みできません" };
        return json(200, { ...riskSettingsView({ store: deps.store, mode: rs.mode, envLimits: rs.envLimits, metrics }), write: access });
      }
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
  /** 待ち受けアドレス (書き込みの可否の判定。省略時はループバック) */
  bindHost?: string;
  /** ループバック以外で待ち受けるときの書き込みトークン (DASHBOARD_WRITE_TOKEN) */
  writeToken?: string;
  /** CSRF トークン (省略時はプロセスごとのトークン) */
  csrfToken?: string;
  /** POST のレート制限 (省略時は 1 分 10 回) */
  rateLimiter?: RateLimiter;
}

/** POST 本文を上限付きで読む。超えたら undefined */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume?.();
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.resume();
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
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
    // リスク設定の保存後に status を取り直させる (上限の表示をすぐ揃える)
    invalidate: () => {
      st = undefined;
      deps.invalidate?.();
    },
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
  const rateLimiter = opts.rateLimiter ?? createRateLimiter();
  const csrfToken = opts.csrfToken ?? PROCESS_CSRF_TOKEN;
  const loopback = isLoopbackHost(opts.bindHost ?? "127.0.0.1");
  return async (req, res) => {
    const port = req.socket?.localPort;
    const allowed = opts.allowedHosts ?? (port !== undefined ? dashboardAllowedHosts(port) : new Set<string>());
    const method = req.method ?? "GET";
    let r: DashboardResponse;
    if (!isAllowedHost(req.headers?.host, allowed)) r = forbidden();
    else {
      let body: string | undefined;
      let tooLarge = false;
      if (method === "POST") {
        body = await readBody(req, MAX_POST_BODY_BYTES);
        tooLarge = body === undefined;
      }
      r = tooLarge
        ? json(413, { error: "本文が大きすぎます" })
        : await routeDashboard(cached, method, req.url ?? "/", {
            headers: req.headers ?? {}, ...(body !== undefined ? { body } : {}), csrfToken, allowedHosts: allowed, loopback, writeToken: opts.writeToken, rateLimiter,
          });
    }
    res.writeHead(r.status, r.headers);
    res.end(method === "HEAD" ? undefined : r.body);
  };
}

export interface DashboardServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** 待ち受け開始 (既定 127.0.0.1) */
export function startDashboard(deps: DashboardDeps, opts: { host?: string; port: number; writeToken?: string }): Promise<DashboardServer> {
  const host = opts.host || "127.0.0.1";
  // 許可 Host は listen 後に実ポートで確定する (port: 0 の場合があるため)。確定前は全て拒否
  const allowedHosts = new Set<string>();
  const handler = createDashboardHandler(deps, { allowedHosts, bindHost: host, ...(opts.writeToken ? { writeToken: opts.writeToken } : {}) });
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
