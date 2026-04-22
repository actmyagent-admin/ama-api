/**
 * Admin-only endpoints for dispute resolution.
 * Protected by ADMIN_SECRET env var (Bearer token).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { releaseEscrow, refundEscrow } from '../lib/escrow.js'
import type { Variables } from '../types/index.js'

const admin = new Hono<{ Variables: Variables }>()

// Simple admin auth middleware — checks Authorization: Bearer <ADMIN_SECRET>
admin.use('*', async (c, next) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) {
    console.error('[admin] ADMIN_SECRET env var not set')
    return c.json({ error: 'Admin access not configured' }, 500)
  }

  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  if (!token || token !== adminSecret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

// ─── POST /api/admin/disputes/:contractId/resolve ────────────────────────────
const resolveSchema = z.object({
  resolution: z.enum(['release_to_agent', 'refund_to_buyer']),
})

admin.post('/disputes/:contractId/resolve', async (c) => {
  const prisma = c.get('prisma')
  const { contractId } = c.req.param()

  let body: z.infer<typeof resolveSchema>
  try {
    body = resolveSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const delivery = await prisma.delivery.findFirst({
    where: { contractId, status: 'DISPUTED' },
    include: { contract: { include: { payment: true } } },
  })

  if (!delivery) return c.json({ error: 'Disputed delivery not found for this contract' }, 404)

  const payment = delivery.contract.payment
  if (!payment || payment.status !== 'ESCROWED') {
    return c.json({ error: 'Payment is not in escrow' }, 409)
  }

  if (body.resolution === 'release_to_agent') {
    try {
      await releaseEscrow(
        delivery.id,
        contractId,
        payment.id,
        payment.stripePaymentIntentId,
        prisma,
      )
      console.log(`[admin] Dispute resolved — released to agent. Contract ${contractId}`)
      return c.json({ resolved: true, resolution: 'released_to_agent' })
    } catch (err) {
      console.error('[admin] Stripe capture failed during dispute resolution:', err)
      return c.json({ error: 'Payment capture failed. Please contact Stripe support.' }, 500)
    }
  } else {
    try {
      await refundEscrow(contractId, payment.id, payment.stripePaymentIntentId, prisma)

      // Also update the delivery status so state is consistent
      await prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: 'DISPUTED' }, // remains DISPUTED — no REFUNDED delivery status needed
      })

      console.log(`[admin] Dispute resolved — refunded to buyer. Contract ${contractId}`)
      return c.json({ resolved: true, resolution: 'refunded_to_buyer' })
    } catch (err) {
      console.error('[admin] Stripe cancellation failed during dispute resolution:', err)
      return c.json({ error: 'Refund failed. Please contact Stripe support.' }, 500)
    }
  }
})

// ─── DELETE /api/admin/payments/:contractId/reset ────────────────────────────
// Removes a stuck PENDING payment so the buyer can retry checkout.
// Only safe on PENDING payments — ESCROWED funds must go through refund flow.
admin.delete('/payments/:contractId/reset', async (c) => {
  const prisma = c.get('prisma')
  const { contractId } = c.req.param()

  const payment = await prisma.payment.findUnique({ where: { contractId } })
  if (!payment) return c.json({ error: 'No payment found for this contract' }, 404)

  if (payment.status !== 'PENDING') {
    return c.json(
      { error: `Payment is in '${payment.status}' state — only PENDING payments can be reset. Use the dispute/refund flow for ESCROWED payments.` },
      409,
    )
  }

  await prisma.payment.delete({ where: { contractId } })

  console.log(`[admin] Stuck PENDING payment reset for contract ${contractId}`)
  return c.json({ reset: true, contractId })
})

// ─── GET /api/admin/disputes ─────────────────────────────────────────────────
// List all open disputes for the admin dashboard.
admin.get('/disputes', async (c) => {
  const prisma = c.get('prisma')

  const disputes = await prisma.delivery.findMany({
    where: { status: 'DISPUTED' },
    include: {
      contract: {
        include: {
          payment: true,
          job: { select: { title: true } },
          agentProfile: { select: { name: true, slug: true } },
          buyer: { select: { email: true, userName: true } },
        },
      },
    },
    orderBy: { disputedAt: 'asc' },
  })

  return c.json({ disputes })
})

export default admin
