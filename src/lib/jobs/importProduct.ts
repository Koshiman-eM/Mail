import type { Platform } from "@prisma/client";
import { prisma } from "../db/prisma";
import { autoSimulate } from "../profit/autoService";
import { detectBlock } from "../scraper/detect";
import { parseProductPage, type ParsedProduct } from "../scraper/parse";
import type { FetchedPage, PageFetcher } from "../scraper/types";
import { analyzeProductUrl, canonicalFromHtml, extractUrlFromText, type AnalyzedUrl } from "../scraper/url";
import { NO_PRICE_NOTE, blockNote, classifyStatus, isTransientError, parsedFieldsOf, shortError, statusNote } from "./common";
import { createProductRecord } from "./createProduct";

/** 対応外の URL / URL が見つからない (HTTP 422) */
export class UnsupportedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedUrlError";
  }
}

export interface ImportInput {
  url?: string;
  text?: string;
  /** 取得がブロックされたときに利用者が貼り付けたページソース */
  html?: string;
}

export interface ImportFetchInfo {
  status: "OK" | "FAILED";
  note: string | null;
  parsedFields: string[];
}

const UNSUPPORTED_MSG = "対応していない URL です。Alibaba.com・1688.com・AliExpress の商品ページの URL を指定してください";

/** url / text から URL を取り出して解析する (取得はしない) */
export function resolveImportUrl(input: Pick<ImportInput, "url" | "text">): { url: string; analyzed: AnalyzedUrl } {
  const raw = extractUrlFromText(input.url) || input.url?.trim() || extractUrlFromText(input.text);
  if (!raw) throw new UnsupportedUrlError("商品 URL が見つかりません。商品ページの URL を貼り付けてください");
  const analyzed = analyzeProductUrl(raw);
  if (!analyzed) throw new UnsupportedUrlError(UNSUPPORTED_MSG);
  return { url: raw, analyzed };
}

const findExisting = (platform: Platform, externalId: string) =>
  prisma.product.findUnique({ where: { platform_externalId: { platform, externalId } }, include: { supplier: true } });

/**
 * 商品 URL (または共有テキスト) から仕入れ候補を登録する。
 * 同じ商品が登録済みならそれを返す。ページは HTTP で 1 回だけ取得し (貼り付けソースがあればそれを解析)、
 * CAPTCHA 等で取れなくても URL だけで登録して「取得失敗」と理由を残す (自動突破はしない)。
 * 利用者の操作による単発取得のため、ここではプラットフォームの巡回停止は行わない。
 */
export async function importProduct(input: ImportInput, deps: { fetcher: PageFetcher; actor: string }) {
  let { analyzed } = resolveImportUrl(input);
  const pasted = input.html !== undefined && input.html.trim() !== "";

  if (analyzed.externalId) {
    const existing = await findExisting(analyzed.platform, analyzed.externalId);
    if (existing) return { product: existing, existed: true as const };
  }

  // 1) ページを用意 (貼り付けソース or HTTP 取得)
  let page: FetchedPage | null = null;
  let failNote: string | null = null;
  if (pasted) {
    page = { finalUrl: analyzed.canonicalUrl, status: 200, html: input.html! };
  } else {
    try {
      page = await deps.fetcher.fetch(analyzed.canonicalUrl);
    } catch (e) {
      const msg = shortError(e);
      failNote = isTransientError(e) ? `一時的なエラーで取得できませんでした (${msg})。再取得するか、ページのソースを貼り付けてください` : `取得に失敗しました: ${msg}`;
    }
  }

  // 2) 短縮リンクはリダイレクト先 / canonical から商品 ID を得る
  if (!analyzed.externalId) {
    const candidates = [page && !pasted ? page.finalUrl : null, page ? canonicalFromHtml(page.html) : null];
    const resolved = candidates.map((c) => (c ? analyzeProductUrl(c) : null)).find((a) => a?.externalId && a.platform === analyzed.platform);
    if (!resolved) throw new UnsupportedUrlError("短縮リンクから商品を特定できませんでした。ブラウザで商品ページを開き、その URL を貼り付けてください");
    analyzed = resolved;
    const existing = await findExisting(analyzed.platform, analyzed.externalId!);
    if (existing) return { product: existing, existed: true as const };
  }
  const { platform } = analyzed;
  const externalId = analyzed.externalId!;

  // 3) ブロック検知・解析
  let parsed: ParsedProduct | null = null;
  if (page && !failNote) {
    const block = detectBlock({ url: page.finalUrl, html: page.html, status: pasted ? undefined : page.status });
    if (block) failNote = blockNote(block, platform, { pasted });
    else if (!pasted && classifyStatus(page.status) !== "ok") failNote = statusNote(page.status);
    else {
      parsed = parseProductPage(page.html, platform);
      if (!parsed.priceTiers.length) failNote = NO_PRICE_NOTE;
    }
  }
  const fetch: ImportFetchInfo = {
    status: failNote ? "FAILED" : "OK",
    note: failNote ?? (page?.truncated ? "ページが大きいため一部のみ解析しました" : null),
    parsedFields: parsed ? parsedFieldsOf(parsed) : [],
  };

  // 4) 業者・商品を登録 (自動探索と共通の処理)
  const created = await createProductRecord({
    platform,
    externalId,
    canonicalUrl: analyzed.canonicalUrl,
    parsed,
    fetch,
    fetchedAt: page || failNote ? new Date() : null,
    actor: deps.actor,
    audit: {
      action: "product.import",
      after: { url: analyzed.canonicalUrl, source: pasted ? "pasted-html" : "http", fetchStatus: fetch.status, fetchNote: fetch.note, parsedFields: fetch.parsedFields },
    },
  });
  if (created.existed) return { product: created.product, existed: true as const };
  const product = created.product;

  await autoSimulate(product.id, "product.create");
  const full = await prisma.product.findUniqueOrThrow({ where: { id: product.id }, include: { supplier: true } });
  return { product: full, existed: false as const, fetch };
}
