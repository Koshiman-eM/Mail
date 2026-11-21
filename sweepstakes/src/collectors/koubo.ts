// 公募ガイド (https://koubo.jp) の懸賞カテゴリを収集する Collector
//
// 一覧 (/contest/list?c=13&p=N) → 各項目の詳細 (/contest/{id}) を取得し、CampaignInput に変換する。
// 取得は PoliteFetcher 経由 (正直な User-Agent / robots.txt 確認 / 3〜6 秒間隔 / 403・429 で中止)。
// Next.js のストリーミング SSR で後から差し込まれる部分 (<template id="P:x"> ← <div hidden id="S:x">) は
// 差し込み後の DOM に解決してからパースする。
import { attrs, decodeEntities, stripTags, type Collector } from "../core/collector.js";
import { isExpired, NEEDS_REVIEW_FLAG } from "../core/score.js";
import type { CampaignInput, CampaignKind } from "../core/types.js";
import { FetchBlockedError, HttpError, PoliteFetcher, RobotsDisallowedError, type PoliteFetcherOptions } from "./http.js";

export const KOUBO_BASE_URL = "https://koubo.jp";
/** 懸賞系カテゴリ */
export const KOUBO_PRESENT_CATEGORY = 13;

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** Next.js のストリーミング差し込み (<template id="P:x"> を <… id="S:x"> の中身で置換) を解決する */
export function resolveStreamedSegments(html: string): string {
  const segs = new Map<string, string>();
  const re = /<(\w+)\b[^>]*\bid="S:([0-9a-z]+)"[^>]*>([\s\S]*?)<\/\1>\s*<script>\$RS\("S:\2","P:\2"\)<\/script>/gi;
  for (const m of html.matchAll(re)) segs.set(m[2]!, m[3]!);
  if (!segs.size) return html;
  let out = html;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/<template id="P:([0-9a-z]+)"><\/template>/gi, (all, id: string) => segs.get(id) ?? all);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 「2026年11月30日（月）」「2026年11月30日（月）締切」→ "2026-11-30" */
export function parseJpDate(text: string): string | null {
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
}

function text(s: string | undefined | null): string {
  return s ? stripTags(s) : "";
}

// ---------------------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------------------

export interface KouboListItem {
  id: string;
  detailUrl: string;
  title: string;
  summary: string;
  /** カテゴリ等のタグ (例: 「クイズ」「食品」) */
  tags: string[];
  /** 応募方法などのキーワードタグ (例: 「WEB応募可」) */
  keywords: string[];
  deadline: string | null;
  prize: string;
}

/** キーワードタグ (/contest/list?q=... へのリンク) を取り出す */
function keywordLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrs(m[1]!).href ?? "";
    if (!/\/contest\/list\?(?:[^"]*&)?q=/.test(href)) continue;
    const t = text(m[2]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function parseKouboList(html: string, baseUrl: string = KOUBO_BASE_URL): KouboListItem[] {
  const doc = resolveStreamedSegments(html);
  const out: KouboListItem[] = [];
  for (const m of doc.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    const body = m[1]!;
    const link = body.match(/<a\b[^>]*href="\/contest\/(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const id = link[1]!;
    const title = text(link[2]!.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    if (!title) continue;
    const summary = text(link[2]!.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]);

    // 先頭 section の最初の div にタグ (span) が並ぶ
    const tags: string[] = [];
    const tagBox = body.match(/^\s*<section\b[^>]*>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
    if (tagBox) {
      for (const s of tagBox[1]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
        const t = text(s[1]);
        if (t && !/^\d+$/.test(t)) tags.push(t);
      }
    }

    let deadline: string | null = null;
    let prize = "";
    for (const dd of body.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
      const t = text(dd[1]);
      if (!t) continue;
      if (!deadline && /締切/.test(t) && parseJpDate(t)) deadline = parseJpDate(t);
      else if (!prize) prize = t;
    }

    out.push({
      id,
      detailUrl: new URL(`/contest/${id}`, baseUrl).toString(),
      title,
      summary,
      tags,
      keywords: keywordLinks(body),
      deadline,
      prize,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 詳細
// ---------------------------------------------------------------------------

export interface KouboDetail {
  title: string;
  deadline: string | null;
  organizer: string;
  prize: string;
  /** 下部の「賞」(当選数などの詳細) */
  prizeDetail: string;
  eligibility: string;
  /** 主催者サイト (応募先)。取れなければ null */
  organizerUrl: string | null;
  /** 募集内容 */
  content: string;
  /** 応募方法/応募先 */
  applyMethod: string;
  keywords: string[];
  /** dt/dd の全項目 (規約チェック用) */
  fields: { label: string; value: string }[];
}

export function parseKouboDetail(html: string, baseUrl: string = KOUBO_BASE_URL): KouboDetail {
  const doc = resolveStreamedSegments(html);
  const main = doc.match(/<main\b[^>]*>[\s\S]*?(<article\b[\s\S]*?<\/article>)/i)?.[1] ?? doc.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? doc;

  const fields: { label: string; value: string }[] = [];
  for (const m of main.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = text(m[1]);
    const value = text(m[2]);
    if (label) fields.push({ label, value });
  }
  const first = (re: RegExp) => fields.find((f) => re.test(f.label))?.value ?? "";
  const last = (re: RegExp) => [...fields].reverse().find((f) => re.test(f.label))?.value ?? "";

  let organizerUrl: string | null = null;
  for (const m of main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/主催者サイト/.test(text(m[2]))) continue;
    const href = attrs(m[1]!).href;
    if (!href) continue;
    try {
      const u = new URL(decodeEntities(href), baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      // 掲載サイト自身へのリンクは応募先とみなさない
      if (u.hostname === new URL(baseUrl).hostname) continue;
      organizerUrl = u.toString();
      break;
    } catch {
      continue;
    }
  }

  return {
    title: text(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]),
    deadline: parseJpDate(first(/^締切/)),
    organizer: first(/^主催者$/),
    prize: first(/^賞$/),
    prizeDetail: last(/^賞$/),
    eligibility: first(/^応募資格$/),
    organizerUrl,
    content: first(/^募集内容$/),
    applyMethod: first(/応募方法/),
    keywords: keywordLinks(main),
    fields,
  };
}

// ---------------------------------------------------------------------------
// 種別判定
// ---------------------------------------------------------------------------

export type KouboKind = CampaignKind | "postal_only";

const X_RE = /twitter|ツイッター|(?<![a-z0-9])x(?![a-z0-9])|リポスト|リツイート|retweet|(?<![a-z])rt(?![a-z])/i;
const IG_RE = /instagram|インスタ/i;
const WEB_RE = /応募フォーム|web|ウェブ|ホームページ|ＨＰ|(?<![a-z])hp(?![a-z])|サイト|フォーム|専用ページ/i;
const POSTAL_RE = /はがき|ハガキ|葉書|郵便|郵送|官製|封書|レシート/;

/**
 * 応募方法から種別を判定する。
 * 1. 応募先 URL が X / Instagram → その種別
 * 2. 応募方法に X / Instagram と明記 → その種別
 * 3. 応募方法が Web (フォーム・サイト) か「WEB応募可」タグ → web_form
 * 4. はがき・郵送・レシートのみ → postal_only (収集しない)
 * 5. タイトルに X / Instagram → その種別
 * 6. 判定不能 → web_form (formFiller 側のガードに任せる)
 */
export function decideKouboKind(input: { applyMethod?: string; keywords?: readonly string[]; title?: string; url?: string | null }): KouboKind {
  if (input.url) {
    try {
      const host = new URL(input.url).hostname.toLowerCase();
      if (/(^|\.)(x|twitter)\.com$/.test(host)) return "x";
      if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
    } catch {
      /* 無視 */
    }
  }
  const method = input.applyMethod ?? "";
  const ig = IG_RE.test(method);
  const x = X_RE.test(method);
  if (x && !ig) return "x";
  if (ig && !x) return "instagram";
  if (x && ig) return "x";
  const webTag = (input.keywords ?? []).some((k) => /web応募/i.test(k));
  if (WEB_RE.test(method) || webTag) return "web_form";
  if (POSTAL_RE.test(method)) return "postal_only";
  const title = input.title ?? "";
  if (IG_RE.test(title)) return "instagram";
  if (X_RE.test(title)) return "x";
  return "web_form";
}

// ---------------------------------------------------------------------------
// 変換
// ---------------------------------------------------------------------------

/** 一覧項目 + 詳細 → CampaignInput。はがき・郵送のみなど対象外は null */
export function toCampaignInput(item: KouboListItem, detail: KouboDetail): CampaignInput | null {
  const keywords = [...new Set([...item.keywords, ...detail.keywords])];
  const tags = [...new Set([...item.tags, ...keywords])];
  const kind = decideKouboKind({ applyMethod: detail.applyMethod, keywords, title: detail.title || item.title, url: detail.organizerUrl });
  if (kind === "postal_only") return null;

  const url = detail.organizerUrl ?? item.detailUrl;
  const winnersMatch = (detail.prizeDetail || detail.prize).match(/(\d[\d,]*)\s*(?:名|人|組)/);
  const winners = winnersMatch ? Number(winnersMatch[1]!.replace(/,/g, "")) : null;

  const terms = [item.summary, ...detail.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join("\n");
  const notes = [
    detail.organizer && `主催者: ${detail.organizer}`,
    detail.eligibility && `応募資格: ${detail.eligibility}`,
    detail.applyMethod && `応募方法: ${detail.applyMethod}`,
    !detail.organizerUrl && "応募先 URL が取得できませんでした。掲載ページで応募先を確認してください",
  ]
    .filter(Boolean)
    .join(" / ");

  return {
    kind,
    source: "koubo",
    title: detail.title || item.title,
    url,
    prize: detail.prize || item.prize,
    prizeValueJpy: null,
    winners: winners && winners > 0 ? winners : null,
    participants: null,
    deadline: detail.deadline ?? item.deadline,
    conditions: {
      ...(terms ? { terms } : {}),
      ...(notes ? { notes } : {}),
      ...(tags.length ? { tags } : {}),
      sourceUrl: item.detailUrl,
    },
    estMinutes: null,
    ...(detail.organizerUrl ? {} : { riskFlags: [NEEDS_REVIEW_FLAG] }),
  };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface KouboCollectorOptions extends PoliteFetcherOptions {
  baseUrl?: string;
  category?: number;
  /** 一覧の最大ページ数 (既定 3) */
  maxPages?: number;
  /** 1 回の収集で取得する詳細ページの上限 (既定 60) */
  maxDetails?: number;
  now?: () => Date;
  /** 一覧 URL の組み立て (既定: /contest/list?c={category}&p={page}) */
  listUrl?: (page: number) => string;
}

export interface KouboStats {
  listPages: number;
  listed: number;
  expired: number;
  postalOnly: number;
  detailFetched: number;
  detailFailed: number;
  returned: number;
}

export class KouboCollector implements Collector {
  readonly name = "koubo";
  /** 直近の fetch の内訳 */
  lastStats: KouboStats | null = null;
  private readonly opts: KouboCollectorOptions;

  constructor(opts: KouboCollectorOptions = {}) {
    this.opts = opts;
  }

  listUrl(page: number): string {
    if (this.opts.listUrl) return this.opts.listUrl(page);
    const base = this.opts.baseUrl ?? KOUBO_BASE_URL;
    return new URL(`/contest/list?c=${this.opts.category ?? KOUBO_PRESENT_CATEGORY}&p=${page}`, base).toString();
  }

  async fetch(): Promise<CampaignInput[]> {
    const baseUrl = this.opts.baseUrl ?? KOUBO_BASE_URL;
    const maxPages = Math.max(1, Math.floor(this.opts.maxPages ?? 3));
    const maxDetails = Math.max(0, Math.floor(this.opts.maxDetails ?? 60));
    const now = this.opts.now ?? (() => new Date());
    const log = this.opts.log ?? (() => undefined);
    const fetcher = new PoliteFetcher(this.opts);
    const stats: KouboStats = { listPages: 0, listed: 0, expired: 0, postalOnly: 0, detailFetched: 0, detailFailed: 0, returned: 0 };
    this.lastStats = stats;

    const seen = new Set<string>();
    const candidates: KouboListItem[] = [];
    pages: for (let p = 0; p < maxPages; p++) {
      const items = parseKouboList(await fetcher.get(this.listUrl(p)), baseUrl);
      stats.listPages++;
      if (!items.length) break;
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        stats.listed++;
        if (isExpired(it.deadline, now())) {
          stats.expired++;
          continue;
        }
        if (candidates.length >= maxDetails) break pages;
        candidates.push(it);
      }
    }

    const out: CampaignInput[] = [];
    for (const it of candidates) {
      let html: string;
      try {
        html = await fetcher.get(it.detailUrl);
      } catch (e) {
        // 403/429・robots 拒否はその回の収集を中止。それ以外 (404 など) はその項目だけ飛ばす
        if (e instanceof FetchBlockedError || e instanceof RobotsDisallowedError || !(e instanceof HttpError)) throw e;
        stats.detailFailed++;
        log(`詳細の取得に失敗したため飛ばします: ${e.message}`);
        continue;
      }
      stats.detailFetched++;
      const c = toCampaignInput(it, parseKouboDetail(html, baseUrl));
      if (!c) {
        stats.postalOnly++;
        continue;
      }
      if (isExpired(c.deadline, now())) {
        stats.expired++;
        continue;
      }
      out.push(c);
    }
    stats.returned = out.length;
    return out;
  }
}
