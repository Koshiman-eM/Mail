-- CreateEnum
CREATE TYPE "DiscoveryStatus" AS ENUM ('AUTO_ADDED', 'ADDED', 'QUALIFIED', 'BELOW_THRESHOLD', 'NO_DOMESTIC_PRICE', 'DUPLICATE', 'DISMISSED', 'ERROR');

-- CreateTable
CREATE TABLE "DiscoveryWatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywordJa" TEXT NOT NULL,
    "foreignKeywords" JSONB NOT NULL DEFAULT '{}',
    "autoKeywords" JSONB,
    "platforms" "Platform"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "estWeightKg" DECIMAL(10,3) NOT NULL,
    "estLengthCm" DECIMAL(10,2),
    "estWidthCm" DECIMAL(10,2),
    "estHeightCm" DECIMAL(10,2),
    "targetQuantity" INTEGER NOT NULL DEFAULT 1,
    "minRoiPercent" DECIMAL(9,2) NOT NULL,
    "minProfitJpy" DECIMAL(14,2),
    "maxMoq" INTEGER,
    "maxUnitPriceJpy" DECIMAL(14,2),
    "autoAdd" BOOLEAN NOT NULL DEFAULT true,
    "maxAutoAddPerRun" INTEGER NOT NULL DEFAULT 5,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredItem" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "priceTiers" JSONB NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "supplierName" TEXT,
    "supplierExternalId" TEXT,
    "shopUrl" TEXT,
    "domesticPriceJpy" DECIMAL(14,2),
    "domesticEvidence" JSONB,
    "estProfitJpy" DECIMAL(14,2),
    "estRoiPercent" DECIMAL(9,2),
    "estimate" JSONB,
    "status" "DiscoveryStatus" NOT NULL,
    "statusNote" TEXT,
    "productId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomesticPriceCache" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomesticPriceCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveredItem_status_lastSeenAt_idx" ON "DiscoveredItem"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "DiscoveredItem_watchId_lastSeenAt_idx" ON "DiscoveredItem"("watchId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredItem_watchId_platform_externalId_key" ON "DiscoveredItem"("watchId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "DomesticPriceCache_provider_keyword_key" ON "DomesticPriceCache"("provider", "keyword");

-- AddForeignKey
ALTER TABLE "DiscoveredItem" ADD CONSTRAINT "DiscoveredItem_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "DiscoveryWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredItem" ADD CONSTRAINT "DiscoveredItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
