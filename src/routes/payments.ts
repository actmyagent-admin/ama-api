import { Hono } from 'hono'
import { z } from 'zod'
import { stripe } from '../lib/stripe.js'
import { authMiddleware } from '../middleware/auth.js'
import { createPendingLedgerEntries } from '../lib/ledger.js'
import type { Variables } from '../types/index.js'

const payments = new Hono<{ Variables: Variables }>()

const createPaymentSchema = z.object({
  contractId: z.string().uuid(),
})

// POST /api/payments/create
// Buyer calls this after both parties have signed the contract.
// Creates a Stripe PaymentIntent with manual capture (true escrow).
payments.post('/create', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('BUYER')) {
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
    include: {
      payment: true,
      agentProfile: { include: { user: true } },
      job: true,
    },
  })

  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (contract.status !== 'SIGNED_BOTH') {
    return c.json(
      { error: 'Contract must have both signatures before payment can be initiated' },
      409,
    )
  }
  if (contract.payment) {
    return c.json({ error: 'Payment already exists for this contract' }, 409)
  }

  const agentStripeAccountId = contract.agentProfile.user.stripeAccountId
  if (!agentStripeAccountId) {
    return c.json({ error: 'Agent has not connected a Stripe account' }, 409)
  }

  // Always work in integer cents — never use floats for money
  const amountTotal = Math.round(contract.price * 100)
  const amountPlatformFee = Math.round(amountTotal * 0.15)
  const amountAgentReceives = amountTotal - amountPlatformFee
  const currency = contract.currency.toLowerCase()

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountTotal,
    currency,
    capture_method: 'manual', // funds reserved, not captured — true escrow
    application_fee_amount: amountPlatformFee,
    transfer_data: { destination: agentStripeAccountId },
    metadata: {
      contractId: contract.id,
      buyerId: user.id,
      agentProfileId: contract.agentProfileId,
      platform: 'actmyagent',
    },
    description: `ActMyAgent – ${contract.job?.title ?? contract.id}`,
  })

  const payment = await prisma.payment.create({
    data: {
      contractId: contract.id,
      stripePaymentIntentId: paymentIntent.id,
      amountTotal,
      amountPlatformFee,
      amountAgentReceives,
      currency,
      agentStripeAccountId,
      status: 'PENDING',
    },
  })

  await createPendingLedgerEntries(prisma, {
    paymentId: payment.id,
    contractId: contract.id,
    buyerId: user.id,
    agentUserId: contract.agentProfile.userId,
    amountTotal,
    amountPlatformFee,
    amountAgentReceives,
    currency,
    stripeReference: paymentIntent.id,
  })

  return c.json(
    {
      clientSecret: paymentIntent.client_secret,
      amountTotal,
      amountPlatformFee,
      amountAgentReceives,
      currency,
    },
    201,
  )
})

export default payments
