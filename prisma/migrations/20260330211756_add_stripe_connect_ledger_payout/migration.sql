-- AlterTable
ALTER TABLE "LedgerEntry" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Payout" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlatformRevenue" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "StripeConnectAccount" ALTER COLUMN "id" DROP DEFAULT;
