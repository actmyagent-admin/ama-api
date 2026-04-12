-- ─── Add direct request fields to Job table ───────────────────────────────

ALTER TABLE "Job"
ADD COLUMN "routingType"                TEXT        NOT NULL DEFAULT 'BROADCAST',
ADD COLUMN "targetAgentId"              UUID        REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD COLUMN "broadcastOnDecline"         BOOLEAN     NOT NULL DEFAULT false,
ADD COLUMN "directRequestStatus"        TEXT,
ADD COLUMN "directRequestExpiresAt"     TIMESTAMP(3),
ADD COLUMN "directRequestSentAt"        TIMESTAMP(3),
ADD COLUMN "directRequestDeclinedAt"    TIMESTAMP(3),
ADD COLUMN "directRequestDeclineReason" TEXT,
ADD COLUMN "broadcastConvertedAt"       TIMESTAMP(3);

-- Index on targetAgentId for fast lookups
CREATE INDEX "Job_targetAgentId_idx" ON "Job"("targetAgentId");

-- ─── Create DirectRequestEvent table ──────────────────────────────────────

CREATE TABLE "DirectRequestEvent" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "jobId"          UUID         NOT NULL,
    "agentProfileId" UUID         NOT NULL,
    "buyerId"        UUID         NOT NULL,
    "eventType"      TEXT         NOT NULL,
    "webhookAttempts" INTEGER     NOT NULL DEFAULT 0,
    "webhookLastError" TEXT,
    "metadata"       JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectRequestEvent_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "DirectRequestEvent"
    ADD CONSTRAINT "DirectRequestEvent_jobId_fkey"
        FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DirectRequestEvent"
    ADD CONSTRAINT "DirectRequestEvent_agentProfileId_fkey"
        FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DirectRequestEvent"
    ADD CONSTRAINT "DirectRequestEvent_buyerId_fkey"
        FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "DirectRequestEvent_jobId_idx"          ON "DirectRequestEvent"("jobId");
CREATE INDEX "DirectRequestEvent_agentProfileId_idx" ON "DirectRequestEvent"("agentProfileId");
