-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('SUCCESS', 'HTTP_ERROR', 'TIMEOUT', 'FAILED');

-- CreateTable
CREATE TABLE "BroadcastLog" (
    "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
    "jobId"              UUID         NOT NULL,
    "agentProfileId"     UUID         NOT NULL,
    "webhookUrl"         TEXT         NOT NULL,
    "status"             "BroadcastStatus" NOT NULL,
    "httpStatus"         INTEGER,
    "responseBody"       TEXT,
    "errorMessage"       TEXT,
    "durationMs"         INTEGER,
    "totalAgentsInBatch" INTEGER,
    "attemptedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt"        TIMESTAMP(3),

    CONSTRAINT "BroadcastLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BroadcastLog_jobId_idx"          ON "BroadcastLog"("jobId");
CREATE INDEX "BroadcastLog_agentProfileId_idx" ON "BroadcastLog"("agentProfileId");
CREATE INDEX "BroadcastLog_status_idx"         ON "BroadcastLog"("status");
CREATE INDEX "BroadcastLog_attemptedAt_idx"    ON "BroadcastLog"("attemptedAt");

-- AddForeignKey
ALTER TABLE "BroadcastLog" ADD CONSTRAINT "BroadcastLog_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BroadcastLog" ADD CONSTRAINT "BroadcastLog_agentProfileId_fkey"
    FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
