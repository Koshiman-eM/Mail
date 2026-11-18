-- CreateEnum
CREATE TYPE "DraftSource" AS ENUM ('AI', 'MANUAL');

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "draftSource" "DraftSource";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "autoCalcAt" TIMESTAMP(3),
ADD COLUMN     "autoCalcNote" TEXT,
ADD COLUMN     "autoCalcStatus" TEXT,
ADD COLUMN     "dutyPercent" DECIMAL(6,3),
ADD COLUMN     "targetQuantity" INTEGER;

-- AlterTable
ALTER TABLE "ProfitSimulation" ADD COLUMN     "auto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trigger" TEXT;

-- CreateTable
CREATE TABLE "ProfitSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "fxBufferPercent" DECIMAL(6,3) NOT NULL DEFAULT 3,
    "fxFallbackRates" JSONB NOT NULL DEFAULT '{"USD":"150","CNY":"20.8","EUR":"160"}',
    "localShippingJpy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "agentFeePercent" DECIMAL(6,3) NOT NULL DEFAULT 5,
    "agentFixedJpy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "intlRatePerKgJpy" DECIMAL(14,2) NOT NULL DEFAULT 800,
    "intlMinChargeJpy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "volumetricDivisor" INTEGER NOT NULL DEFAULT 5000,
    "weightStepKg" DECIMAL(8,3) NOT NULL DEFAULT 0.5,
    "fuelSurchargePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "defaultDutyPercent" DECIMAL(6,3) NOT NULL DEFAULT 5,
    "consumptionTaxPercent" DECIMAL(6,3) NOT NULL DEFAULT 10,
    "customsClearanceFeeJpy" DECIMAL(14,2) NOT NULL DEFAULT 3000,
    "japanCustomsRounding" BOOLEAN NOT NULL DEFAULT true,
    "platformFeePercent" DECIMAL(6,3) NOT NULL DEFAULT 10,
    "platformFixedFeePerUnitJpy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "domesticShippingPerUnitJpy" DECIMAL(14,2) NOT NULL DEFAULT 200,
    "otherCostsJpy" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roiAlertPercent" DECIMAL(8,2) NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfitSettings_pkey" PRIMARY KEY ("id")
);
