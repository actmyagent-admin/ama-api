-- Migration: extend Job, Proposal, Contract, and AgentProfile
-- for scalable service delivery terms

-- ════════════════════════════════════════════════════════════
-- AlterTable AgentProfile
-- ════════════════════════════════════════════════════════════
ALTER TABLE "AgentProfile"
  -- Categorisation
  ADD COLUMN "tags"                   TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "skillLevel"             TEXT             NOT NULL DEFAULT 'professional',

  -- Pricing structure
  ADD COLUMN "pricingModel"           TEXT             NOT NULL DEFAULT 'fixed',
  ADD COLUMN "basePrice"              INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN "expressMultiplier"      DOUBLE PRECISION,

  -- Delivery terms
  ADD COLUMN "deliveryDays"           INTEGER          NOT NULL DEFAULT 3,
  ADD COLUMN "expressDeliveryDays"    INTEGER,
  ADD COLUMN "maxFileSizeMb"          INTEGER                   DEFAULT 100,
  ADD COLUMN "outputFormats"          TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "inputRequirements"      TEXT,

  -- Revision terms
  ADD COLUMN "revisionsIncluded"      INTEGER          NOT NULL DEFAULT 2,
  ADD COLUMN "pricePerExtraRevision"  INTEGER                   DEFAULT 0,
  ADD COLUMN "maxRevisionRounds"      INTEGER,
  ADD COLUMN "revisionWindowDays"     INTEGER          NOT NULL DEFAULT 7,
  ADD COLUMN "revisionsPolicy"        TEXT,

  -- Delivery variants
  ADD COLUMN "deliveryVariants"       INTEGER          NOT NULL DEFAULT 1,
  ADD COLUMN "pricePerExtraVariant"   INTEGER,
  ADD COLUMN "maxDeliveryVariants"    INTEGER,

  -- Service scope
  ADD COLUMN "whatsIncluded"          TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "whatsNotIncluded"       TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "perfectFor"             TEXT[]           NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Operational terms
  ADD COLUMN "responseTimeSlaHours"   INTEGER          NOT NULL DEFAULT 24,
  ADD COLUMN "maxConcurrentJobs"      INTEGER                   DEFAULT 5,
  ADD COLUMN "currentActiveJobs"      INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN "availabilityStatus"     TEXT             NOT NULL DEFAULT 'available',
  ADD COLUMN "availableUntil"         TIMESTAMP(3),

  -- Languages
  ADD COLUMN "languagesSupported"     TEXT[]           NOT NULL DEFAULT ARRAY['English']::TEXT[],

  -- Portfolio & proof
  ADD COLUMN "portfolioItems"         JSONB            NOT NULL DEFAULT '[]',
  ADD COLUMN "sampleOutputUrl"        TEXT,

  -- Performance stats
  ADD COLUMN "totalReviews"           INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN "completionRate"         DOUBLE PRECISION,
  ADD COLUMN "onTimeDeliveryRate"     DOUBLE PRECISION,
  ADD COLUMN "repeatClientRate"       DOUBLE PRECISION,
  ADD COLUMN "avgResponseHours"       DOUBLE PRECISION,

  -- Guarantee
  ADD COLUMN "moneyBackGuarantee"     BOOLEAN          NOT NULL DEFAULT false,
  ADD COLUMN "guaranteeTerms"         TEXT;


-- ════════════════════════════════════════════════════════════
-- AlterTable Job
-- ════════════════════════════════════════════════════════════
ALTER TABLE "Job"
  -- Scope clarity
  ADD COLUMN "briefDetail"             TEXT,
  ADD COLUMN "attachmentKeys"          TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "attachmentNames"         TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "exampleUrls"             TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Delivery preferences
  ADD COLUMN "desiredDeliveryDays"     INTEGER,
  ADD COLUMN "expressRequested"        BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN "preferredOutputFormats"  TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Proposal settings
  ADD COLUMN "proposalDeadlineHours"   INTEGER  NOT NULL DEFAULT 4,
  ADD COLUMN "maxProposals"            INTEGER           DEFAULT 10,
  ADD COLUMN "proposalsReceived"       INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN "isProposalOpen"          BOOLEAN  NOT NULL DEFAULT true,

  -- Buyer preferences
  ADD COLUMN "preferHuman"             BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN "budgetFlexible"          BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN "requiredLanguage"        TEXT               DEFAULT 'English';


-- ════════════════════════════════════════════════════════════
-- AlterTable Proposal
-- ════════════════════════════════════════════════════════════
ALTER TABLE "Proposal"
  -- Custom pricing for this job
  ADD COLUMN "basePrice"              INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN "expressRequested"       BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN "expressDeliveryDays"    INTEGER,

  -- Custom delivery terms for this job
  ADD COLUMN "deliveryDays"           INTEGER  NOT NULL DEFAULT 3,
  ADD COLUMN "revisionsIncluded"      INTEGER  NOT NULL DEFAULT 2,
  ADD COLUMN "deliveryVariants"       INTEGER  NOT NULL DEFAULT 1,

  -- Scope clarification
  ADD COLUMN "scopeNotes"             TEXT,
  ADD COLUMN "questionsForBuyer"      TEXT,
  ADD COLUMN "buyerAnswers"           TEXT,
  ADD COLUMN "requiresExpress"        BOOLEAN  NOT NULL DEFAULT false,

  -- Proposal metadata
  ADD COLUMN "expiresAt"              TIMESTAMP(3),
  ADD COLUMN "viewedAt"               TIMESTAMP(3);


-- ════════════════════════════════════════════════════════════
-- AlterTable Contract
-- ════════════════════════════════════════════════════════════
ALTER TABLE "Contract"
  -- Snapshot of agreed terms (frozen at creation — never read AgentProfile at dispute time)
  ADD COLUMN "agreedPrice"              INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN "agreedDeliveryDays"       INTEGER  NOT NULL DEFAULT 3,
  ADD COLUMN "agreedRevisionsIncluded"  INTEGER  NOT NULL DEFAULT 2,
  ADD COLUMN "agreedDeliveryVariants"   INTEGER  NOT NULL DEFAULT 1,
  ADD COLUMN "pricePerExtraRevision"    INTEGER,
  ADD COLUMN "pricePerExtraVariant"     INTEGER,
  ADD COLUMN "expressDelivery"          BOOLEAN  NOT NULL DEFAULT false,

  -- Revision tracking
  ADD COLUMN "revisionsUsed"            INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN "extraRevisionsBilled"     INTEGER  NOT NULL DEFAULT 0,

  -- Variant tracking
  ADD COLUMN "variantsDelivered"        INTEGER  NOT NULL DEFAULT 0,

  -- Scope agreement
  ADD COLUMN "buyerRequirements"        TEXT,
  ADD COLUMN "agreedInputsReceived"     BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN "inputsReceivedAt"         TIMESTAMP(3),

  -- Deadline management
  ADD COLUMN "startedAt"                TIMESTAMP(3),
  ADD COLUMN "calculatedDeadline"       TIMESTAMP(3),
  ADD COLUMN "deadlineExtendedAt"       TIMESTAMP(3),
  ADD COLUMN "originalDeadline"         TIMESTAMP(3),

  -- Cancellation
  ADD COLUMN "cancelledAt"              TIMESTAMP(3),
  ADD COLUMN "cancelledBy"              TEXT,
  ADD COLUMN "cancellationReason"       TEXT,

  -- Dispute detail
  ADD COLUMN "disputeOpenedBy"          TEXT,
  ADD COLUMN "disputeReason"            TEXT,
  ADD COLUMN "disputeEvidenceUrls"      TEXT[]   NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "disputeResolvedBy"        TEXT,
  ADD COLUMN "disputeResolution"        TEXT;
