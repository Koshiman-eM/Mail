import type { Prisma, Product, Supplier } from "@prisma/client";
import { prisma } from "../db/prisma";
import { notify } from "../notifications/service";
import { autoSimulate, type AutoTrigger } from "../profit/autoService";
import type { PriceTier } from "../profit/types";
import { detectBlock, type BlockKind } from "../scraper/detect";
import { diffSnapshots } from "../scraper/diff";
import { parseProductPage, type ParsedProduct } from "../scraper/parse";
import type { FetchedPage, PageFetcher } from "../scraper/types";
import { analyzeProductUrl } from "../scraper/url";
import {
  NO_PRICE_NOTE,
  PLACEHOLDER_SUPPLIER_NAME,
  UNFETCHABLE_URL_NOTE,
  blockNote,
  classifyStatus,
  currencyMismatchNote,
  isPlaceholderSupplier,
  isPlaceholderTitle,
  isTransientError,
  parsedFieldsOf,
  shortError,
  statusNote,
} from "./common";
import { isPlatformPaused, pausePlatformForReauth } from "./pause";

export type ScrapeResult =
  | { status: "ok"; productId: string; events: number; auto: string; parsedFields: string[]; note: string | null }
  | { status: "blocked"; productId: string; kind: BlockKind | "paused"; note: string; paused: boolean }
  | { status: "failed"; productId: string; note: string; retryable: boolean; parsedFields: string[] };

export interface ScrapeOptions {
  /** 貼り付けたページソースを解析する (サイトへはアクセスしない) */
  html?: string;
  /** ScraperState が停止中なら取得しない (既定 true。html 指定時は無関係) */
  respectPause?: boolean;
  /** CAPTCHA 等を検知したらプラットフォームを停止し再認証通知を出す (既定 true。html 指定時は停止しない) */
  pauseOnBlock?: boolean;
  /** 利益の自動再計算のトリガー名 */
  trigger?: AutoTrigger;
}

export class ProductNotFoundError extends Error {
  constructor(id: string) {
    super(`Product ${id} not found`);
    this.name = "ProductNotFoundError";
  }
}

type ProductWithSupplier = Product & { supplier: Supplier };

async function markFailed(productId: string, note: string, extra: Prisma.ProductUpdateInput = {}) {
  await prisma.product.update({ where: { id: productId }, data: { fetchStatus: "FAILED", fetchNote: note, lastFetchedAt: new Date(), ...extra } });
}

/**
 * ページから業者情報が取れたら、仮の業者 (業者未設定) を実際の業者に置き換える。
 * 利用者が編集した業者は上書きしない。戻り値は付け替え先の supplierId (変更なしなら undefined)。
 */
export async function resolveSupplierFromParsed(
  tx: Prisma.TransactionClient,
  product: ProductWithSupplier,
  parsed: Pick<ParsedProduct, "supplierId" | "supplierName" | "supplierUrl">,
): Promise<string | undefined> {
  const cur = product.supplier;
  const placeholder = isPlaceholderSupplier(cur);
  if (parsed.supplierId && placeholder && cur.externalId !== parsed.supplierId) {
    // 同じ業者を同時に取り込んでも一意制約違反にならないよう upsert (INSERT ... ON CONFLICT) で作成/取得する
    const s = await tx.supplier.upsert({
      where: { platform_externalId: { platform: product.platform, externalId: parsed.supplierId } },
      create: {
        platform: product.platform,
        externalId: parsed.supplierId,
        // 利用者が仮の業者に名前を付けていればそれを優先
        name: cur.name !== PLACEHOLDER_SUPPLIER_NAME ? cur.name : (parsed.supplierName ?? PLACEHOLDER_SUPPLIER_NAME),
        shopUrl: parsed.supplierUrl ?? cur.shopUrl,
        chatUrl: cur.chatUrl,
      },
      update: {},
    });
    if (!s.shopUrl && parsed.supplierUrl) await tx.supplier.update({ where: { id: s.id }, data: { shopUrl: parsed.supplierUrl } });
    return s.id;
  }
  const data: Prisma.SupplierUpdateInput = {};
  if (cur.name === PLACEHOLDER_SUPPLIER_NAME && parsed.supplierName) data.name = parsed.supplierName;
  if (!cur.shopUrl && parsed.supplierUrl) data.shopUrl = parsed.supplierUrl;
  if (Object.keys(data).length) await tx.supplier.update({ where: { id: cur.id }, data });
  return undefined;
}

/**
 * 1商品の取得〜保存までの共通処理 (BullMQ ワーカー・定期ジョブ・Web アプリの即時取得で共用)。
 * 1. 停止中チェック (ScraperState) 2. 取得 (または貼り付けソース) 3. CAPTCHA/ログイン検知 → 停止 + 再認証通知 (自動突破しない)
 * 4. 解析 5. スナップショット保存・商品更新 (仮の商品名・業者を補完) 6. 差分通知 7. 利益の自動再計算
 * 一時的な障害 (タイムアウト・5xx) は例外にせず `failed` + `retryable: true` を返す。再試行は呼び出し側の責務。
 */
export async function scrapeProduct(productId: string, fetcher: PageFetcher | null, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { supplier: true } });
  if (!product) throw new ProductNotFoundError(productId);
  const pasted = opts.html !== undefined;
  const { platform } = product;

  // SSRF 対策: 対応サイトの商品 URL で、登録したプラットフォームと一致するものだけ取得する (OTHER は取得しない)
  if (!pasted && analyzeProductUrl(product.url)?.platform !== platform) {
    await markFailed(productId, UNFETCHABLE_URL_NOTE);
    return { status: "failed", productId, note: UNFETCHABLE_URL_NOTE, retryable: false, parsedFields: [] };
  }

  if (!pasted && (opts.respectPause ?? true) && (await isPlatformPaused(platform))) {
    return { status: "blocked", productId, kind: "paused", note: blockNote("paused", platform), paused: true };
  }

  let page: FetchedPage;
  if (pasted) {
    page = { finalUrl: product.url, status: 200, html: opts.html ?? "" };
  } else {
    if (!fetcher) throw new Error("fetcher が指定されていません");
    try {
      page = await fetcher.fetch(product.url);
    } catch (e) {
      const retryable = isTransientError(e);
      const note = retryable
        ? `一時的なエラーで取得できませんでした (${shortError(e)})`
        : `取得に失敗しました: ${shortError(e)}`;
      await markFailed(productId, note);
      return { status: "failed", productId, note, retryable, parsedFields: [] };
    }
  }

  const block = detectBlock({ url: page.finalUrl, html: page.html, status: pasted ? undefined : page.status });
  if (block) {
    const note = blockNote(block, platform, { pasted });
    let paused = false;
    if (!pasted && (opts.pauseOnBlock ?? true)) {
      await pausePlatformForReauth(platform, block, page.finalUrl);
      paused = true;
    }
    await markFailed(productId, note);
    return { status: "blocked", productId, kind: block, note, paused };
  }
  if (!pasted) {
    const cls = classifyStatus(page.status);
    if (cls !== "ok") {
      const note = statusNote(page.status);
      await markFailed(productId, note);
      return { status: "failed", productId, note, retryable: cls === "retry", parsedFields: [] };
    }
  }

  const parsed = parseProductPage(page.html, platform === "OTHER" ? undefined : platform);
  const parsedFields = parsedFieldsOf(parsed);
  const hadNoTiers = !Array.isArray(product.priceTiers) || (product.priceTiers as unknown[]).length === 0;
  const fillTitle = parsed.title && isPlaceholderTitle(product) ? { title: parsed.title } : {};

  if (parsed.priceTiers.length === 0) {
    // 価格が取れなくても、商品名・業者が取れていれば補完しておく
    await prisma.$transaction(async (tx) => {
      const supplierId = await resolveSupplierFromParsed(tx, product, parsed);
      await tx.product.update({
        where: { id: productId },
        data: { ...fillTitle, ...(supplierId && { supplierId }), fetchStatus: "FAILED", fetchNote: NO_PRICE_NOTE, lastFetchedAt: new Date() },
      });
    });
    return { status: "failed", productId, note: NO_PRICE_NOTE, retryable: false, parsedFields };
  }

  // 表示通貨が登録時と違う (地域設定の変化等) 場合は、価格を比較できないため更新しない
  const mismatch = currencyMismatchNote(product, parsed.currency);
  if (mismatch) {
    await markFailed(productId, mismatch);
    return { status: "failed", productId, note: mismatch, retryable: false, parsedFields };
  }

  const prev = await prisma.priceSnapshot.findFirst({ where: { productId }, orderBy: { capturedAt: "desc" } });
  const next = { priceTiers: parsed.priceTiers, moq: parsed.moq ?? product.moq, inStock: parsed.inStock };
  // 通貨は価格未取得の商品 (取り込み直後) のときだけ更新する (過去の価格と比較できなくなるため)
  const currency = hadNoTiers && parsed.currency ? parsed.currency : product.currency;
  const note = page.truncated ? "ページが大きいため一部のみ解析しました" : null;

  await prisma.$transaction(async (tx) => {
    const supplierId = await resolveSupplierFromParsed(tx, product, parsed);
    await tx.priceSnapshot.create({
      data: {
        productId,
        currency: parsed.currency ?? currency,
        priceTiers: next.priceTiers as unknown as Prisma.InputJsonValue,
        moq: next.moq,
        inStock: next.inStock,
        stockQty: parsed.stockQty,
      },
    });
    await tx.product.update({
      where: { id: productId },
      data: {
        ...fillTitle,
        ...(supplierId && { supplierId }),
        currency,
        priceTiers: next.priceTiers as unknown as Prisma.InputJsonValue,
        moq: next.moq,
        inStock: next.inStock,
        fetchStatus: "OK",
        fetchNote: note,
        lastFetchedAt: new Date(),
      },
    });
  });

  const events =
    hadNoTiers || !prev
      ? []
      : diffSnapshots({ priceTiers: prev.priceTiers as unknown as PriceTier[], moq: prev.moq, inStock: prev.inStock }, next, product.titleJa ?? (fillTitle.title ?? product.title));
  for (const e of events) {
    await notify({ type: e.kind, severity: e.severity, title: e.title, body: e.body, link: `/products?id=${productId}` });
  }
  // 価格・MOQ が変わったら利益を自動再計算 (変化が無ければ autoSimulate 側で保存を省略)
  const auto = await autoSimulate(productId, opts.trigger ?? "price.change");
  return { status: "ok", productId, events: events.length, auto: auto.status, parsedFields, note };
}
