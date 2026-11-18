import type { DiscoveryStatus } from "@prisma/client";
import { PLATFORM_NAME, classifyStatus, shortError } from "../jobs/common";
import { detectBlock } from "../scraper/detect";
import type { PageFetcher } from "../scraper/types";
import { decideDiscovery, estimateDiscovery, planItemStatus, type DiscoveryEstimate } from "./decide";
import { aggregateDomesticPrices, MULTIPACK_NOTE } from "./domestic/aggregate";
import type { DomesticPriceProvider, DomesticSample } from "./domestic/types";
import { parseSearchResults, type SearchItem } from "./searchParse";
import { SEARCH_PLATFORMS, buildSearchUrl, type SearchPlatform } from "./searchUrl";
import type { AutoKeywordMap, DiscoveryStore, DomesticEvidence, WatchRow } from "./types";

/** 国内価格キャッシュの有効期間 */
export const DOMESTIC_CACHE_TTL_MS = 24 * 3600_000;
/** 「今すぐ探索」の連打防止 (同じ条件は 10 分に 1 回) */
export const MANUAL_COOLDOWN_MS = 10 * 60_000;
/** 定期実行では直近 30 分以内に実行した条件は飛ばす */
export const SCHEDULED_COOLDOWN_MS = 30 * 60_000;

export const STATUS_LABEL: Record<DiscoveryStatus, string> = {
  AUTO_ADDED: "自動追加",
  ADDED: "追加済み",
  QUALIFIED: "条件達成",
  BELOW_THRESHOLD: "条件未達",
  NO_DOMESTIC_PRICE: "国内価格なし",
  DUPLICATE: "登録済み",
  DISMISSED: "除外",
  ERROR: "エラー",
};

export interface DiscoveryDeps {
  store: DiscoveryStore;
  /** 検索ページの取得 (遅延生成可) */
  getFetcher: () => Promise<PageFetcher>;
  providers: DomesticPriceProvider[];
  now?: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** リクエスト間の待ち時間 (ジッター込み) */
  delayMs: () => number;
  /** true を返したら以降の取得を打ち切る (実行時間の予算切れ) */
  shouldStop?: () => boolean;
  /** 日本語キーワードの翻訳 (未指定なら日本語のまま検索) */
  translate?: (keywordJa: string, to: "en" | "zh") => Promise<{ text: string; stub: boolean }>;
  /** 国内の販売例のうち残す添字 (Claude による絞り込み。未指定なら絞り込まない) */
  filterTitles?: (keywordJa: string, titles: string[]) => Promise<number[]>;
  log?: (msg: string) => void;
  actor?: string;
}

export interface WatchRunSummary {
  watchId: string;
  name: string;
  status: "OK" | "PARTIAL" | "FAILED" | "SKIPPED";
  note: string;
  counts: Partial<Record<DiscoveryStatus, number>>;
  autoAdded: { productId: string; title: string }[];
}

export interface DiscoveryRunSummary {
  watches: WatchRunSummary[];
  autoAddedTotal: number;
  qualifiedTotal: number;
  stoppedByBudget: boolean;
  blocked: SearchPlatform[];
}

/* ------------------------------------------------------------------ */
/* キーワード                                                          */
/* ------------------------------------------------------------------ */
export const langFor = (p: SearchPlatform): "en" | "zh" => (p === "ALI1688" ? "zh" : "en");

/**
 * プラットフォームごとの検索語を決める。指定があればそれ、無ければ日本語キーワードを翻訳 (結果は条件に保存して再利用)。
 * 翻訳できない (API キー未設定・失敗) 場合は日本語のまま検索し、理由を残す。
 */
export async function resolveForeignKeywords(
  watch: Pick<WatchRow, "keywordJa" | "foreignKeywords" | "autoKeywords">,
  platforms: SearchPlatform[],
  translate?: DiscoveryDeps["translate"],
): Promise<{ keywords: Partial<Record<SearchPlatform, { text: string; note: string | null }>>; autoKeywords: AutoKeywordMap; changed: boolean }> {
  const keywords: Partial<Record<SearchPlatform, { text: string; note: string | null }>> = {};
  const auto: AutoKeywordMap = { ...(watch.autoKeywords ?? {}) };
  let changed = false;
  const byLang = new Map<string, { text: string; stub: boolean } | Error>();
  for (const p of platforms) {
    const explicit = watch.foreignKeywords[p]?.trim();
    if (explicit) {
      keywords[p] = { text: explicit, note: null };
      continue;
    }
    const cached = auto[p];
    if (cached && cached.source === watch.keywordJa && !cached.stub) {
      keywords[p] = { text: cached.text, note: null };
      continue;
    }
    if (!translate) {
      keywords[p] = { text: watch.keywordJa, note: "翻訳しないため日本語のまま検索" };
      continue;
    }
    const lang = langFor(p);
    let r = byLang.get(lang);
    if (!r) {
      try {
        r = await translate(watch.keywordJa, lang);
      } catch (e) {
        r = e instanceof Error ? e : new Error(String(e));
      }
      byLang.set(lang, r);
    }
    if (r instanceof Error) {
      keywords[p] = { text: watch.keywordJa, note: `翻訳に失敗したため日本語のまま検索 (${shortError(r, 80)})` };
    } else if (r.stub) {
      keywords[p] = { text: watch.keywordJa, note: "ANTHROPIC_API_KEY 未設定のため日本語のまま検索 (海外サイト用のキーワードを指定してください)" };
    } else {
      keywords[p] = { text: r.text, note: null };
      auto[p] = { source: watch.keywordJa, text: r.text, stub: false };
      changed = true;
    }
  }
  return { keywords, autoKeywords: auto, changed };
}

/* ------------------------------------------------------------------ */
/* 国内価格                                                            */
/* ------------------------------------------------------------------ */
export type DomesticLookup = { ok: true; priceJpy: string; evidence: DomesticEvidence } | { ok: false; reason: string; evidence: DomesticEvidence | null };

/**
 * 国内価格を調べる: 設定済みの最初の取得元で検索 (24 時間キャッシュ) → (任意) AI で無関係な販売例を除外 → 外れ値除去・下位 25% 点を採用。
 */
export async function lookupDomesticPrice(
  keywordJa: string,
  deps: Pick<DiscoveryDeps, "providers" | "store" | "filterTitles" | "log"> & { now: Date },
): Promise<DomesticLookup> {
  const provider = deps.providers.find((p) => p.isConfigured());
  if (!provider) return { ok: false, reason: "国内価格の取得元が未設定です (設定画面の「国内価格」を参照。楽天 API キーを設定してください)", evidence: null };
  const keyword = keywordJa.replace(/\s+/g, " ").trim();
  let items: DomesticSample[];
  let fetchedAt: Date;
  let cached = false;
  const hit = await deps.store.getDomesticCache(provider.id, keyword, new Date(deps.now.getTime() - DOMESTIC_CACHE_TTL_MS));
  if (hit) {
    items = hit.items;
    fetchedAt = hit.fetchedAt;
    cached = true;
  } else {
    try {
      items = (await provider.search(keyword)).items;
    } catch (e) {
      return { ok: false, reason: `${provider.label}: ${shortError(e, 200)}`, evidence: null };
    }
    fetchedAt = deps.now;
    await deps.store.setDomesticCache(provider.id, keyword, items, fetchedAt);
  }

  const evidence: DomesticEvidence = {
    provider: provider.id,
    providerLabel: provider.label,
    keyword,
    fetchedAt: fetchedAt.toISOString(),
    cached,
    sampleCount: items.length,
    usedCount: 0,
    medianJpy: null,
    lowerQuartileJpy: null,
    adoptedJpy: null,
    basis: "lower-quartile",
    samples: [],
    notes: [MULTIPACK_NOTE],
  };

  let pool = items;
  if (deps.filterTitles && items.length >= 3) {
    try {
      const keep = await deps.filterTitles(keyword, items.map((i) => i.title));
      pool = keep.map((i) => items[i]).filter(Boolean);
      evidence.aiFilter = { before: items.length, after: pool.length };
    } catch (e) {
      evidence.aiFilter = { error: shortError(e, 120) };
      evidence.notes.push("AI による販売例の絞り込みに失敗したため、全件で判定しました");
    }
  }

  const agg = aggregateDomesticPrices(pool);
  if (!agg.ok) {
    evidence.usedCount = agg.used;
    evidence.samples = pool.slice(0, 5);
    return { ok: false, reason: `${provider.label}: ${agg.reason}`, evidence };
  }
  evidence.usedCount = agg.used;
  evidence.medianJpy = agg.medianJpy;
  evidence.lowerQuartileJpy = agg.lowerQuartileJpy;
  evidence.adoptedJpy = agg.priceJpy;
  evidence.samples = agg.samples;
  return { ok: true, priceJpy: agg.priceJpy, evidence };
}

/* ------------------------------------------------------------------ */
/* 実行                                                                */
/* ------------------------------------------------------------------ */
interface RunCtx {
  deps: DiscoveryDeps;
  now: () => Date;
  requests: number;
  blocked: Set<SearchPlatform>;
  stopped: boolean;
  fetcher?: PageFetcher;
}

const BLOCK_LABEL = { captcha: "CAPTCHA", login: "ログイン要求", blocked: "アクセス制限" } as const;

async function fetchSearchPage(ctx: RunCtx, platform: SearchPlatform, keyword: string): Promise<{ ok: true; items: SearchItem[]; source: string } | { ok: false; note: string }> {
  const { deps } = ctx;
  if (ctx.blocked.has(platform) || (await deps.store.isPlatformPaused(platform))) {
    ctx.blocked.add(platform);
    return { ok: false, note: `${PLATFORM_NAME[platform]}: 巡回停止中のため検索しませんでした (設定画面で再開)` };
  }
  if (deps.shouldStop?.()) {
    ctx.stopped = true;
    return { ok: false, note: `${PLATFORM_NAME[platform]}: 時間切れのため次回に検索します` };
  }
  if (ctx.requests > 0) await deps.sleep(deps.delayMs());
  ctx.requests++;
  let url: string;
  try {
    url = buildSearchUrl(platform, keyword);
  } catch (e) {
    return { ok: false, note: `${PLATFORM_NAME[platform]}: ${shortError(e)}` };
  }
  ctx.fetcher ??= await deps.getFetcher();
  let page;
  try {
    page = await ctx.fetcher.fetch(url);
  } catch (e) {
    return { ok: false, note: `${PLATFORM_NAME[platform]}: 検索ページを取得できませんでした (${shortError(e, 120)})` };
  }
  const block = detectBlock({ url: page.finalUrl, html: page.html, status: page.status });
  if (block) {
    ctx.blocked.add(platform);
    await deps.store.pausePlatform(platform, block, page.finalUrl);
    deps.log?.(`[discovery] ${platform}: ${block} を検知したため停止`);
    return { ok: false, note: `${PLATFORM_NAME[platform]}: ${BLOCK_LABEL[block]}を検知したため巡回を停止しました (自動突破はしません。設定画面で再開)` };
  }
  if (classifyStatus(page.status) !== "ok") return { ok: false, note: `${PLATFORM_NAME[platform]}: 検索ページを取得できませんでした (HTTP ${page.status})` };
  const parsed = parseSearchResults(platform, page.html);
  if (!parsed.items.length) return { ok: false, note: `${PLATFORM_NAME[platform]}: 検索結果を読み取れませんでした (ページ構造が変わった可能性があります)` };
  return { ok: true, items: parsed.items, source: parsed.source };
}

const estimateJson = (e: DiscoveryEstimate | null, fxSource: string | null) =>
  e && e.ok
    ? { quantity: e.quantity, unitPriceForeign: e.unitPriceForeign, unitPriceJpy: e.unitPriceJpy, unitProfitJpy: e.unitProfitJpy, fxRateApplied: e.fxRateApplied, fxSource, dimsAssumed: e.dimsAssumed }
    : null;

async function runWatch(ctx: RunCtx, watch: WatchRow, shared: { fx: Map<string, { rate: string; source: string } | null>; settings?: Awaited<ReturnType<DiscoveryStore["getSettings"]>> }): Promise<WatchRunSummary> {
  const { deps } = ctx;
  const store = deps.store;
  const summary: WatchRunSummary = { watchId: watch.id, name: watch.name, status: "OK", note: "", counts: {}, autoAdded: [] };
  const notes: string[] = [];
  const platforms = SEARCH_PLATFORMS.filter((p) => watch.platforms.includes(p));
  if (!platforms.length) {
    summary.status = "FAILED";
    summary.note = "検索するサイトが選ばれていません";
    return summary;
  }

  const kw = await resolveForeignKeywords(watch, platforms, deps.translate);
  if (kw.changed) await store.saveAutoKeywords(watch.id, kw.autoKeywords);

  const domestic = await lookupDomesticPrice(watch.keywordJa, { ...deps, now: ctx.now() });
  notes.push(
    domestic.ok
      ? `国内価格: ${domestic.evidence.providerLabel} ¥${Number(domestic.priceJpy).toLocaleString("ja-JP")} (${domestic.evidence.sampleCount} 件中 ${domestic.evidence.usedCount} 件で判定)`
      : `国内価格: ${domestic.reason}`,
  );
  shared.settings ??= await store.getSettings();
  const settings = shared.settings;

  // 1) 各サイトの検索結果を取得して判定する (保存・自動追加は全サイト分を判定してから)
  interface Pending {
    platform: SearchPlatform;
    item: SearchItem;
    currency: string;
    existing: DiscoveryStatus | null;
    duplicateProductId: string | null;
    estimate: DiscoveryEstimate | null;
    decided: ReturnType<typeof decideDiscovery>;
    fxSource: string | null;
    seenAt: Date;
  }
  const pending: Pending[] = [];
  let okPlatforms = 0;
  for (const platform of platforms) {
    const k = kw.keywords[platform]!;
    const res = await fetchSearchPage(ctx, platform, k.text);
    if (!res.ok) {
      notes.push(res.note);
      continue;
    }
    okPlatforms++;
    let pnote = `${PLATFORM_NAME[platform]}: 「${k.text}」${res.items.length} 件`;
    if (k.note) pnote += ` (${k.note})`;
    notes.push(pnote);

    for (const item of res.items) {
      const existing = await store.getItem(watch.id, platform, item.externalId);
      const duplicateProductId = await store.findProduct(platform, item.externalId, item.url);
      const currency = item.currency ?? (platform === "ALI1688" ? "CNY" : "USD");
      let fx = shared.fx.get(currency);
      if (fx === undefined && item.unitPrice) {
        fx = await store.resolveFx(currency).catch(() => null);
        shared.fx.set(currency, fx);
      }
      const estimate = item.unitPrice && domestic.ok ? estimateDiscovery({ currency, priceTiers: item.priceTiers, moq: item.moq }, domestic.priceJpy, watch, settings, fx?.rate ?? null) : null;
      const decided = decideDiscovery(
        { hasPrice: !!item.unitPrice, moq: item.moq, duplicateProductId, domestic: domestic.ok ? { ok: true } : { ok: false, reason: domestic.reason }, estimate },
        watch,
      );
      pending.push({ platform, item, currency, existing: existing?.status ?? null, duplicateProductId, estimate, decided, fxSource: fx?.source ?? null, seenAt: ctx.now() });
    }
  }

  // 2) 条件を満たすものは ROI の高い順に自動追加する (1 回の上限まで)
  const roiOf = (p: Pending) => (p.estimate?.ok ? Number(p.estimate.roiPercent) : -Infinity);
  const ordered = [...pending].sort((a, b) => Number(b.decided.status === "QUALIFIED") - Number(a.decided.status === "QUALIFIED") || roiOf(b) - roiOf(a));
  for (const { platform, item, currency, existing, duplicateProductId, estimate, decided, fxSource, seenAt } of ordered) {
    const plan = planItemStatus(existing, decided, { autoAdd: watch.autoAdd, autoAddedSoFar: summary.autoAdded.length, maxAutoAddPerRun: watch.maxAutoAddPerRun });
    let status: DiscoveryStatus = plan.status;
    let note = plan.note;
    let productId: string | null = duplicateProductId;
    if (plan.autoAdd) {
      try {
        const created = await store.createProduct({
          item: { ...item, platform, currency },
          watch,
          domesticPriceJpy: domestic.ok ? domestic.priceJpy : null,
          actor: deps.actor ?? "system:discovery",
          action: "discovery.auto_add",
        });
        productId = created.productId;
        if (created.existed) {
          status = "DUPLICATE";
          note = "同じ商品が仕入れ候補に登録済みです";
        } else {
          summary.autoAdded.push({ productId: created.productId, title: item.title });
        }
      } catch (e) {
        status = "QUALIFIED";
        note = `${decided.note} (自動追加に失敗: ${shortError(e, 120)})`;
      }
    }

    await store.upsertItem(
      {
        watchId: watch.id,
        platform,
        externalId: item.externalId,
        url: item.url,
        title: item.title,
        imageUrl: item.imageUrl,
        currency,
        unitPrice: item.unitPrice ?? "0",
        priceTiers: item.priceTiers,
        moq: item.moq ?? 1,
        supplierName: item.supplierName,
        supplierExternalId: item.supplierExternalId,
        shopUrl: item.shopUrl,
        domesticPriceJpy: domestic.ok ? domestic.priceJpy : null,
        domesticEvidence: domestic.evidence,
        estProfitJpy: estimate?.ok ? estimate.profitJpy : null,
        estRoiPercent: estimate?.ok ? estimate.roiPercent : null,
        estimate: estimateJson(estimate, fxSource),
        status,
        statusNote: note,
        productId,
        seenAt,
      },
      plan.keepExisting,
    );
    summary.counts[status] = (summary.counts[status] ?? 0) + 1;
  }

  summary.status = okPlatforms === platforms.length ? "OK" : okPlatforms > 0 ? "PARTIAL" : "FAILED";
  if (summary.autoAdded.length) notes.unshift(`自動追加 ${summary.autoAdded.length} 件`);
  summary.note = notes.join("\n").slice(0, 2000);
  return summary;
}

/**
 * 自動探索を実行する。watchId 指定時はその条件のみ (呼び出し側で claim 済みなら claimed: true)、未指定なら有効な条件すべて。
 * 各条件について: 検索語の決定 → 国内価格 (キャッシュ) → 各サイトの検索結果 1 ページ (サイト間はジッター付きの間隔) →
 * 判定・保存 → 条件を満たすものを自動追加 (1 回の上限まで)。CAPTCHA 等はプラットフォームを停止して手動再認証を促す。
 * 自動追加・条件達成があれば実行ごとに 1 件だけ通知する。
 */
export async function runDiscovery(opts: { watchId?: string; claimed?: boolean }, deps: DiscoveryDeps): Promise<DiscoveryRunSummary> {
  const now = deps.now ?? (() => new Date());
  const ctx: RunCtx = { deps, now, requests: 0, blocked: new Set(), stopped: false };
  const out: DiscoveryRunSummary = { watches: [], autoAddedTotal: 0, qualifiedTotal: 0, stoppedByBudget: false, blocked: [] };
  const shared: Parameters<typeof runWatch>[2] = { fx: new Map() };
  const watches = await deps.store.listWatches(opts.watchId);

  for (const w of watches) {
    if (deps.shouldStop?.()) {
      ctx.stopped = true;
      out.watches.push({ watchId: w.id, name: w.name, status: "SKIPPED", note: "時間切れのため次回に実行します", counts: {}, autoAdded: [] });
      continue;
    }
    if (!opts.claimed && !(await deps.store.claimWatch(w.id, now(), SCHEDULED_COOLDOWN_MS))) {
      out.watches.push({ watchId: w.id, name: w.name, status: "SKIPPED", note: "直近に実行済みのため飛ばしました", counts: {}, autoAdded: [] });
      continue;
    }
    let s: WatchRunSummary;
    try {
      s = await runWatch(ctx, w, shared);
    } catch (e) {
      s = { watchId: w.id, name: w.name, status: "FAILED", note: `想定外のエラー: ${shortError(e)}`, counts: {}, autoAdded: [] };
      deps.log?.(`[discovery] ${w.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
    await deps.store.finishWatch(w.id, { status: s.status, note: s.note }).catch((e) => deps.log?.(`[discovery] finishWatch failed: ${shortError(e)}`));
    out.watches.push(s);
  }

  out.autoAddedTotal = out.watches.reduce((a, w) => a + w.autoAdded.length, 0);
  out.qualifiedTotal = out.watches.reduce((a, w) => a + (w.counts.QUALIFIED ?? 0), 0);
  out.stoppedByBudget = ctx.stopped;
  out.blocked = [...ctx.blocked];

  if (out.autoAddedTotal > 0 || out.qualifiedTotal > 0) {
    const titles = out.watches.flatMap((w) => w.autoAdded.map((a) => `・${a.title.slice(0, 60)}`)).slice(0, 5);
    const title =
      out.autoAddedTotal > 0
        ? `自動探索: ${out.autoAddedTotal} 件を仕入れ候補に追加しました`
        : `自動探索: 条件を満たす商品が ${out.qualifiedTotal} 件見つかりました`;
    const body = [
      ...out.watches.filter((w) => w.status !== "SKIPPED").map((w) => `${w.name}: 自動追加 ${w.autoAdded.length} 件 / 条件達成 (未追加) ${w.counts.QUALIFIED ?? 0} 件`),
      ...titles,
    ].join("\n");
    await deps.store.notify({ title, body, link: "/discover" }).catch((e) => deps.log?.(`[discovery] notify failed: ${shortError(e)}`));
  }
  // fetcher の close は生成した呼び出し側の責務 (定期ジョブでは巡回と共用するため)
  return out;
}

export function formatDiscoverySummary(s: DiscoveryRunSummary): string {
  if (!s.watches.length) return "自動探索: 有効な探索条件はありません";
  const lines = s.watches.map((w) => {
    const counts = Object.entries(w.counts)
      .map(([k, v]) => `${STATUS_LABEL[k as DiscoveryStatus]} ${v}`)
      .join(", ");
    return `自動探索 [${w.name}] ${w.status}${counts ? ` (${counts})` : ""}\n${w.note
      .split("\n")
      .map((l) => `  - ${l}`)
      .join("\n")}`;
  });
  lines.push(`自動探索: 自動追加 合計 ${s.autoAddedTotal} 件${s.stoppedByBudget ? " / 時間切れで一部未実行" : ""}${s.blocked.length ? ` / 停止中: ${s.blocked.join(", ")}` : ""}`);
  return lines.join("\n");
}

