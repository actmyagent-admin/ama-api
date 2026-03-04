import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { stripe } from '../lib/stripe.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const payments = new Hono<{ Variables: Variables }>()

const createPaymentSchema = z.object({
  contractId: z.string().uuid(),
})

// POST /api/payments/create
payments.post('/create', authMiddleware, async (c) => {
  const user = c.get('user')

  if (user.role !== 'BUYER') {
    return c.json({ error: 'Only buyers can initiate payments' }, 403)
  }

  let body: z.infer<typeof createPaymentSchema>
  try {
    body = createPaymentSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const contract = await prisma.contract.findUnique({
    where: { id: body.contractId },
    include: { payment: true, agentProfile: { include: { user: true } } },
  })

  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (contract.status !== 'ACTIVE') return c.json({ error: 'Contract must be ACTIVE to initiate payment' }, 409)
  if (contract.payment) return c.json({ error: 'Payment already exists for this contract' }, 409)

  const agentStripeAccountId = contract.agentProfile.user.stripeAccountId
  if (!agentStripeAccountId) {
    return c.json({ error: 'Agent has not connected a Stripe account' }, 409)
  }

  const amountCents = Math.round(contract.price * 100)
  const platformFeeCents = Math.round(contract.price * 0.15 * 100)

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: contract.currency.toLowerCase(),
    application_fee_amount: platformFeeCents,
    capture_method: 'manual',
    transfer_data: { destination: agentStripeAccountId },
    metadata: { contractId: contract.id },
  })

  await prisma.payment.create({
    data: {
      contractId: contract.id,
      stripePaymentIntentId: paymentIntent.id,
      amount: contract.price,
      currency: contract.currency,
      status: 'PENDING',
    },
  })

  return c.json({ clientSecret: paymentIntent.client_secret }, 201)
})

// POST /api/payments/capture (called internally after delivery approval)
export async function capturePayment(contractId: string) {
  const payment = await prisma.payment.findUnique({ where: { contractId } })
  if (!payment) throw new Error('Payment not found')
  if (payment.status === 'RELEASED') return payment

  await stripe.paymentIntents.capture(payment.stripePaymentIntentId)

  const updated = await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'RELEASED' },
    }),
    prisma.contract.update({
      where: { id: contractId },
      data: { status: 'COMPLETED' },
    }),
  ])

  return updated[0]
}

payments.post('/capture', authMiddleware, async (c) => {
  const user = c.get('user')

  let body: z.infer<typeof createPaymentSchema>
  try {
    body = createPaymentSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const contract = await prisma.contract.findUnique({ where: { id: body.contractId } })
  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  try {
    const payment = await capturePayment(body.contractId)
    return c.json({ payment })
  } catch (err) {
    return c.json({ error: 'Payment capture failed', details: String(err) }, 500)
  }
})

export default payments
