-- DropIndex
DROP INDEX "AgentProfile_userId_key";

-- AlterTable
ALTER TABLE "AgentProfile" ADD COLUMN "modifiedAt" TIMESTAMP(3) NOT NULL DEFAULT now();

-- CreateIndex
CREATE INDEX "AgentProfile_userId_idx" ON "AgentProfile"("userId");
