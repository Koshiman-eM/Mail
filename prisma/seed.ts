import { PrismaClient, type Platform, type Prisma } from "@prisma/client";
import type { PriceTier } from "../src/lib/profit";
import { recalcAll } from "../src/lib/profit/autoService";

const prisma = new PrismaClient();

/** 開発用デモデータ (実在しない業者・商品)。何度実行しても重複しない。 */
const SUPPLIERS: { platform: Platform; externalId: string; name: string; rating: string }[] = [
  { platform: "ALIBABA", externalId: "demo-supplier-1", name: "Demo Kitchenware Co., Ltd.", rating: "4.7" },
  { platform: "ALI1688", externalId: "demo-supplier-2", name: "义乌示例日用品商行", rating: "4.5" },
  { platform: "ALIEXPRESS", externalId: "demo-supplier-3", name: "Sample Gadget Store", rating: "4.2" },
];

const PRODUCTS: {
  supplier: number;
  externalId: string;
  title: string;
  titleJa: string;
  currency: string;
  moq: number;
  tiers: PriceTier[];
  history: number[];
  domesticPriceJpy: string;
  dims: [string, string, string];
  weightKg: string;
  qty: number;
  duty: string;
}[] = [
  { supplier: 0, externalId: "demo-product-1", title: "Silicone Kitchen Spatula Set (demo)", titleJa: "シリコンスパチュラ 3本セット (デモ)", currency: "USD", moq: 100, tiers: [{ minQty: 100, unitPrice: "2.50" }, { minQty: 500, unitPrice: "2.00" }, { minQty: 1000, unitPrice: "1.80" }], history: [2.4, 2.4, 2.45, 2.5, 2.5, 2.5], domesticPriceJpy: "1980", dims: ["30", "8", "4"], weightKg: "0.18", qty: 500, duty: "3.4" },
  { supplier: 1, externalId: "demo-product-2", title: "折叠收纳盒 (demo)", titleJa: "折りたたみ収納ボックス (デモ)", currency: "CNY", moq: 50, tiers: [{ minQty: 50, unitPrice: "12.50" }, { minQty: 300, unitPrice: "11.20" }], history: [13.2, 13.0, 12.8, 12.5, 12.5], domesticPriceJpy: "1680", dims: ["32", "24", "6"], weightKg: "0.42", qty: 300, duty: "4.8" },
  { supplier: 2, externalId: "demo-product-3", title: "Mini USB Desk Fan (demo)", titleJa: "USB 卓上ミニ扇風機 (デモ)", currency: "USD", moq: 1, tiers: [{ minQty: 1, unitPrice: "6.20" }, { minQty: 50, unitPrice: "5.40" }], history: [5.9, 6.0, 6.2, 6.2], domesticPriceJpy: "1480", dims: ["15", "12", "20"], weightKg: "0.35", qty: 100, duty: "0" },
  { supplier: 1, externalId: "demo-product-4", title: "硅胶冰格 (demo)", titleJa: "シリコン製製氷皿 (デモ)", currency: "CNY", moq: 100, tiers: [{ minQty: 100, unitPrice: "4.80" }, { minQty: 1000, unitPrice: "4.10" }], history: [4.9, 4.9, 4.8], domesticPriceJpy: "880", dims: ["22", "11", "4"], weightKg: "0.12", qty: 1000, duty: "3.4" },
];


async function main() {
  const suppliers = [];
  for (const s of SUPPLIERS) {
    suppliers.push(
      await prisma.supplier.upsert({
        where: { platform_externalId: { platform: s.platform, externalId: s.externalId } },
        create: { ...s, country: "CN" },
        update: {},
      }),
    );
  }

  for (const p of PRODUCTS) {
    const sup = suppliers[p.supplier];
    const existing = await prisma.product.findUnique({ where: { platform_externalId: { platform: sup.platform, externalId: p.externalId } } });
    if (existing) continue;
    const product = await prisma.product.create({
      data: {
        platform: sup.platform,
        externalId: p.externalId,
        url: `https://example.com/${p.externalId}`,
        title: p.title,
        titleJa: p.titleJa,
        currency: p.currency,
        moq: p.moq,
        priceTiers: p.tiers as unknown as Prisma.InputJsonValue,
        supplierId: sup.id,
        domesticPriceJpy: p.domesticPriceJpy,
        lengthCm: p.dims[0],
        widthCm: p.dims[1],
        heightCm: p.dims[2],
        weightKg: p.weightKg,
        targetQuantity: p.qty,
        dutyPercent: p.duty,
      },
    });
    const day = 24 * 3600 * 1000;
    for (const [i, v] of p.history.entries()) {
      await prisma.priceSnapshot.create({
        data: {
          productId: product.id,
          currency: p.currency,
          priceTiers: [{ minQty: p.tiers[0].minQty, unitPrice: v.toFixed(2) }],
          moq: p.moq,
          inStock: true,
          capturedAt: new Date(Date.now() - (p.history.length - i) * 3 * day),
        },
      });
    }
    void product;
  }

  if ((await prisma.chatMessage.count({ where: { threadId: "demo-thread-1" } })) === 0) {
    await prisma.chatMessage.create({
      data: {
        supplierId: suppliers[0].id,
        threadId: "demo-thread-1",
        direction: "INBOUND",
        originalText: "您好！这款硅胶铲最低起订量是500套，单价2.0美元。可以做OEM，logo印刷需要另加0.1美元。",
        originalLang: "zh",
        translatedText: "こんにちは！このシリコンスパチュラの最低発注数量は500セットで、単価は2.0ドルです。OEM対応可能で、ロゴ印刷は0.1ドル追加になります。",
        status: "RECEIVED",
      },
    });
  }
  // 既定値で全商品の利益を自動計算
  console.log("auto profit:", await recalcAll("manual"));
  console.log("seeded");
}

main()
  .finally(() => prisma.$disconnect())
  // 通知用の Redis 接続が残るため明示的に終了する
  .then(() => process.exit(0), (e) => {
    console.error(e);
    process.exit(1);
  });
