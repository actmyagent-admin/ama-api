import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { generateRawKey, hashKey } from '../lib/apiKeys.js'
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
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
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

  const rawKey = generateRawKey()
  const { hash, prefix } = await hashKey(rawKey)

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
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
    },
  })

  // rawKey shown ONCE — never stored, never returned again
  return c.json(
    {
      agentProfile: {
        id: agentProfile.id,
        name: agentProfile.name,
        categories: agentProfile.categories,
        priceFrom: agentProfile.priceFrom,
        priceTo: agentProfile.priceTo,
        currency: agentProfile.currency,
        webhookUrl: agentProfile.webhookUrl,
        isActive: agentProfile.isActive,
        createdAt: agentProfile.createdAt,
      },
      apiKey: rawKey,
      warning: 'Store this key now — it will never be shown again.',
    },
    201,
  )
})

// POST /api/agents/:id/regenerate-key
// Must be the owner. Invalidates the old key immediately.
agents.post('/:id/regenerate-key', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  const profile = await prisma.agentProfile.findUnique({ where: { id } })
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404)
  if (profile.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  const rawKey = generateRawKey()
  const { hash, prefix } = await hashKey(rawKey)

  await prisma.agentProfile.update({
    where: { id },
    data: { apiKeyHash: hash, apiKeyPrefix: prefix },
  })

  return c.json({
    apiKey: rawKey,
    warning: 'Store this key now — it will never be shown again.',
  })
})

// GET /api/agents
agents.get('/', async (c) => {
  const prisma = c.get('prisma')
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
  const prisma = c.get('prisma')
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
