import type { PrismaClient } from "@prisma/client";

interface LedgerEntryBase {
  paymentId: string;
  contractId: string;
  currency: string;
}

interface PendingEntriesInput extends LedgerEntryBase {
  buyerId: string;
  agentUserId: string;
  amountTotal: number;       // cents
  amountPlatformFee: number; // cents
  amountAgentReceives: number; // cents
  stripeReference?: string;
}

// ─── CREATE ─────────────────────────────────────────────────────────────────

// Called when PaymentIntent is created (POST /api/payments/create).
// Records the three pending money movements before any card charge occurs.
export async function createPendingLedgerEntries(
  prisma: PrismaClient,
  input: PendingEntriesInput,
): Promise<void> {
  await prisma.ledgerEntry.createMany({
    data: [
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: input.buyerId,
        partyType: "buyer",
        entryType: "buyer_charge",
        amountCents: -input.amountTotal, // money OUT for buyer
        currency: input.currency,
        stripeReference: input.stripeReference ?? null,
        status: "pending",
        description: "Payment authorization initiated",
      },
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: null, // platform has no user row
        partyType: "platform",
        entryType: "platform_fee",
        amountCents: input.amountPlatformFee, // money IN for platform
        currency: input.currency,
        stripeReference: input.stripeReference ?? null,
        status: "pending",
        description: "Platform service fee (15%)",
      },
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: input.agentUserId,
        partyType: "agent",
        entryType: "agent_payout",
        amountCents: input.amountAgentReceives, // money IN for agent
        currency: input.currency,
        stripeReference: input.stripeReference ?? null,
        status: "pending",
        description: "Agent payout (85% of total)",
      },
    ],
  });
}

// ─── SETTLE ─────────────────────────────────────────────────────────────────

// Called on payment_intent.succeeded — card authorised, funds held in escrow.
// Marks all three pending entries as completed.
export async function settleLedgerEntries(
  prisma: PrismaClient,
  paymentId: string,
  stripeReference: string,
): Promise<void> {
  await prisma.ledgerEntry.updateMany({
    where: { paymentId, status: "pending" },
    data: {
      status: "completed",
      stripeReference,
      settledAt: new Date(),
    },
  });
}

// ─── FAIL ────────────────────────────────────────────────────────────────────

// Called on payment_intent.payment_failed — card declined or error.
export async function failLedgerEntries(
  prisma: PrismaClient,
  paymentId: string,
): Promise<void> {
  await prisma.ledgerEntry.updateMany({
    where: { paymentId, status: "pending" },
    data: { status: "failed" },
  });
}

// ─── REVERSE ─────────────────────────────────────────────────────────────────

// Called on payment_intent.canceled — Stripe authorization expired (7 days).
// Buyer must re-authorize; pending entries are no longer valid.
export async function reverseLedgerEntries(
  prisma: PrismaClient,
  paymentId: string,
): Promise<void> {
  await prisma.ledgerEntry.updateMany({
    where: { paymentId, status: { in: ["pending", "completed"] } },
    data: { status: "reversed", settledAt: new Date() },
  });
}

// ─── REFUND ──────────────────────────────────────────────────────────────────

// Called on refundEscrow (dispute resolved in buyer's favour, or void).
// Creates new entries that mirror and negate the original completed ones.
export async function createRefundLedgerEntries(
  prisma: PrismaClient,
  input: PendingEntriesInput,
  stripeReference?: string,
): Promise<void> {
  const now = new Date();
  await prisma.ledgerEntry.createMany({
    data: [
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: input.buyerId,
        partyType: "buyer",
        entryType: "buyer_refund",
        amountCents: input.amountTotal, // money IN for buyer (refund)
        currency: input.currency,
        stripeReference: stripeReference ?? null,
        status: "completed",
        description: "Full refund issued to buyer",
        settledAt: now,
      },
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: null,
        partyType: "platform",
        entryType: "platform_fee",
        amountCents: -input.amountPlatformFee, // fee reversed
        currency: input.currency,
        stripeReference: stripeReference ?? null,
        status: "completed",
        description: "Platform fee reversed on refund",
        settledAt: now,
      },
      {
        paymentId: input.paymentId,
        contractId: input.contractId,
        userId: input.agentUserId,
        partyType: "agent",
        entryType: "agent_clawback",
        amountCents: -input.amountAgentReceives, // money OUT for agent (clawback)
        currency: input.currency,
        stripeReference: stripeReference ?? null,
        status: "completed",
        description: "Agent payout reversed on refund",
        settledAt: now,
      },
    ],
  });
}
