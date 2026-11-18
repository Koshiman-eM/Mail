import { XMLParser } from "fast-xml-parser";
import type { IntelItem } from "../../core/types";
import { tagAssets, type TagOptions } from "../assetTagger";
import { defaultFetchText, intelId, stripHtml, type FetchTextFn, type IntelSource } from "./common";

export const DEFAULT_RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://www.fxstreet.com/rss/news",
  "https://finance.yahoo.com/news/rssindex",
];

const MAX_ITEMS_PER_FEED = 50;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

/** "rss:<host>" (www. は除く) */
export function rssSourceId(url: string): string {
  try {
    return `rss:${new URL(url).host.replace(/^www\./, "")}`;
  } catch {
    return `rss:${url}`;
  }
}

/** NEWS_RSS_FEEDS を解釈。先頭 "=" なら既定を置き換え、それ以外は既定に追加 */
export function resolveFeedUrls(envValue: string | undefined, defaults: string[] = DEFAULT_RSS_FEEDS): string[] {
  const raw = (envValue ?? "").trim();
  if (!raw) return [...defaults];
  const override = raw.startsWith("=");
  const urls = (override ? raw.slice(1) : raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s));
  return [...new Set(override ? urls : [...defaults, ...urls])];
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** テキストノード/CDATA/属性付きノードを文字列へ */
function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  return "";
}
function atomLink(link: unknown): string {
  const links = asArray<Record<string, string> | string>(link as any);
  for (const l of links) {
    if (typeof l === "string") return l;
    if (!l["@_rel"] || l["@_rel"] === "alternate") return l["@_href"] ?? "";
  }
  return "";
}

/** RSS 2.0 / Atom をパース (純粋関数) */
export function parseFeed(xml: string, ctx: { source: string; now: number; tag?: TagOptions }): IntelItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const raw: { title: string; body: string; url: string; date: string; guid: string }[] = [];
  if (doc.rss?.channel) {
    for (const it of asArray<any>(doc.rss.channel.item)) {
      raw.push({
        title: text(it.title),
        body: text(it.description) || text(it["content:encoded"]),
        url: text(it.link),
        date: text(it.pubDate) || text(it["dc:date"]),
        guid: text(it.guid),
      });
    }
  } else if (doc.feed) {
    for (const it of asArray<any>(doc.feed.entry)) {
      raw.push({
        title: text(it.title),
        body: text(it.summary) || text(it.content),
        url: atomLink(it.link),
        date: text(it.published) || text(it.updated),
        guid: text(it.id),
      });
    }
  }
  const items: IntelItem[] = [];
  for (const r of raw.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = stripHtml(r.title);
    if (!title) continue;
    const summary = stripHtml(r.body).slice(0, 500) || undefined;
    const t = Date.parse(r.date);
    items.push({
      id: intelId(ctx.source, r.guid || r.url || title),
      source: ctx.source,
      kind: "news",
      title,
      summary,
      url: r.url || undefined,
      publishedAt: Number.isFinite(t) ? t : ctx.now,
      fetchedAt: ctx.now,
      assets: tagAssets(`${title} ${summary ?? ""}`, ctx.tag),
    });
  }
  return items;
}

export interface RssSourceOptions {
  url: string;
  fetchText?: FetchTextFn;
  tag?: TagOptions;
}

export function createRssSource(opts: RssSourceOptions): IntelSource {
  const id = rssSourceId(opts.url);
  const get = opts.fetchText ?? defaultFetchText;
  return { id, fetch: async (now) => parseFeed(await get(opts.url), { source: id, now, tag: opts.tag }) };
}

export function createRssSources(
  opts: { env?: string; fetchText?: FetchTextFn; tag?: TagOptions } = {},
): IntelSource[] {
  const env = opts.env ?? process.env.NEWS_RSS_FEEDS;
  return resolveFeedUrls(env).map((url) => createRssSource({ url, fetchText: opts.fetchText, tag: opts.tag }));
}
