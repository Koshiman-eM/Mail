import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** 開発用デモデータ (実在しない業者・商品) */
async function main() {
  const supplier = await prisma.supplier.upsert({
    where: { platform_externalId: { platform: "ALIBABA", externalId: "demo-supplier-1" } },
    create: { platform: "ALIBABA", externalId: "demo-supplier-1", name: "Demo Kitchenware Co., Ltd.", country: "CN", rating: "4.7" },
    update: {},
  });
  await prisma.product.upsert({
    where: { platform_externalId: { platform: "ALIBABA", externalId: "demo-product-1" } },
    create: {
      platform: "ALIBABA",
      externalId: "demo-product-1",
      url: "https://example.com/demo-product-1",
      title: "Silicone Kitchen Spatula Set (demo)",
      titleJa: "シリコンキッチンスパチュラセット (デモ)",
      currency: "USD",
      moq: 100,
      priceTiers: [
        { minQty: 100, unitPrice: "2.50" },
        { minQty: 500, unitPrice: "2.00" },
        { minQty: 1000, unitPrice: "1.80" },
      ],
      supplierId: supplier.id,
      domesticPriceJpy: "1980",
      lengthCm: "30",
      widthCm: "8",
      heightCm: "4",
      weightKg: "0.18",
      hsCode: "3924.10",
    },
    update: {},
  });
  const existing = await prisma.chatMessage.count({ where: { threadId: "demo-thread-1" } });
  if (existing === 0) {
    await prisma.chatMessage.create({
      data: {
        supplierId: supplier.id,
        threadId: "demo-thread-1",
        direction: "INBOUND",
        originalText: "您好！这款硅胶铲最低起订量是500套，单价2.0美元。可以做OEM，logo印刷需要另加0.1美元。",
        originalLang: "zh",
        translatedText: "こんにちは！このシリコンスパチュラの最低発注数量は500セットで、単価は2.0ドルです。OEM対応可能で、ロゴ印刷は0.1ドル追加になります。",
        status: "RECEIVED",
      },
    });
  }
  console.log("seeded");
}

main().finally(() => prisma.$disconnect());
