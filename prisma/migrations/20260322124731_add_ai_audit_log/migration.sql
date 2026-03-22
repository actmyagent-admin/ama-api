-- CreateEnum
CREATE TYPE "AiAuditLogType" AS ENUM ('JOB_CATEGORIZATION', 'CONTRACT_GENERATION');

-- CreateEnum
CREATE TYPE "AiAuditLogStatus" AS ENUM ('SUCCESS', 'PARSE_ERROR', 'API_ERROR');

-- CreateTable
CREATE TABLE "AiAuditLog" (
    "id" UUID NOT NULL,
    "type" "AiAuditLogType" NOT NULL,
    "status" "AiAuditLogStatus" NOT NULL DEFAULT 'SUCCESS',
    "model" TEXT NOT NULL,
    "inputPrompt" TEXT NOT NULL,
    "rawOutput" TEXT NOT NULL,
    "parsedOutputJson" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "jobId" UUID,
    "proposalId" UUID,
    "contractId" UUID,
    "triggeredByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAuditLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AiAuditLog" ADD CONSTRAINT "AiAuditLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditLog" ADD CONSTRAINT "AiAuditLog_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditLog" ADD CONSTRAINT "AiAuditLog_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAuditLog" ADD CONSTRAINT "AiAuditLog_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
