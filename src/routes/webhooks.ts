import { Hono } from 'hono'
import Stripe from 'stripe'
import { stripe } from '../lib/stripe.js'
import { activateContract } from '../lib/contractActivation.js'
import {
  settleLedgerEntries,
  failLedgerEntries,
  reverseLedgerEntries,
} from '../lib/ledger.js'
import type { Variables } from '../types/index.js'

const webhooks = new Hono<{ Variables: Variables }>()

async function getUserIdByStripeCustomerId(
  customerId: string,
  prisma: import('@prisma/client').PrismaClient,
): Promise<string> {
  const sub = await prisma.subscription.findUnique({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  })
  if (!sub) throw new Error(`No subscription found for Stripe customer ${customerId}`)
  return sub.userId
}

// POST /api/webhooks/stripe
// Must receive raw body for signature verification — no body parsing middleware
webhooks.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature')
  if (!signature) {
    return c.json({ error: 'Missing stripe-signature header' }, 400)
  }

  const rawBody = await c.req.text()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

  let event
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret)
  } catch (err) {
    console.error('[webhooks] Stripe signature verification failed:', err)
    return c.json({ error: 'Invalid signature' }, 400)
  }

  const prisma = c.get('prisma')

  try {
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': {
        // Card authorized — funds on hold, NOT yet captured (true escrow moment).
        // This is the correct event for manual-capture PaymentIntents.
        // payment_intent.succeeded fires later at actual capture time — handled below.
        const pi = event.data.object as { id: string; metadata: { contractId?: string } }
        const escrowedPayment = await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'ESCROWED' },
        })
        await settleLedgerEntries(prisma, escrowedPayment.id, pi.id)
        // Activate the contract — moves SIGNED_BOTH → ACTIVE and notifies agent to start work
        if (pi.metadata.contractId) {
          await activateContract(pi.metadata.contractId, prisma)
        }
        console.log(
          `[webhooks] Payment ${pi.id} escrowed (requires_capture). Contract ${pi.metadata.contractId ?? 'unknown'} activated.`,
        )
        break
      }

      case 'payment_intent.succeeded': {
        // Fires when funds are actually captured (after stripe.paymentIntents.capture() call).
        // For our flow: releaseEscrow() already set the payment to RELEASED before calling
        // Stripe capture, so by the time this fires the DB is already in the correct state.
        // We just stamp capturedAt. If payment is still ESCROWED here (e.g. captured from
        // the Stripe dashboard before delivery), we treat it the same as amount_capturable_updated.
        const pi = event.data.object as { id: string; metadata: { contractId?: string } }
        const payment = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: pi.id },
        })
        if (!payment) break

        if (payment.status === 'RELEASED') {
          // Normal path: captured via releaseEscrow() on delivery approval — stamp capturedAt
          await prisma.payment.update({
            where: { id: payment.id },
            data: { capturedAt: new Date() },
          })
          console.log(`[webhooks] Payment ${pi.id} capture confirmed (capturedAt stamped).`)
        } else if (payment.status === 'PENDING' || payment.status === 'ESCROWED') {
          // Edge case: someone clicked Capture in the Stripe dashboard before delivery
          // was approved, or amount_capturable_updated was missed. Treat as escrow.
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'ESCROWED', capturedAt: new Date() },
          })
          await settleLedgerEntries(prisma, payment.id, pi.id)
          if (pi.metadata.contractId) {
            await activateContract(pi.metadata.contractId, prisma)
          }
          console.log(
            `[webhooks] Payment ${pi.id} captured from dashboard — treated as escrow. Contract ${pi.metadata.contractId ?? 'unknown'} activated.`,
          )
        }
        break
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as { id: string }
        const failedPayment = await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'REFUNDED' },
        })
        await failLedgerEntries(prisma, failedPayment.id)
        console.log(`[webhooks] Payment ${pi.id} failed — marked REFUNDED. Buyer should be notified.`)
        break
      }

      case 'payment_intent.canceled': {
        // Stripe authorizations expire after 7 days — buyer must re-authorize
        const pi = event.data.object as { id: string; metadata: { contractId?: string } }
        const payment = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: pi.id },
        })
        if (payment) {
          await prisma.payment.update({
            where: { stripePaymentIntentId: pi.id },
            data: { status: 'PENDING' },
          })
          await reverseLedgerEntries(prisma, payment.id)
          console.log(
            `[webhooks] PaymentIntent ${pi.id} canceled (authorization expired). ` +
              `Contract ${payment.contractId} — buyer must re-authorize.`,
          )
        }
        break
      }

      case 'transfer.created': {
        const transfer = event.data.object as { id: string; metadata?: { contractId?: string } }
        console.log(`[webhooks] Transfer ${transfer.id} created — payout sent to agent.`)
        break
      }

      case 'account.updated': {
        const account = event.data.object as {
          id: string
          charges_enabled: boolean
          payouts_enabled: boolean
          details_submitted: boolean
          country?: string
          default_currency?: string
        }

        const connectAccount = await prisma.stripeConnectAccount.findUnique({
          where: { stripeAccountId: account.id },
        })

        if (connectAccount) {
          const wasFullyEnabled = connectAccount.chargesEnabled && connectAccount.payoutsEnabled
          const nowFullyEnabled = account.charges_enabled && account.payouts_enabled

          await prisma.stripeConnectAccount.update({
            where: { stripeAccountId: account.id },
            data: {
              chargesEnabled: account.charges_enabled,
              payoutsEnabled: account.payouts_enabled,
              detailsSubmitted: account.details_submitted,
              ...(account.country && { country: account.country }),
              ...(account.default_currency && { defaultCurrency: account.default_currency }),
              lastVerifiedAt: new Date(),
              // Mark onboarding complete the first time both flags become true
              ...(!wasFullyEnabled && nowFullyEnabled && { onboardingCompletedAt: new Date() }),
            },
          })

          // Activate the user's agents the first time their account becomes fully enabled
          if (!wasFullyEnabled && nowFullyEnabled) {
            await prisma.agentProfile.updateMany({
              where: { userId: connectAccount.userId },
              data: { isActive: true },
            })
            console.log(
              `[webhooks] Stripe account ${account.id} fully enabled — agents activated for user ${connectAccount.userId}`,
            )
          }
        }

        console.log(
          `[webhooks] account.updated: ${account.id} charges=${account.charges_enabled} payouts=${account.payouts_enabled}`,
        )
        break
      }

      case 'payout.paid': {
        const payout = event.data.object as {
          id: string
          arrival_date: number
        }
        await prisma.payout.updateMany({
          where: { stripePayoutId: payout.id },
          data: {
            status: 'paid',
            arrivalDate: new Date(payout.arrival_date * 1000),
          },
        })
        console.log(`[webhooks] Payout ${payout.id} marked paid.`)
        break
      }

      case 'payout.failed': {
        const payout = event.data.object as {
          id: string
          failure_message?: string
        }
        await prisma.payout.updateMany({
          where: { stripePayoutId: payout.id },
          data: {
            status: 'failed',
            failureMessage: payout.failure_message ?? null,
          },
        })
        console.log(`[webhooks] Payout ${payout.id} failed: ${payout.failure_message}`)
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const customerId = sub.customer as string
        const priceId = sub.items.data[0].price.id

        const plan = await prisma.plan.findFirst({
          where: {
            OR: [
              { stripePriceIdMonthly: priceId },
              { stripePriceIdYearly: priceId },
            ],
          },
        })

        if (!plan) {
          console.error(`[webhooks] Unknown price ID in subscription event: ${priceId}`)
          break
        }

        const existingSub = await prisma.subscription.findUnique({
          where: { stripeCustomerId: customerId },
        })

        const subscription = await prisma.subscription.upsert({
          where: { stripeCustomerId: customerId },
          update: {
            planId: plan.id,
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId,
            status: sub.status,
            billingCycle: priceId === plan.stripePriceIdYearly ? 'yearly' : 'monthly',
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            updatedAt: new Date(),
          },
          create: {
            userId: await getUserIdByStripeCustomerId(customerId, prisma),
            planId: plan.id,
            stripeSubscriptionId: sub.id,
            stripeCustomerId: customerId,
            stripePriceId: priceId,
            status: sub.status,
            billingCycle: priceId === plan.stripePriceIdYearly ? 'yearly' : 'monthly',
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            updatedAt: new Date(),
          },
        })

        const isPlanChange = existingSub && existingSub.planId !== plan.id
        await prisma.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            userId: subscription.userId,
            eventType:
              event.type === 'customer.subscription.created'
                ? 'created'
                : isPlanChange
                  ? existingSub!.planId > plan.id
                    ? 'downgraded'
                    : 'upgraded'
                  : 'renewed',
            fromPlanId: isPlanChange ? existingSub!.planId : undefined,
            toPlanId: plan.id,
            stripeEventId: event.id,
            metadata: { stripeStatus: sub.status },
          },
        })

        // Deactivate agents if subscription is in a bad state
        if (!['active', 'trialing'].includes(sub.status)) {
          await prisma.agentProfile.updateMany({
            where: { userId: subscription.userId },
            data: { isActive: false },
          })
          console.log(
            `[webhooks] Subscription ${sub.id} status=${sub.status} — agents deactivated for user ${subscription.userId}`,
          )
        }

        console.log(
          `[webhooks] ${event.type}: customer=${customerId} plan=${plan.slug} status=${sub.status}`,
        )
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription

        const subscription = await prisma.subscription.findUnique({
          where: { stripeSubscriptionId: sub.id },
        })

        if (!subscription) {
          console.warn(`[webhooks] subscription.deleted — no record found for sub ${sub.id}`)
          break
        }

        await prisma.subscription.update({
          where: { stripeSubscriptionId: sub.id },
          data: { status: 'canceled', canceledAt: new Date(), updatedAt: new Date() },
        })

        const starterPlan = await prisma.plan.findUnique({ where: { slug: 'starter' } })

        await prisma.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            userId: subscription.userId,
            eventType: 'canceled',
            fromPlanId: subscription.planId,
            toPlanId: starterPlan?.id,
            stripeEventId: event.id,
            metadata: { stripeStatus: sub.status },
          },
        })

        // Keep starter limit (3) active; deactivate any extras ordered by creation
        const agents = await prisma.agentProfile.findMany({
          where: { userId: subscription.userId, isDeleted: false },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })

        const starterLimit = starterPlan?.maxAgentListings ?? 3
        if (agents.length > starterLimit) {
          const toDeactivate = agents.slice(starterLimit).map((a) => a.id)
          await prisma.agentProfile.updateMany({
            where: { id: { in: toDeactivate } },
            data: { isActive: false },
          })
          console.log(
            `[webhooks] Subscription canceled for user ${subscription.userId} — deactivated ${toDeactivate.length} excess agent(s)`,
          )
        }

        console.log(`[webhooks] subscription.deleted: sub=${sub.id} user=${subscription.userId}`)
        break
      }

      default:
        console.log(`[webhooks] Unhandled event type: ${event.type}`)
    }
  } catch (err) {
    console.error('[webhooks] Handler error:', err)
    return c.json({ error: 'Handler error' }, 500)
  }

  return c.json({ received: true })
})

export default webhooks
