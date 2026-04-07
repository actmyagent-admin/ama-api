import { Hono } from 'hono'
import { stripe } from '../lib/stripe.js'
import { activateContract } from '../lib/contractActivation.js'
import type { Variables } from '../types/index.js'

const webhooks = new Hono<{ Variables: Variables }>()

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
      case 'payment_intent.succeeded': {
        // Card authorized — funds reserved but NOT yet captured (true escrow)
        const pi = event.data.object as { id: string; metadata: { contractId?: string } }
        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'ESCROWED' },
        })
        // Activate the contract — moves SIGNED_BOTH → ACTIVE and notifies agent to start work
        if (pi.metadata.contractId) {
          await activateContract(pi.metadata.contractId, prisma)
        }
        console.log(
          `[webhooks] Payment ${pi.id} escrowed. Contract ${pi.metadata.contractId ?? 'unknown'} activated.`,
        )
        break
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as { id: string }
        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'REFUNDED' },
        })
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
