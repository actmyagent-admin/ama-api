/**
 * Featured Agents endpoints — admin-managed curation list.
 *
 * GET  /api/featured-agents           — public, returns active featured agents
 * POST /api/featured-agents           — admin-only, add an agent to the featured list
 * PUT  /api/featured-agents/:id       — admin-only, update a featured agent entry
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from '../types/index.js'

const featuredAgents = new Hono<{ Variables: Variables }>()

// Shared admin auth guard
function adminGuard(secret: string | undefined, provided: string | undefined): boolean {
  if (!secret) return false
  if (!provided) return false
  return provided === secret
}

const agentProfileSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  mainPic: true,
  coverPic: true,
  priceFrom: true,
  priceTo: true,
  currency: true,
  isVerified: true,
  avgRating: true,
  totalJobs: true,
  categories: {
    select: { id: true, name: true, slug: true, mainPic: true, coverPic: true },
  },
  user: {
    select: { userName: true, name: true, mainPic: true },
  },
} as const

const createSchema = z.object({
  agentProfileId: z.string().uuid(),
  isActive: z.boolean().default(true),
  showOnHomePage: z.boolean().default(false),
  order: z.number().int().default(0),
})

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  showOnHomePage: z.boolean().optional(),
  order: z.number().int().optional(),
})

// GET /api/featured-agents
// Query params:
//   ?showOnHomePage=true  — filter to homepage-only entries
//   ?limit=<n>            — max results (default 20, max 100)
//   ?offset=<n>           — pagination offset
featuredAgents.get('/', async (c) => {
  const prisma = c.get('prisma')
  const showOnHomePage = c.req.query('showOnHomePage')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const entries = await prisma.featuredAgent.findMany({
    where: {
      isActive: true,
      ...(showOnHomePage === 'true' ? { showOnHomePage: true } : {}),
    },
    orderBy: { order: 'asc' },
    take: limit,
    skip: offset,
    select: {
      id: true,
      isActive: true,
      showOnHomePage: true,
      order: true,
      createdAt: true,
      updatedAt: true,
      agentProfile: { select: agentProfileSelect },
    },
  })

  c.header('Cache-Control', 'public, max-age=120, s-maxage=120')
  return c.json({ featuredAgents: entries, limit, offset })
})

// POST /api/featured-agents  — admin only
featuredAgents.post('/', async (c) => {
  const adminSecret = process.env.ADMIN_SECRET
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  if (!adminGuard(adminSecret, token)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const prisma = c.get('prisma')

  let body: z.infer<typeof createSchema>
  try {
    body = createSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const agentExists = await prisma.agentProfile.findUnique({
    where: { id: body.agentProfileId },
    select: { id: true },
  })
  if (!agentExists) {
    return c.json({ error: 'AgentProfile not found' }, 404)
  }

  const entry = await prisma.featuredAgent.create({
    data: {
      agentProfileId: body.agentProfileId,
      isActive: body.isActive,
      showOnHomePage: body.showOnHomePage,
      order: body.order,
    },
    select: {
      id: true,
      isActive: true,
      showOnHomePage: true,
      order: true,
      createdAt: true,
      updatedAt: true,
      agentProfile: { select: agentProfileSelect },
    },
  })

  return c.json({ featuredAgent: entry }, 201)
})

// PUT /api/featured-agents/:id  — admin only
featuredAgents.put('/:id', async (c) => {
  const adminSecret = process.env.ADMIN_SECRET
  const auth = c.req.header('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  if (!adminGuard(adminSecret, token)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const prisma = c.get('prisma')
  const id = c.req.param('id')

  const existing = await prisma.featuredAgent.findUnique({ where: { id } })
  if (!existing) return c.json({ error: 'Featured agent entry not found' }, 404)

  let body: z.infer<typeof updateSchema>
  try {
    body = updateSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const updated = await prisma.featuredAgent.update({
    where: { id },
    data: {
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.showOnHomePage !== undefined && { showOnHomePage: body.showOnHomePage }),
      ...(body.order !== undefined && { order: body.order }),
    },
    select: {
      id: true,
      isActive: true,
      showOnHomePage: true,
      order: true,
      createdAt: true,
      updatedAt: true,
      agentProfile: { select: agentProfileSelect },
    },
  })

  return c.json({ featuredAgent: updated })
})

export default featuredAgents
