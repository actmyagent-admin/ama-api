/**
 * Shared escrow release logic used by:
 *  - Buyer approval endpoint (deliveries.ts)
 *  - Auto-approval cron handler (index.ts)
 *  - Admin dispute resolution (admin.ts)
 */
import { stripe } from './stripe.js'
import { createRefundLedgerEntries } from './ledger.js'
import type { PrismaClient } from '@prisma/client'

export async function releaseEscrow(
  deliveryId: string,
  contractId: string,
  paymentId: string,
  stripePaymentIntentId: string,
  prisma: PrismaClient,
): Promise<void> {
  // Optimistic DB update — mark everything as complete before Stripe call
  await prisma.$transaction([
    prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: 'APPROVED', approvedAt: new Date() },
    }),
    prisma.contract.update({
      where: { id: contractId },
      data: { status: 'COMPLETED', autoReleaseAt: null },
    }),
    prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    }),
  ])

  // Capture outside the transaction — Stripe calls cannot be rolled back
  try {
    await stripe.paymentIntents.capture(stripePaymentIntentId)
  } catch (err) {
    // Roll back DB on Stripe failure so the state stays consistent
    await prisma.$transaction([
      prisma.delivery.update({
        where: { id: deliveryId },
        data: { status: 'SUBMITTED', approvedAt: null },
      }),
      prisma.contract.update({
        where: { id: contractId },
        data: { status: 'ACTIVE' },
      }),
      prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'ESCROWED', releasedAt: null },
      }),
    ])
    throw err
  }
}

export async function refundEscrow(
  contractId: string,
  paymentId: string,
  stripePaymentIntentId: string,
  prisma: PrismaClient,
): Promise<void> {
  // Fetch payment + contract before cancelling so we have amounts and user IDs for ledger
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      contract: {
        select: {
          buyerId: true,
          agentProfile: { select: { userId: true } },
        },
      },
    },
  })

  // Cancel the PaymentIntent (refunds automatically if never captured)
  await stripe.paymentIntents.cancel(stripePaymentIntentId)

  await prisma.$transaction([
    prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'REFUNDED', refundedAt: new Date() },
    }),
    prisma.contract.update({
      where: { id: contractId },
      data: { status: 'COMPLETED' },
    }),
  ])

  if (payment) {
    await createRefundLedgerEntries(
      prisma,
      {
        paymentId: payment.id,
        contractId,
        buyerId: payment.contract.buyerId,
        agentUserId: payment.contract.agentProfile.userId,
        amountTotal: payment.amountTotal,
        amountPlatformFee: payment.amountPlatformFee,
        amountAgentReceives: payment.amountAgentReceives,
        currency: payment.currency,
      },
      stripePaymentIntentId,
    )
  }
}
