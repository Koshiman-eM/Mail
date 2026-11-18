import type { DiscoveryWatch, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { createProductRecord } from "../jobs/createProduct";
import { isPlatformPaused, pausePlatformForReauth } from "../jobs/pause";
import { parsedFieldsOf } from "../jobs/common";
import { notify } from "../notifications/service";
import { autoSimulate, getProfitSettings, resolveFxRate, toAutoSettings } from "../profit/autoService";
import type { ParsedProduct } from "../scraper/parse";
import type { DomesticSample } from "./domestic/types";
import type { AutoKeywordMap, DiscoveryStore, ItemForProduct, KeywordMap, WatchRow } from "./types";

const str = (d: { toString(): string } | null | undefined) => (d === null || d === undefined ? null : d.toString());

export function toWatchRow(w: DiscoveryWatch): WatchRow {
  return {
    id: w.id,
    name: w.name,
    keywordJa: w.keywordJa,
    foreignKeywords: (w.foreignKeywords ?? {}) as KeywordMap,
    autoKeywords: (w.autoKeywords ?? null) as AutoKeywordMap | null,
    platforms: w.platforms,
    enabled: w.enabled,
    estWeightKg: w.estWeightKg.toString(),
    estLengthCm: str(w.estLengthCm),
    estWidthCm: str(w.estWidthCm),
    estHeightCm: str(w.estHeightCm),
    targetQuantity: w.targetQuantity,
    minRoiPercent: w.minRoiPercent.toString(),
    minProfitJpy: str(w.minProfitJpy),
    maxMoq: w.maxMoq,
    maxUnitPriceJpy: str(w.maxUnitPriceJpy),
    autoAdd: w.autoAdd,
    maxAutoAddPerRun: w.maxAutoAddPerRun,
    lastRunAt: w.lastRunAt,
  };
}

/** 探索結果を、URL 取り込みと同じ経路 (createProductRecord) で商品として登録し、利益を自動計算する */
export async function createProductFromItem(input: { item: ItemForProduct; watch: Pick<WatchRow, "id" | "name" | "estWeightKg" | "estLengthCm" | "estWidthCm" | "estHeightCm" | "targetQuantity">; domesticPriceJpy: string | null; actor: string; action: string; discoveredItemId?: string }) {
  const { item, watch } = input;
  const parsed: Pick<ParsedProduct, "title" | "currency" | "priceTiers" | "moq" | "inStock" | "stockQty" | "supplierName" | "supplierId" | "supplierUrl"> = {
    title: item.title,
    currency: item.currency,
    priceTiers: item.priceTiers,
    moq: item.moq,
    inStock: true,
    stockQty: null,
    supplierName: item.supplierName,
    supplierId: item.supplierExternalId,
    supplierUrl: item.shopUrl,
  };
  const r = await createProductRecord({
    platform: item.platform,
    externalId: item.externalId,
    canonicalUrl: item.url,
    parsed,
    fetch: {
      status: "PENDING",
      note: "自動探索の検索結果から登録しました。商品ページ (段階単価・業者情報) は次回の巡回で取得します",
      parsedFields: parsedFieldsOf({ ...parsed, source: [] }),
    },
    // 未取得 (null) にしておくと次回の巡回で商品ページを優先的に取得する
    fetchedAt: null,
    actor: input.actor,
    audit: { action: input.action, after: { watchId: watch.id, watchName: watch.name, discoveredItemId: input.discoveredItemId ?? null, url: item.url, domesticPriceJpy: input.domesticPriceJpy } },
    extra: {
      weightKg: watch.estWeightKg,
      lengthCm: watch.estLengthCm,
      widthCm: watch.estWidthCm,
      heightCm: watch.estHeightCm,
      domesticPriceJpy: input.domesticPriceJpy,
      targetQuantity: watch.targetQuantity > 1 ? watch.targetQuantity : null,
    },
  });
  if (!r.existed) await autoSimulate(r.product.id, "product.create");
  return { productId: r.product.id, existed: r.existed };
}

export function createPrismaDiscoveryStore(): DiscoveryStore {
  return {
    async listWatches(watchId) {
      const rows = watchId
        ? await prisma.discoveryWatch.findMany({ where: { id: watchId } })
        : await prisma.discoveryWatch.findMany({ where: { enabled: true }, orderBy: { lastRunAt: { sort: "asc", nulls: "first" } } });
      return rows.map(toWatchRow);
    },
    async claimWatch(id, now, cooldownMs) {
      const r = await prisma.discoveryWatch.updateMany({
        where: { id, OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - cooldownMs) } }] },
        data: { lastRunAt: now, lastRunStatus: "RUNNING", lastRunNote: null },
      });
      return r.count === 1;
    },
    async finishWatch(id, data) {
      await prisma.discoveryWatch.update({ where: { id }, data: { lastRunStatus: data.status, lastRunNote: data.note } });
    },
    async saveAutoKeywords(id, kw) {
      await prisma.discoveryWatch.update({ where: { id }, data: { autoKeywords: kw as Prisma.InputJsonValue } });
    },
    async getSettings() {
      return toAutoSettings(await getProfitSettings());
    },
    async resolveFx(currency) {
      return resolveFxRate(currency, await getProfitSettings());
    },
    isPlatformPaused: (p) => isPlatformPaused(p),
    async pausePlatform(p, kind, url) {
      await pausePlatformForReauth(p, kind, url);
    },
    async findProduct(platform, externalId, url) {
      const p = await prisma.product.findFirst({ where: { OR: [{ platform, externalId }, { url }] }, select: { id: true } });
      return p?.id ?? null;
    },
    async getItem(watchId, platform, externalId) {
      return prisma.discoveredItem.findUnique({ where: { watchId_platform_externalId: { watchId, platform, externalId } }, select: { id: true, status: true, productId: true } });
    },
    async upsertItem(d, keepStatus) {
      const common = {
        url: d.url,
        title: d.title,
        imageUrl: d.imageUrl,
        currency: d.currency.slice(0, 3),
        unitPrice: d.unitPrice,
        priceTiers: d.priceTiers as unknown as Prisma.InputJsonValue,
        moq: d.moq,
        supplierName: d.supplierName,
        supplierExternalId: d.supplierExternalId,
        shopUrl: d.shopUrl,
        domesticPriceJpy: d.domesticPriceJpy,
        domesticEvidence: (d.domesticEvidence ?? undefined) as Prisma.InputJsonValue | undefined,
        estProfitJpy: d.estProfitJpy,
        estRoiPercent: d.estRoiPercent,
        estimate: (d.estimate ?? undefined) as Prisma.InputJsonValue | undefined,
        lastSeenAt: d.seenAt,
      };
      const statusFields = { status: d.status, statusNote: d.statusNote, productId: d.productId };
      await prisma.discoveredItem.upsert({
        where: { watchId_platform_externalId: { watchId: d.watchId, platform: d.platform, externalId: d.externalId } },
        create: { watchId: d.watchId, platform: d.platform, externalId: d.externalId, firstSeenAt: d.seenAt, ...common, ...statusFields },
        update: keepStatus ? common : { ...common, ...statusFields },
      });
    },
    async getDomesticCache(provider, keyword, notBefore) {
      const c = await prisma.domesticPriceCache.findUnique({ where: { provider_keyword: { provider, keyword } } });
      if (!c || c.fetchedAt < notBefore) return null;
      const items = (c.result as { items?: DomesticSample[] } | null)?.items;
      return Array.isArray(items) ? { items, fetchedAt: c.fetchedAt } : null;
    },
    async setDomesticCache(provider, keyword, items, at) {
      const result = { items } as unknown as Prisma.InputJsonValue;
      await prisma.domesticPriceCache.upsert({
        where: { provider_keyword: { provider, keyword } },
        create: { provider, keyword, result, fetchedAt: at },
        update: { result, fetchedAt: at },
      });
    },
    createProduct: (input) => createProductFromItem(input),
    async notify(n) {
      await notify({ type: "DISCOVERY", severity: "INFO", title: n.title, body: n.body, link: n.link, meta: { kind: "discovery" } });
    },
  };
}
