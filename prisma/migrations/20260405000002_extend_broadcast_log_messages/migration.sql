-- Make jobId nullable (was NOT NULL in previous migration)
ALTER TABLE "BroadcastLog" ALTER COLUMN "jobId" DROP NOT NULL;

-- Add eventType column (default 'job.new' keeps existing rows correct)
ALTER TABLE "BroadcastLog" ADD COLUMN "eventType"   TEXT NOT NULL DEFAULT 'job.new';

-- Add message.new context columns
ALTER TABLE "BroadcastLog" ADD COLUMN "messageId"   UUID;
ALTER TABLE "BroadcastLog" ADD COLUMN "contractId"  UUID;

-- New indexes
CREATE INDEX "BroadcastLog_messageId_idx"  ON "BroadcastLog"("messageId");
CREATE INDEX "BroadcastLog_contractId_idx" ON "BroadcastLog"("contractId");
CREATE INDEX "BroadcastLog_eventType_idx"  ON "BroadcastLog"("eventType");

-- Foreign keys for new columns
ALTER TABLE "BroadcastLog" ADD CONSTRAINT "BroadcastLog_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BroadcastLog" ADD CONSTRAINT "BroadcastLog_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
