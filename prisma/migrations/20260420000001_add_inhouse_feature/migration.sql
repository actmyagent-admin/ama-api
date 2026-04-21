-- ─── Add inhouse feature ──────────────────────────────────────────────────────
-- Adds InhouseService + InhouseOrder tables and modifies existing tables to
-- support platform-operated fixed-price services alongside the existing
-- broadcast/proposal flow.

-- ─── 1. AgentProfile: make webhookUrl nullable, add isSuperAgent flag ─────────

ALTER TABLE "AgentProfile"
  ALTER COLUMN "webhookUrl" DROP NOT NULL;

ALTER TABLE "AgentProfile"
  ADD COLUMN "isSuperAgent" BOOLEAN NOT NULL DEFAULT false;

-- ─── 2. Contract: make jobId + proposalId nullable (inhouse contracts have neither) ──

ALTER TABLE "Contract"
  ALTER COLUMN "jobId" DROP NOT NULL;

ALTER TABLE "Contract"
  ALTER COLUMN "proposalId" DROP NOT NULL;

-- ─── 3. Contract: add isInhouse flag ──────────────────────────────────────────

ALTER TABLE "Contract"
  ADD COLUMN "isInhouse" BOOLEAN NOT NULL DEFAULT false;

-- ─── 4. Create InhouseService table ───────────────────────────────────────────

CREATE TABLE "InhouseService" (
  "id"                         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "pageSlug"                   TEXT        NOT NULL,
  "category"                   TEXT        NOT NULL,
  "packageName"                TEXT        NOT NULL,
  "tagline"                    TEXT,
  "description"                TEXT        NOT NULL,
  "priceCents"                 INTEGER     NOT NULL,
  "deliveryDays"               INTEGER     NOT NULL,
  "revisionsIncluded"          INTEGER     NOT NULL DEFAULT 2,
  "deliveryVariants"           INTEGER     NOT NULL DEFAULT 1,
  "pricePerExtraRevisionCents" INTEGER,
  "pricePerExtraVariantCents"  INTEGER,
  "whatsIncluded"              TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "whatsNotIncluded"           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "perfectFor"                 TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  "inputSchema"                JSONB       NOT NULL DEFAULT '[]',
  "assignedAgentProfileId"     UUID        REFERENCES "AgentProfile"("id") ON DELETE SET NULL,
  "sortOrder"                  INTEGER     NOT NULL DEFAULT 0,
  "isHighlighted"              BOOLEAN     NOT NULL DEFAULT false,
  "isActive"                   BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InhouseService_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InhouseService_pageSlug_idx"
  ON "InhouseService"("pageSlug");

CREATE INDEX "InhouseService_assignedAgentProfileId_idx"
  ON "InhouseService"("assignedAgentProfileId");

-- ─── 5. Create InhouseOrder table ─────────────────────────────────────────────

CREATE TABLE "InhouseOrder" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "serviceId"       UUID         NOT NULL REFERENCES "InhouseService"("id") ON DELETE RESTRICT,
  "buyerId"         UUID         NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "priceCents"      INTEGER      NOT NULL,
  "currency"        TEXT         NOT NULL DEFAULT 'usd',
  "buyerInputs"     JSONB        NOT NULL DEFAULT '{}',
  "attachmentKeys"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attachmentNames" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "description"     TEXT,
  "exampleUrls"     TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contractId"      UUID         UNIQUE REFERENCES "Contract"("id") ON DELETE SET NULL,
  "status"          TEXT         NOT NULL DEFAULT 'pending_payment',
  "extraRevisions"  INTEGER      NOT NULL DEFAULT 0,
  "extraVariants"   INTEGER      NOT NULL DEFAULT 0,
  "extrasCents"     INTEGER      NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InhouseOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InhouseOrder_buyerId_idx"
  ON "InhouseOrder"("buyerId");

CREATE INDEX "InhouseOrder_serviceId_idx"
  ON "InhouseOrder"("serviceId");

CREATE INDEX "InhouseOrder_status_idx"
  ON "InhouseOrder"("status");

-- ─── 6. updatedAt triggers for new tables ─────────────────────────────────────
-- Reuse the same moddatetime pattern if the extension is available;
-- otherwise Prisma's @updatedAt will handle this at the ORM layer.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'moddatetime'
  ) THEN
    EXECUTE $trigger$
      CREATE TRIGGER "InhouseService_updatedAt"
        BEFORE UPDATE ON "InhouseService"
        FOR EACH ROW EXECUTE PROCEDURE moddatetime("updatedAt");

      CREATE TRIGGER "InhouseOrder_updatedAt"
        BEFORE UPDATE ON "InhouseOrder"
        FOR EACH ROW EXECUTE PROCEDURE moddatetime("updatedAt");
    $trigger$;
  END IF;
END
$$;
