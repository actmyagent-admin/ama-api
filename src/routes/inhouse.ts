import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const inhouse = new Hono<{ Variables: Variables }>()

// ─── Secret-based admin middleware (existing dispute/CRUD routes) ─────────────
const adminAuth = async (c: any, next: any) => {
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret) return c.json({ error: 'Admin access not configured' }, 500)
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || token !== adminSecret) return c.json({ error: 'Unauthorized' }, 401)
  await next()
}

// ─── JWT admin middleware — user's email must be in ADMIN_EMAILS ──────────────
function parseAdminEmails(): string[] {
  try {
    const raw = process.env.ADMIN_EMAILS ?? '[]'
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((e: string) => e.toLowerCase()) : []
  } catch {
    return []
  }
}

const jwtAdminCheck = async (c: any, next: any) => {
  const user = c.get('user')
  const adminEmails = parseAdminEmails()
  if (!adminEmails.includes(user.email.toLowerCase())) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  await next()
}

// Combined: JWT auth first, then email check
const jwtAdminAuth = [authMiddleware, jwtAdminCheck]

// ─── PUBLIC: Service catalog ──────────────────────────────────────────────────

// GET /api/inhouse/services?pageSlug=create-digital-art
inhouse.get('/services', async (c) => {
  const prisma = c.get('prisma')
  const pageSlug = c.req.query('pageSlug')

  const services = await prisma.inhouseService.findMany({
    where: {
      isActive: true,
      ...(pageSlug ? { pageSlug } : {}),
    },
    orderBy: [{ pageSlug: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true,
      pageSlug: true,
      category: true,
      packageName: true,
      tagline: true,
      description: true,
      priceCents: true,
      deliveryDays: true,
      revisionsIncluded: true,
      deliveryVariants: true,
      pricePerExtraRevisionCents: true,
      pricePerExtraVariantCents: true,
      whatsIncluded: true,
      whatsNotIncluded: true,
      perfectFor: true,
      inputSchema: true,
      sortOrder: true,
      isHighlighted: true,
    },
  })

  return c.json({ services })
})

// GET /api/inhouse/services/:pageSlug — all packages for a landing page
inhouse.get('/services/:pageSlug', async (c) => {
  const prisma = c.get('prisma')
  const pageSlug = c.req.param('pageSlug')

  const services = await prisma.inhouseService.findMany({
    where: { pageSlug, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      pageSlug: true,
      category: true,
      packageName: true,
      tagline: true,
      description: true,
      priceCents: true,
      deliveryDays: true,
      revisionsIncluded: true,
      deliveryVariants: true,
      pricePerExtraRevisionCents: true,
      pricePerExtraVariantCents: true,
      whatsIncluded: true,
      whatsNotIncluded: true,
      perfectFor: true,
      inputSchema: true,
      sortOrder: true,
      isHighlighted: true,
    },
  })

  return c.json({ services })
})

// ─── BUYER: Order management ──────────────────────────────────────────────────

const createOrderSchema = z.object({
  serviceId: z.string().uuid(),
  buyerInputs: z.record(z.unknown()).optional().default({}),
  description: z.string().optional(),
  exampleUrls: z.array(z.string().url()).optional().default([]),
  attachmentKeys: z.array(z.string()).optional().default([]),
  attachmentNames: z.array(z.string()).optional().default([]),
})

// POST /api/inhouse/orders
inhouse.post('/orders', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only BUYER accounts can place orders' }, 403)
  }

  let body: z.infer<typeof createOrderSchema>
  try {
    body = createOrderSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const service = await prisma.inhouseService.findUnique({
    where: { id: body.serviceId, isActive: true },
    include: {
      assignedAgent: { include: { user: true } },
    },
  })

  if (!service) return c.json({ error: 'Service not found' }, 404)
  if (!service.assignedAgent) {
    return c.json({ error: 'Service is not currently available' }, 409)
  }

  const now = new Date()
  const deadline = new Date(now.getTime() + service.deliveryDays * 24 * 60 * 60 * 1000)
  const paymentDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const scope = buildScope(service, body.description)
  const deliverables = service.whatsIncluded.length > 0
    ? service.whatsIncluded.map((i) => `• ${i}`).join('\n')
    : service.description

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.inhouseOrder.create({
      data: {
        serviceId: service.id,
        buyerId: user.id,
        priceCents: service.priceCents,
        currency: 'usd',
        buyerInputs: body.buyerInputs,
        description: body.description,
        exampleUrls: body.exampleUrls,
        attachmentKeys: body.attachmentKeys,
        attachmentNames: body.attachmentNames,
        status: 'pending_payment',
      },
    })

    const contract = await tx.contract.create({
      data: {
        buyerId: user.id,
        agentProfileId: service.assignedAgent!.id,
        scope,
        deliverables,
        price: service.priceCents / 100,
        currency: 'usd',
        deadline,
        agreedPrice: service.priceCents,
        agreedDeliveryDays: service.deliveryDays,
        agreedRevisionsIncluded: service.revisionsIncluded,
        agreedDeliveryVariants: service.deliveryVariants,
        pricePerExtraRevision: service.pricePerExtraRevisionCents,
        pricePerExtraVariant: service.pricePerExtraVariantCents,
        buyerRequirements: body.description ?? null,
        buyerSignedAt: now,
        agentSignedAt: now,
        bothSignedAt: now,
        paymentDeadline,
        status: 'SIGNED_BOTH',
        isInhouse: true,
      },
    })

    await tx.inhouseOrder.update({
      where: { id: order.id },
      data: { contractId: contract.id },
    })

    return { order, contract }
  })

  return c.json(
    {
      order: result.order,
      contract: {
        id: result.contract.id,
        status: result.contract.status,
        paymentDeadline: result.contract.paymentDeadline,
        agreedPrice: result.contract.agreedPrice,
        currency: result.contract.currency,
      },
    },
    201,
  )
})

// GET /api/inhouse/orders/my — buyer's inhouse orders
inhouse.get('/orders/my', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only BUYER accounts can access their orders' }, 403)
  }

  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const orders = await prisma.inhouseOrder.findMany({
    where: {
      buyerId: user.id,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      buyer: {
        select: { id: true, name: true, email: true, userName: true, mainPic: true },
      },
      service: {
        select: {
          id: true,
          pageSlug: true,
          packageName: true,
          description: true,
          priceCents: true,
          deliveryDays: true,
        },
      },
      contract: {
        select: {
          id: true,
          status: true,
          paymentDeadline: true,
          payment: { select: { status: true } },
          delivery: { select: { id: true, status: true, submittedAt: true } },
        },
      },
    },
  })

  return c.json({ orders, limit, offset })
})

// ─── ADMIN: Service management ────────────────────────────────────────────────

const serviceSchema = z.object({
  pageSlug: z.string().min(1),
  category: z.string().min(1),
  packageName: z.string().min(1),
  tagline: z.string().optional(),
  description: z.string().min(1),
  priceCents: z.number().int().positive(),
  deliveryDays: z.number().int().positive(),
  revisionsIncluded: z.number().int().nonnegative().default(2),
  deliveryVariants: z.number().int().positive().default(1),
  pricePerExtraRevisionCents: z.number().int().nonnegative().nullable().optional(),
  pricePerExtraVariantCents: z.number().int().nonnegative().nullable().optional(),
  whatsIncluded: z.array(z.string()).default([]),
  whatsNotIncluded: z.array(z.string()).default([]),
  perfectFor: z.array(z.string()).default([]),
  inputSchema: z.array(z.unknown()).default([]),
  assignedAgentProfileId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().default(0),
  isHighlighted: z.boolean().default(false),
  isActive: z.boolean().default(true),
})

// POST /api/inhouse/admin/services
inhouse.post('/admin/services', adminAuth, async (c) => {
  const prisma = c.get('prisma')

  let body: z.infer<typeof serviceSchema>
  try {
    body = serviceSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const service = await prisma.inhouseService.create({
    data: {
      ...body,
      inputSchema: body.inputSchema as any,
    },
  })

  return c.json({ service }, 201)
})

// PATCH /api/inhouse/admin/services/:id
inhouse.patch('/admin/services/:id', adminAuth, async (c) => {
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  let body: Partial<z.infer<typeof serviceSchema>>
  try {
    body = serviceSchema.partial().parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const existing = await prisma.inhouseService.findUnique({ where: { id } })
  if (!existing) return c.json({ error: 'Service not found' }, 404)

  const service = await prisma.inhouseService.update({
    where: { id },
    data: {
      ...body,
      ...(body.inputSchema !== undefined && { inputSchema: body.inputSchema as any }),
    },
  })

  return c.json({ service })
})

// DELETE /api/inhouse/admin/services/:id — soft-deactivate
inhouse.delete('/admin/services/:id', adminAuth, async (c) => {
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  const existing = await prisma.inhouseService.findUnique({ where: { id } })
  if (!existing) return c.json({ error: 'Service not found' }, 404)

  await prisma.inhouseService.update({ where: { id }, data: { isActive: false } })
  return c.json({ deleted: true })
})

// GET /api/inhouse/admin/services — all services including inactive
inhouse.get('/admin/services', adminAuth, async (c) => {
  const prisma = c.get('prisma')

  const services = await prisma.inhouseService.findMany({
    orderBy: [{ pageSlug: 'asc' }, { sortOrder: 'asc' }],
    include: {
      assignedAgent: { select: { id: true, name: true, slug: true } },
      _count: { select: { orders: true } },
    },
  })

  return c.json({ services })
})

// GET /api/inhouse/admin/orders — all inhouse orders
inhouse.get('/admin/orders', adminAuth, async (c) => {
  const prisma = c.get('prisma')
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const offset = Number(c.req.query('offset') ?? 0)

  const orders = await prisma.inhouseOrder.findMany({
    where: { ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      service: { select: { id: true, pageSlug: true, packageName: true } },
      buyer: { select: { id: true, name: true, email: true, userName: true } },
      contract: {
        select: {
          id: true,
          status: true,
          payment: { select: { status: true, amountTotal: true } },
          delivery: { select: { id: true, status: true } },
        },
      },
    },
  })

  return c.json({ orders, limit, offset })
})

// POST /api/inhouse/admin/super-agents — create a super agent profile
const superAgentSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().min(1),
  categorySlugs: z.array(z.string()).min(1),
  priceFrom: z.number().positive(),
  priceTo: z.number().positive(),
})

inhouse.post('/admin/super-agents', adminAuth, async (c) => {
  const prisma = c.get('prisma')

  let body: z.infer<typeof superAgentSchema>
  try {
    body = superAgentSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const owner = await prisma.user.findFirst({ where: { email: 'actmyagent@gmail.com' } })
  if (!owner) return c.json({ error: 'Platform owner account not found' }, 500)

  const categories = await prisma.category.findMany({
    where: { slug: { in: body.categorySlugs } },
    select: { id: true },
  })

  const profile = await prisma.agentProfile.create({
    data: {
      userId: owner.id,
      name: body.name,
      slug: body.slug,
      description: body.description,
      priceFrom: body.priceFrom,
      priceTo: body.priceTo,
      categories: { connect: categories.map((c) => ({ id: c.id })) },
      webhookUrl: null,
      isSuperAgent: true,
      isVerified: true,
    },
    select: { id: true, name: true, slug: true, isSuperAgent: true },
  })

  return c.json({ agentProfile: profile }, 201)
})

// ─── JWT Admin: all inhouse orders ───────────────────────────────────────────
// GET /api/inhouse/orders/all
// Auth: JWT where user.email is in ADMIN_EMAILS
inhouse.get('/orders/all', ...jwtAdminAuth, async (c) => {
  const prisma = c.get('prisma')
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const orders = await prisma.inhouseOrder.findMany({
    where: { ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      buyer: {
        select: { id: true, name: true, email: true, userName: true, mainPic: true },
      },
      service: {
        select: {
          id: true,
          pageSlug: true,
          packageName: true,
          priceCents: true,
          deliveryDays: true,
        },
      },
      contract: {
        select: {
          id: true,
          status: true,
          paymentDeadline: true,
          payment: { select: { status: true, amountTotal: true } },
          delivery: { select: { id: true, status: true, submittedAt: true } },
        },
      },
    },
  })

  return c.json({ orders, limit, offset })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScope(service: { packageName: string; description: string }, extra?: string): string {
  const base = `${service.packageName}: ${service.description}`
  return extra ? `${base}\n\nAdditional details: ${extra}` : base
}

export default inhouse
