import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const agents = new Hono<{ Variables: Variables }>()

const registerSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  categories: z.array(z.string()).min(1),
  priceFrom: z.number().positive(),
  priceTo: z.number().positive(),
  currency: z.string().default('USD'),
  webhookUrl: z.string().url(),
})

// POST /api/agents/register
agents.post('/register', authMiddleware, async (c) => {
  const user = c.get('user')

  if (user.role !== 'AGENT_LISTER') {
    return c.json({ error: 'Only AGENT_LISTER accounts can register agents' }, 403)
  }

  const existing = await prisma.agentProfile.findUnique({ where: { userId: user.id } })
  if (existing) {
    return c.json({ error: 'Agent profile already exists for this user' }, 409)
  }

  let body: z.infer<typeof registerSchema>
  try {
    body = registerSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  if (body.priceTo < body.priceFrom) {
    return c.json({ error: 'priceTo must be >= priceFrom' }, 400)
  }

  const agentProfile = await prisma.agentProfile.create({
    data: {
      userId: user.id,
      name: body.name,
      description: body.description,
      categories: body.categories,
      priceFrom: body.priceFrom,
      priceTo: body.priceTo,
      currency: body.currency,
      webhookUrl: body.webhookUrl,
    },
  })

  return c.json({ agentProfile, apiKey: user.apiKey }, 201)
})

// GET /api/agents
agents.get('/', async (c) => {
  const category = c.req.query('category')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const agentProfiles = await prisma.agentProfile.findMany({
    where: {
      isActive: true,
      ...(category ? { categories: { has: category } } : {}),
    },
    take: limit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      categories: true,
      priceFrom: true,
      priceTo: true,
      currency: true,
      isVerified: true,
      avgRating: true,
      totalJobs: true,
      createdAt: true,
    },
  })

  return c.json({ agentProfiles, limit, offset })
})

// GET /api/agents/:id
agents.get('/:id', async (c) => {
  const id = c.req.param('id')
  const agentProfile = await prisma.agentProfile.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      categories: true,
      priceFrom: true,
      priceTo: true,
      currency: true,
      isVerified: true,
      avgRating: true,
      totalJobs: true,
      createdAt: true,
    },
  })

  if (!agentProfile) {
    return c.json({ error: 'Agent not found' }, 404)
  }

  return c.json({ agentProfile })
})

export default agents
