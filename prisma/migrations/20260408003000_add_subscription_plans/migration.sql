-- AlterTable: soft-delete flag on AgentProfile
ALTER TABLE "AgentProfile" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: Plan catalog
CREATE TABLE "Plan" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "name"                  TEXT NOT NULL,
    "slug"                  TEXT NOT NULL,
    "description"           TEXT,
    "stripePriceIdMonthly"  TEXT,
    "stripePriceIdYearly"   TEXT,
    "stripeProductId"       TEXT,
    "maxAgentListings"      INTEGER NOT NULL,
    "canAccessAnalytics"    BOOLEAN NOT NULL DEFAULT false,
    "canUseCustomWebhook"   BOOLEAN NOT NULL DEFAULT true,
    "hasPrioritySupport"    BOOLEAN NOT NULL DEFAULT false,
    "hasCustomBranding"     BOOLEAN NOT NULL DEFAULT false,
    "canAccessApiDocs"      BOOLEAN NOT NULL DEFAULT true,
    "broadcastPriority"     INTEGER NOT NULL DEFAULT 0,
    "monthlyPriceCents"     INTEGER,
    "yearlyPriceCents"      INTEGER,
    "isActive"              BOOLEAN NOT NULL DEFAULT true,
    "isPublic"              BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"             INTEGER NOT NULL DEFAULT 0,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_slug_key" ON "Plan"("slug");

-- CreateTable: Subscription (one per AGENT_LISTER user)
CREATE TABLE "Subscription" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId"                 UUID NOT NULL,
    "planId"                 UUID NOT NULL,
    "stripeSubscriptionId"   TEXT,
    "stripeCustomerId"       TEXT NOT NULL,
    "stripePriceId"          TEXT,
    "billingCycle"           TEXT NOT NULL DEFAULT 'monthly',
    "status"                 TEXT NOT NULL DEFAULT 'active',
    "trialEndsAt"            TIMESTAMP(3),
    "currentPeriodStart"     TIMESTAMP(3),
    "currentPeriodEnd"       TIMESTAMP(3),
    "cancelAtPeriodEnd"      BOOLEAN NOT NULL DEFAULT false,
    "canceledAt"             TIMESTAMP(3),
    "customMaxAgentListings" INTEGER,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_userId_key"              ON "Subscription"("userId");
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");
CREATE UNIQUE INDEX "Subscription_stripeCustomerId_key"    ON "Subscription"("stripeCustomerId");
CREATE INDEX        "Subscription_status_idx"              ON "Subscription"("status");
CREATE INDEX        "Subscription_stripeCustomerId_idx"    ON "Subscription"("stripeCustomerId");

-- CreateTable: SubscriptionEvent audit trail
CREATE TABLE "SubscriptionEvent" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL,
    "userId"         UUID NOT NULL,
    "eventType"      TEXT NOT NULL,
    "fromPlanId"     UUID,
    "toPlanId"       UUID,
    "stripeEventId"  TEXT,
    "metadata"       JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionEvent_stripeEventId_key"     ON "SubscriptionEvent"("stripeEventId");
CREATE INDEX        "SubscriptionEvent_subscriptionId_idx"    ON "SubscriptionEvent"("subscriptionId");
CREATE INDEX        "SubscriptionEvent_userId_idx"            ON "SubscriptionEvent"("userId");

-- AddForeignKey constraints
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_fromPlanId_fkey"
    FOREIGN KEY ("fromPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_toPlanId_fkey"
    FOREIGN KEY ("toPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed plan catalog
INSERT INTO "Plan"
    ("id", "name", "slug", "description",
     "maxAgentListings", "canAccessAnalytics", "hasPrioritySupport", "hasCustomBranding",
     "broadcastPriority", "monthlyPriceCents", "yearlyPriceCents",
     "isPublic", "sortOrder", "updatedAt")
VALUES
    (
        gen_random_uuid(), 'Starter', 'starter',
        'Perfect for individuals listing their first agents',
        3, false, false, false, 0, 0, 0, true, 1, NOW()
    ),
    (
        gen_random_uuid(), 'Pro', 'pro',
        'For serious agent builders with multiple listings',
        10, true, true, false, 10, 2900, 29000, true, 2, NOW()
    ),
    (
        gen_random_uuid(), 'Custom', 'custom',
        'Tailored for agencies and large-scale deployments',
        -1, true, true, true, 20, NULL, NULL, false, 3, NOW()
    );
