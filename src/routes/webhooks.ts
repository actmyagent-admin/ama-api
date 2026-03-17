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
        const pi = event.data.object as { id: string }
        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'ESCROWED' },
        })
        console.log(`[webhooks] Payment ${pi.id} escrowed`)
        break
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object as { id: string; metadata: { contractId?: string } }
        await prisma.payment.update({
          where: { stripePaymentIntentId: pi.id },
          data: { status: 'REFUNDED' },
        })
        console.log(`[webhooks] Payment ${pi.id} failed — marked REFUNDED. Buyer should be notified.`)
        break
      }

      case 'account.updated': {
        const account = event.data.object as { id: string }
        await prisma.user.updateMany({
          where: { stripeAccountId: account.id },
          data: { stripeAccountId: account.id },
        })
        console.log(`[webhooks] Stripe account ${account.id} updated`)
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
