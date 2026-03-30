-- CreateTable: StripeConnectAccount
-- Stores Stripe Connect account state for AGENT_LISTER users
CREATE TABLE "StripeConnectAccount" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"                UUID NOT NULL,
    "stripeAccountId"       TEXT NOT NULL,
    "chargesEnabled"        BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled"        BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted"      BOOLEAN NOT NULL DEFAULT false,
    "accountType"           TEXT NOT NULL DEFAULT 'standard',
    "country"               TEXT,
    "defaultCurrency"       TEXT,
    "onboardingCompletedAt" TIMESTAMP(3),
    "lastVerifiedAt"        TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeConnectAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable: LedgerEntry
-- Platform financial ledger — every money movement as a line item
CREATE TABLE "LedgerEntry" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "paymentId"       UUID NOT NULL,
    "contractId"      UUID NOT NULL,
    "userId"          UUID,
    "partyType"       TEXT NOT NULL,
    "entryType"       TEXT NOT NULL,
    "amountCents"     INTEGER NOT NULL,
    "currency"        TEXT NOT NULL DEFAULT 'usd',
    "stripeReference" TEXT,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "description"     TEXT,
    "metadata"        JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt"       TIMESTAMP(3),

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Payout
-- Tracks individual payouts sent to agent listers via Stripe
CREATE TABLE "Payout" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"          UUID NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "stripePayoutId"  TEXT NOT NULL,
    "amountCents"     INTEGER NOT NULL,
    "currency"        TEXT NOT NULL DEFAULT 'usd',
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "arrivalDate"     DATE,
    "failureMessage"  TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PlatformRevenue
-- Daily platform revenue rollup — populated by a nightly aggregation job
CREATE TABLE "PlatformRevenue" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "date"           DATE NOT NULL,
    "grossVolumeGMV" INTEGER NOT NULL DEFAULT 0,
    "platformFees"   INTEGER NOT NULL DEFAULT 0,
    "refundsIssued"  INTEGER NOT NULL DEFAULT 0,
    "netRevenue"     INTEGER NOT NULL DEFAULT 0,
    "completedJobs"  INTEGER NOT NULL DEFAULT 0,
    "disputedJobs"   INTEGER NOT NULL DEFAULT 0,
    "refundedJobs"   INTEGER NOT NULL DEFAULT 0,
    "currency"       TEXT NOT NULL DEFAULT 'usd',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique constraints
CREATE UNIQUE INDEX "StripeConnectAccount_userId_key"       ON "StripeConnectAccount"("userId");
CREATE UNIQUE INDEX "StripeConnectAccount_stripeAccountId_key" ON "StripeConnectAccount"("stripeAccountId");
CREATE UNIQUE INDEX "Payout_stripePayoutId_key"             ON "Payout"("stripePayoutId");
CREATE UNIQUE INDEX "PlatformRevenue_date_key"              ON "PlatformRevenue"("date");

-- CreateIndex: performance indexes
CREATE INDEX "LedgerEntry_paymentId_idx"  ON "LedgerEntry"("paymentId");
CREATE INDEX "LedgerEntry_userId_idx"     ON "LedgerEntry"("userId");
CREATE INDEX "LedgerEntry_contractId_idx" ON "LedgerEntry"("contractId");
CREATE INDEX "LedgerEntry_entryType_idx"  ON "LedgerEntry"("entryType");
CREATE INDEX "LedgerEntry_createdAt_idx"  ON "LedgerEntry"("createdAt");
CREATE INDEX "Payout_userId_idx"          ON "Payout"("userId");

-- AddForeignKey constraints
ALTER TABLE "StripeConnectAccount"
    ADD CONSTRAINT "StripeConnectAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payout"
    ADD CONSTRAINT "Payout_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
