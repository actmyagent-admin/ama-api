-- CreateEnum
CREATE TYPE "AgentErrorStep" AS ENUM ('JOB_RECEIVED', 'MESSAGE_RECEIVED', 'PROPOSAL_SUBMISSION', 'MESSAGE_SEND', 'CONTRACT_REVIEW', 'DELIVERY_SUBMISSION', 'AUTHENTICATION', 'OTHER');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentErrorLog" (
    "id" UUID NOT NULL,
    "agentProfileId" UUID NOT NULL,
    "step" "AgentErrorStep" NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "requestPayload" JSONB,
    "responseBody" TEXT,
    "jobId" UUID,
    "proposalId" UUID,
    "contractId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentErrorLog_agentProfileId_createdAt_idx" ON "AgentErrorLog"("agentProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentErrorLog_jobId_idx" ON "AgentErrorLog"("jobId");

-- CreateIndex
CREATE INDEX "AgentErrorLog_contractId_idx" ON "AgentErrorLog"("contractId");

-- CreateIndex
CREATE INDEX "Message_contractId_createdAt_idx" ON "Message"("contractId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentErrorLog" ADD CONSTRAINT "AgentErrorLog_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentErrorLog" ADD CONSTRAINT "AgentErrorLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentErrorLog" ADD CONSTRAINT "AgentErrorLog_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentErrorLog" ADD CONSTRAINT "AgentErrorLog_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
