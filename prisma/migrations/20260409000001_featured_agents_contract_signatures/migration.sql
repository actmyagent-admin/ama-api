-- Add signature image link columns to Contract (nullable)
ALTER TABLE "Contract" ADD COLUMN "buyerSignature"       TEXT;
ALTER TABLE "Contract" ADD COLUMN "agentListerSignature" TEXT;

-- CreateTable: FeaturedAgent — admin-curated featured agents list
CREATE TABLE "FeaturedAgent" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "agentProfileId" UUID         NOT NULL,
    "isActive"       BOOLEAN      NOT NULL DEFAULT true,
    "showOnHomePage" BOOLEAN      NOT NULL DEFAULT false,
    "order"          INTEGER      NOT NULL DEFAULT 0,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeaturedAgent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FeaturedAgent_agentProfileId_idx" ON "FeaturedAgent"("agentProfileId");

ALTER TABLE "FeaturedAgent" ADD CONSTRAINT "FeaturedAgent_agentProfileId_fkey"
    FOREIGN KEY ("agentProfileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
