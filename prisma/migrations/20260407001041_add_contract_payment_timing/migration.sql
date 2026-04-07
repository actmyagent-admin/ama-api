-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContractStatus" ADD VALUE 'SIGNED_BOTH';
ALTER TYPE "ContractStatus" ADD VALUE 'VOIDED';

-- DropForeignKey
ALTER TABLE "BroadcastLog" DROP CONSTRAINT "BroadcastLog_jobId_fkey";

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "bothSignedAt" TIMESTAMP(3),
ADD COLUMN     "paymentDeadline" TIMESTAMP(3),
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "BroadcastLog" ADD CONSTRAINT "BroadcastLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
