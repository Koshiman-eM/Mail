import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { priceTierSchema } from "@/lib/profit";
import { autoSimulate } from "@/lib/profit/autoService";
import { analyzeProductUrl } from "@/lib/scraper/url";
import { handler } from "../_lib/http";

export const dynamic = "force-dynamic";

const decStr = z.string().regex(/^\d+(\.\d+)?$/).optional();

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
};
const httpUrl = z.string().max(4000).refine(isHttpUrl, "http:// または https:// で始まる URL を入力してください");

const PLATFORM_LABEL = { ALIBABA: "Alibaba.com", ALI1688: "1688.com", ALIEXPRESS: "AliExpress" } as const;

const createSchema = z
  .object({
    platform: z.enum(["ALIBABA", "ALI1688", "ALIEXPRESS", "OTHER"]),
    url: httpUrl,
    externalId: z.string().min(1),
    title: z.string().min(1),
    titleJa: z.string().optional(),
    currency: z.string().length(3),
    moq: z.number().int().positive(),
    priceTiers: z.array(priceTierSchema).min(1),
    supplier: z.object({ externalId: z.string().min(1), name: z.string().min(1), shopUrl: httpUrl.optional() }),
    domesticRefId: z.string().optional(),
    domesticPriceJpy: decStr,
    lengthCm: decStr,
    widthCm: decStr,
    heightCm: decStr,
    weightKg: decStr,
    hsCode: z.string().optional(),
    targetQuantity: z.number().int().positive().optional(),
    dutyPercent: decStr,
  })
  // SSRF 対策: 対応プラットフォームは、そのサイトの商品 URL のみ登録できる (定期巡回で自動取得されるため)。
  // OTHER は http/https の URL なら登録できるが、自動取得は行わない
  .superRefine((v, ctx) => {
    if (v.platform === "OTHER") return;
    if (analyzeProductUrl(v.url)?.platform !== v.platform) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: `${PLATFORM_LABEL[v.platform]} の商品ページの URL を入力してください` });
    }
  });

export const GET = handler(async () => {
  const products = await prisma.product.findMany({
    include: {
      supplier: true,
      simulations: { orderBy: { createdAt: "desc" }, take: 1, select: { profitJpy: true, roiPercent: true, quantity: true, createdAt: true, auto: true, trigger: true, unitProfitJpy: true, marginPercent: true, totalCostJpy: true, revenueJpy: true, fxRateApplied: true, breakdown: true } },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 30, select: { priceTiers: true, capturedAt: true, inStock: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json(products);
});

export const POST = handler(async (req: Request) => {
  const { supplier, priceTiers, ...p } = createSchema.parse(await req.json());
  // 商品 ID 未入力 (URL がそのまま入っている) なら URL から商品 ID を補完し、URL 取り込みとの重複を防ぐ
  const analyzed = analyzeProductUrl(p.url);
  if (analyzed?.externalId && analyzed.platform === p.platform && p.externalId === p.url) p.externalId = analyzed.externalId;
  const product = await prisma.$transaction(async (tx) => {
    const s = await tx.supplier.upsert({
      where: { platform_externalId: { platform: p.platform, externalId: supplier.externalId } },
      create: { platform: p.platform, ...supplier },
      update: { name: supplier.name, shopUrl: supplier.shopUrl },
    });
    return tx.product.create({
      data: { ...p, supplierId: s.id, priceTiers: priceTiers as unknown as Prisma.InputJsonValue },
    });
  });
  // 登録と同時に既定値で利益を自動計算 (不足項目があれば理由を記録してスキップ)
  const auto = await autoSimulate(product.id, "product.create");
  return NextResponse.json({ ...product, auto }, { status: 201 });
});
