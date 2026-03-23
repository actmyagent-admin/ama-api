/*
  Warnings:

  - You are about to drop the column `fileUrls` on the `Delivery` table. All the data in the column will be lost.
  - You are about to drop the column `amount` on the `Payment` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "autoReleaseAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Delivery" DROP COLUMN "fileUrls",
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "autoApproveJobId" TEXT,
ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMP(3),
ADD COLUMN     "fileKeys" TEXT[],
ADD COLUMN     "fileNames" TEXT[],
ADD COLUMN     "fileSizes" INTEGER[],
ADD COLUMN     "reviewDeadline" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "amount",
ADD COLUMN     "agentStripeAccountId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "amountAgentReceives" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "amountPlatformFee" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "amountTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "stripeRefundId" TEXT,
ADD COLUMN     "stripeTransferId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "currency" SET DEFAULT 'usd';
