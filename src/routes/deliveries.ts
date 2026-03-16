import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authMiddleware } from '../middleware/auth.js'
import { capturePayment } from './payments.js'
import type { Variables } from '../types/index.js'

const deliveries = new Hono<{ Variables: Variables }>()

const submitDeliverySchema = z.object({
  contractId: z.string().uuid(),
  description: z.string().min(1),
  fileUrls: z.array(z.string().url()).default([]),
})

// POST /api/deliveries
deliveries.post('/', authMiddleware, async (c) => {
  const user = c.get('user')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agents can submit deliveries' }, 403)
  }

  let body: z.infer<typeof submitDeliverySchema>
  try {
    body = submitDeliverySchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const contract = await prisma.contract.findUnique({
    where: { id: body.contractId },
    include: { agentProfile: { include: { user: true } }, delivery: true },
  })

  if (!contract) return c.json({ error: 'Contract not found' }, 404)
  if (contract.agentProfile.user.id !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (contract.status !== 'ACTIVE') return c.json({ error: 'Contract must be ACTIVE to submit delivery' }, 409)
  if (contract.delivery) return c.json({ error: 'Delivery already submitted' }, 409)

  const delivery = await prisma.delivery.create({
    data: {
      contractId: body.contractId,
      description: body.description,
      fileUrls: body.fileUrls,
    },
  })

  console.log(`[deliveries] Delivery ${delivery.id} submitted for contract ${body.contractId}. Buyer should be notified.`)

  return c.json({ delivery }, 201)
})

// POST /api/deliveries/:id/approve
deliveries.post('/:id/approve', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only buyers can approve deliveries' }, 403)
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { contract: true },
  })

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404)
  if (delivery.contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (delivery.status !== 'SUBMITTED') return c.json({ error: 'Delivery is not in SUBMITTED state' }, 409)

  const updatedDelivery = await prisma.delivery.update({
    where: { id },
    data: { status: 'APPROVED' },
  })

  let payment = null
  try {
    payment = await capturePayment(delivery.contractId)
  } catch (err) {
    console.error('[deliveries] Payment capture failed after approval:', err)
  }

  return c.json({ delivery: updatedDelivery, payment })
})

// POST /api/deliveries/:id/dispute
deliveries.post('/:id/dispute', authMiddleware, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only buyers can dispute deliveries' }, 403)
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { contract: true },
  })

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404)
  if (delivery.contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (delivery.status !== 'SUBMITTED') return c.json({ error: 'Delivery is not in SUBMITTED state' }, 409)

  const [updatedDelivery] = await prisma.$transaction([
    prisma.delivery.update({ where: { id }, data: { status: 'DISPUTED' } }),
    prisma.contract.update({ where: { id: delivery.contractId }, data: { status: 'DISPUTED' } }),
  ])

  return c.json({ delivery: updatedDelivery })
})

export default deliveries
