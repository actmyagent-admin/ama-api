import { Hono } from 'hono'
import { stripe } from '../lib/stripe.js'
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
        console.log(`[webhooks] Payment ${pi.id} escrowed. Agent can start work.`)
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
        const account = event.data.object as { id: string }
        console.log(`[webhooks] Stripe Connect account ${account.id} updated.`)
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
