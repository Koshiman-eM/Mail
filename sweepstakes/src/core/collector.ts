// 収集 (Collector) のインターフェースと、合成 HTML を読む例示用の実装
import { readFile } from "node:fs/promises";
import type { CampaignInput, CampaignKind, ConditionStep, StepAction } from "./types.js";
import { CAMPAIGN_KINDS } from "./types.js";

/** 懸賞情報の取得元。実在サイト用の実装はこのインターフェースに合わせて追加する */
export interface Collector {
  readonly name: string;
  fetch(): Promise<CampaignInput[]>;
}

// ---------------------------------------------------------------------------
// 例示用パーサー (tests/fixtures/campaign_list.html の合成フォーマット)
//
// <article class="campaign" data-kind="web_form" data-url="..." data-deadline="2026-12-31"
//          data-prize-value="30000" data-winners="5" data-participants="2000" data-minutes="3">
//   <h2 class="title">...</h2>
//   <p class="prize">...</p>
//   <ul class="steps"><li data-action="follow" data-target="@foo">...</li></ul>
//   <div class="terms">...</div>
// </article>
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return out;
}

function classInner(block: string, cls: string): string | null {
  const re = new RegExp(`<(\\w+)[^>]*class\\s*=\\s*["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
  const m = block.match(re);
  return m ? m[2]! : null;
}

function optNum(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.replace(/[,_]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const ACTIONS: readonly StepAction[] = ["follow", "repost", "like", "comment", "quote", "hashtag", "visit", "join_discord", "connect_wallet", "custom"];

export function parseCampaignListHtml(html: string, source: string, baseUrl?: string): CampaignInput[] {
  const out: CampaignInput[] = [];
  for (const m of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const a = attrs(m[1]!);
    if (!/\bcampaign\b/.test(a.class ?? "")) continue;
    const body = m[2]!;
    const kind = (a["data-kind"] ?? "web_form") as CampaignKind;
    if (!CAMPAIGN_KINDS.includes(kind)) continue;
    let url = a["data-url"] ?? "";
    if (!url) {
      const link = body.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
      url = link ? decodeEntities(link[1]!) : "";
    }
    if (!url) continue;
    try {
      url = new URL(url, baseUrl).toString();
    } catch {
      continue;
    }
    const title = stripTags(classInner(body, "title") ?? "") || url;
    const steps: ConditionStep[] = [];
    const stepsHtml = classInner(body, "steps");
    if (stepsHtml) {
      for (const li of stepsHtml.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
        const la = attrs(li[1]!);
        const action = (ACTIONS.includes(la["data-action"] as StepAction) ? la["data-action"] : "custom") as StepAction;
        const text = stripTags(li[2]!);
        steps.push({ action, ...(la["data-target"] ? { target: la["data-target"] } : {}), ...(text ? { text } : {}) });
      }
    }
    const terms = classInner(body, "terms");
    const notes = classInner(body, "notes");
    const risk = (a["data-risk"] ?? "").split(/[,\s]+/).filter(Boolean);
    out.push({
      kind,
      source,
      title,
      url,
      prize: stripTags(classInner(body, "prize") ?? ""),
      prizeValueJpy: optNum(a["data-prize-value"]),
      winners: optNum(a["data-winners"]),
      participants: optNum(a["data-participants"]),
      deadline: a["data-deadline"] || null,
      conditions: {
        ...(steps.length ? { steps } : {}),
        ...(terms ? { terms: stripTags(terms) } : {}),
        ...(notes ? { notes: stripTags(notes) } : {}),
      },
      estMinutes: optNum(a["data-minutes"]),
      ...(risk.length ? { riskFlags: risk } : {}),
    });
  }
  return out;
}

/** ローカル HTML ファイルを読む例示用 Collector (外部アクセスなし) */
export class FixtureHtmlCollector implements Collector {
  readonly name: string;
  constructor(
    private readonly filePath: string,
    name = "fixture",
    /** 相対 URL 解決用 */
    private readonly baseUrl?: string,
  ) {
    this.name = name;
  }
  async fetch(): Promise<CampaignInput[]> {
    const html = await readFile(this.filePath, "utf8");
    return parseCampaignListHtml(html, this.name, this.baseUrl);
  }
}
