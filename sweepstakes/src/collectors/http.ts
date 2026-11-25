// 実在サイト用 Collector の共通 HTTP ユーティリティ
//
// 礼儀ルール:
// - User-Agent は正直な識別子 (ブラウザ偽装はしない)
// - robots.txt を実行時に取得し、対象パスが Disallow なら取得しない
// - リクエスト間隔はランダム (既定 3〜6 秒)
// - 403 / 429 を受けたらその回の収集を中止する (回避・リトライはしない)

export const DEFAULT_USER_AGENT = "sweepstakes-collector/0.1 (+personal use)";
/** robots.txt のグループ照合に使うプロダクトトークン */
export const DEFAULT_UA_TOKEN = "sweepstakes-collector";

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; redirect?: "follow" | "error" | "manual" }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

/** 403 / 429 など、収集を中止すべき応答 */
export class FetchBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url} が ${status} を返したため収集を中止しました (回避はしません)`);
    this.name = "FetchBlockedError";
  }
}

/** robots.txt で取得が許可されていない */
export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt で ${url} の取得が許可されていないため収集を中止しました`);
    this.name = "RobotsDisallowedError";
  }
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url} の取得に失敗しました (HTTP ${status})`);
    this.name = "HttpError";
  }
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309 の簡易実装)
// ---------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  /** true: 全許可 (404 など) / false: 全拒否 (5xx など) / undefined: groups で判定 */
  allowAll?: boolean;
}

export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!cur) continue;
      // 空の Disallow は「制限なし」なので規則として扱わない
      if (value === "") continue;
      cur.rules.push({ allow: key === "allow", path: value });
    } else {
      // Sitemap / Content-Signal / Crawl-delay などはグループの区切りにしない
      lastWasAgent = false;
    }
  }
  return { groups };
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

function normalizeForMatch(s: string): string {
  // %xx の大文字小文字を揃える程度の正規化
  return s.replace(/%[0-9a-f]{2}/gi, (x) => x.toUpperCase());
}

/**
 * path (クエリ含む) が取得可能か。
 * 自分のトークンに一致するグループがあればそれ (複数あれば統合)、なければ `*` のグループ (複数あれば統合) を使う。
 * 最長一致の規則を採用し、同じ長さなら Allow を優先する。
 */
export function isAllowedByRobots(robots: RobotsTxt, pathWithQuery: string, uaToken: string = DEFAULT_UA_TOKEN): boolean {
  if (robots.allowAll !== undefined) return robots.allowAll;
  const token = uaToken.toLowerCase();
  let matched = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  if (!matched.length) matched = robots.groups.filter((g) => g.agents.includes("*"));
  const path = normalizeForMatch(pathWithQuery);
  let best: RobotsRule | null = null;
  for (const g of matched) {
    for (const r of g.rules) {
      if (!ruleMatches(normalizeForMatch(r.path), path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// 礼儀正しい取得
// ---------------------------------------------------------------------------

export interface PoliteFetcherOptions {
  fetch?: FetchLike;
  userAgent?: string;
  uaToken?: string;
  /** リクエスト間隔 (ms)。この範囲でランダム */
  minDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

export class PoliteFetcher {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly uaToken: string;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  private readonly robotsCache = new Map<string, RobotsTxt>();
  private requested = false;
  /** 実際に送ったリクエスト数 (robots.txt を含む) */
  requestCount = 0;

  constructor(opts: PoliteFetcherOptions = {}) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.uaToken = opts.uaToken ?? DEFAULT_UA_TOKEN;
    this.minDelayMs = opts.minDelayMs ?? 3000;
    this.maxDelayMs = Math.max(this.minDelayMs, opts.maxDelayMs ?? 6000);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? (() => undefined);
  }

  private async raw(url: string): Promise<{ status: number; ok: boolean; body: string }> {
    if (this.requested) {
      const wait = Math.round(this.minDelayMs + (this.maxDelayMs - this.minDelayMs) * this.random());
      if (wait > 0) await this.sleep(wait);
    }
    this.requested = true;
    this.requestCount++;
    this.log(`GET ${url}`);
    const res = await this.fetchImpl(url, { headers: { "User-Agent": this.userAgent, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, redirect: "follow" });
    if (res.status === 403 || res.status === 429) throw new FetchBlockedError(url, res.status);
    return { status: res.status, ok: res.ok, body: res.ok ? await res.text() : "" };
  }

  async robots(origin: string): Promise<RobotsTxt> {
    const cached = this.robotsCache.get(origin);
    if (cached) return cached;
    const url = `${origin}/robots.txt`;
    const r = await this.raw(url);
    let robots: RobotsTxt;
    if (r.ok) robots = parseRobotsTxt(r.body);
    else if (r.status >= 500) robots = { groups: [], allowAll: false }; // サーバーエラー時は全拒否とみなす
    else robots = { groups: [], allowAll: true }; // 404 などは制限なし
    this.robotsCache.set(origin, robots);
    return robots;
  }

  /** robots.txt を確認してから HTML/テキストを取得する */
  async get(url: string): Promise<string> {
    const u = new URL(url);
    const robots = await this.robots(u.origin);
    if (!isAllowedByRobots(robots, u.pathname + u.search, this.uaToken)) throw new RobotsDisallowedError(url);
    const r = await this.raw(url);
    if (!r.ok) throw new HttpError(url, r.status);
    return r.body;
  }
}
