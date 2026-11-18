import { Prisma, type Platform } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { ParsedProduct } from "../scraper/parse";
import { PLACEHOLDER_SUPPLIER_NAME, defaultCurrency, placeholderSupplierId } from "./common";

export interface CreateProductFetchInfo {
  /** PENDING: 商品ページは未取得 (自動探索の検索結果から登録した場合など) */
  status: "OK" | "FAILED" | "PENDING";
  note: string | null;
  parsedFields: string[];
}

export interface CreateProductArgs {
  platform: Platform;
  externalId: string;
  canonicalUrl: string;
  parsed: Pick<ParsedProduct, "title" | "currency" | "priceTiers" | "moq" | "inStock" | "stockQty" | "supplierName" | "supplierId" | "supplierUrl"> | null;
  fetch: CreateProductFetchInfo;
  /** 商品ページを取得した時刻 (未取得なら null。null の商品は次回の巡回で優先的に取得される) */
  fetchedAt: Date | null;
  actor: string;
  audit: { action: string; after: Prisma.InputJsonValue };
  /** 試算用の追加項目 (自動探索の前提値など) */
  extra?: Pick<Prisma.ProductUncheckedCreateInput, "weightKg" | "lengthCm" | "widthCm" | "heightCm" | "domesticPriceJpy" | "targetQuantity" | "domesticRefId">;
}

const findExisting = (platform: Platform, externalId: string) =>
  prisma.product.findUnique({ where: { platform_externalId: { platform, externalId } }, include: { supplier: true } });

/**
 * 商品 (と業者) を登録する共通処理。URL 取り込みと自動探索の両方で使う。
 * 業者は upsert (仮の業者名・ショップ URL は後から補完)、段階単価があれば初回スナップショットも保存し、監査ログを残す。
 * 同じ商品が同時に登録された場合 (一意制約違反) は既存を返す。利益の自動計算は呼び出し側で行う。
 */
export async function createProductRecord(args: CreateProductArgs) {
  const { platform, externalId, parsed, fetch } = args;
  const supplierExternalId = parsed?.supplierId ?? placeholderSupplierId(platform, externalId);
  const tiers = parsed?.priceTiers ?? [];
  try {
    const product = await prisma.$transaction(async (tx) => {
      // 同じ業者の商品を同時に取り込んでも一意制約違反にならないよう upsert (INSERT ... ON CONFLICT) で作成/取得する
      const supplier = await tx.supplier.upsert({
        where: { platform_externalId: { platform, externalId: supplierExternalId } },
        create: { platform, externalId: supplierExternalId, name: parsed?.supplierName ?? PLACEHOLDER_SUPPLIER_NAME, shopUrl: parsed?.supplierUrl ?? null },
        update: {},
      });
      const fill: Prisma.SupplierUpdateInput = {};
      if (!supplier.shopUrl && parsed?.supplierUrl) fill.shopUrl = parsed.supplierUrl;
      if (supplier.name === PLACEHOLDER_SUPPLIER_NAME && parsed?.supplierName) fill.name = parsed.supplierName;
      if (Object.keys(fill).length) await tx.supplier.update({ where: { id: supplier.id }, data: fill });
      const moq = parsed?.moq ?? tiers[0]?.minQty ?? 1;
      const p = await tx.product.create({
        data: {
          ...args.extra,
          platform,
          externalId,
          url: args.canonicalUrl,
          title: parsed?.title ?? args.canonicalUrl,
          currency: (parsed?.currency ?? defaultCurrency(platform)).toUpperCase().slice(0, 3),
          moq: moq > 0 ? moq : 1,
          priceTiers: tiers as unknown as Prisma.InputJsonValue,
          inStock: parsed?.inStock ?? true,
          supplierId: supplier.id,
          fetchStatus: fetch.status,
          fetchNote: fetch.note,
          lastFetchedAt: args.fetchedAt,
        },
      });
      if (tiers.length) {
        await tx.priceSnapshot.create({
          data: {
            productId: p.id,
            currency: p.currency,
            priceTiers: tiers as unknown as Prisma.InputJsonValue,
            moq: p.moq,
            inStock: p.inStock,
            stockQty: parsed?.stockQty ?? null,
          },
        });
      }
      await tx.auditLog.create({ data: { actor: args.actor, action: args.audit.action, entityType: "Product", entityId: p.id, after: args.audit.after } });
      return p;
    });
    return { product, existed: false as const };
  } catch (e) {
    // 同時に同じ商品を取り込んだ場合は既存を返す
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await findExisting(platform, externalId);
      if (existing) return { product: existing, existed: true as const };
    }
    throw e;
  }
}
