import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { generateRawKey, hashKey } from '../lib/apiKeys.js'
import type { Variables } from '../types/index.js'

const agents = new Hono<{ Variables: Variables }>()

const registerSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Array of Category slugs e.g. ["development", "design"]
  categorySlugs: z.array(z.string()).min(1),
  priceFrom: z.number().positive(),
  priceTo: z.number().positive(),
  currency: z.string().default('USD'),
  webhookUrl: z.string().url(),
})

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  priceFrom: z.number().positive().optional(),
  priceTo: z.number().positive().optional(),
  webhookUrl: z.string().url().optional(),
  mainPic: z.string().url().nullable().optional(),
  coverPic: z.string().url().nullable().optional(),
  categorySlugs: z.array(z.string()).min(1).optional(),
})

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

async function generateUniqueSlug(
  name: string,
  prisma: ReturnType<typeof import('../lib/prisma.js').createPrisma>,
): Promise<string> {
  const base = toSlug(name)
  let slug = base
  let n = 1
  // findFirst works before Prisma client is regenerated with the new slug unique index
  while (await prisma.agentProfile.findFirst({ where: { slug } })) {
    slug = `${base}-${n++}`
  }
  return slug
}

const categorySelect = {
  id: true,
  name: true,
  slug: true,
  mainPic: true,
  coverPic: true,
} as const

const listedBySelect = {
  select: {
    userName: true,
    name: true,
    mainPic: true,
  },
} as const

const agentProfileSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  mainPic: true,
  coverPic: true,
  categories: { select: categorySelect },
  priceFrom: true,
  priceTo: true,
  currency: true,
  isVerified: true,
  isActive: true,
  avgRating: true,
  totalJobs: true,
  createdAt: true,
  user: listedBySelect,
} as const

// POST /api/agents/register
agents.post('/register', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only AGENT_LISTER accounts can register agents' }, 403)
  }

  const existingCount = await prisma.agentProfile.count({ where: { userId: user.id } })
  if (existingCount >= 3) {
    return c.json({ error: 'Maximum limit reached' }, 403)
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
  const slug = await generateUniqueSlug(body.name, prisma)

  const agentProfile = await prisma.agentProfile.create({
    data: {
      userId: user.id,
      name: body.name,
      slug,
      description: body.description,
      categories: { connect: body.categorySlugs.map((s) => ({ slug: s })) },
      priceFrom: body.priceFrom,
      priceTo: body.priceTo,
      currency: body.currency,
      webhookUrl: body.webhookUrl,
      apiKeyHash: hash,
      apiKeyPrefix: prefix,
    },
    include: { categories: { select: categorySelect } },
  })

  // rawKey shown ONCE — never stored, never returned again
  return c.json(
    {
      agentProfile: {
        id: agentProfile.id,
        name: agentProfile.name,
        slug: agentProfile.slug,
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

// PATCH /api/agents/:id — update agent profile fields (owner only)
agents.patch('/:id', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  const profile = await prisma.agentProfile.findUnique({ where: { id } })
  if (!profile) return c.json({ error: 'Agent profile not found' }, 404)
  if (profile.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  let body: z.infer<typeof updateAgentSchema>
  try {
    body = updateAgentSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const effectivePriceFrom = body.priceFrom ?? profile.priceFrom
  const effectivePriceTo = body.priceTo ?? profile.priceTo
  if (effectivePriceTo < effectivePriceFrom) {
    return c.json({ error: 'priceTo must be >= priceFrom' }, 400)
  }

  const updated = await prisma.agentProfile.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.priceFrom !== undefined && { priceFrom: body.priceFrom }),
      ...(body.priceTo !== undefined && { priceTo: body.priceTo }),
      ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
      ...(body.mainPic !== undefined && { mainPic: body.mainPic }),
      ...(body.coverPic !== undefined && { coverPic: body.coverPic }),
      ...(body.categorySlugs !== undefined && {
        categories: { set: body.categorySlugs.map((s) => ({ slug: s })) },
      }),
    },
    select: agentProfileSelect,
  })

  return c.json({ agentProfile: updated })
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

// GET /api/agents/:id/webhook-url
// Returns the webhookUrl for an agent profile.
// Owner-only — the authenticated user must own the profile.
agents.get('/:id/webhook-url', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  const profile = await prisma.agentProfile.findUnique({
    where: { id },
    select: { userId: true, webhookUrl: true },
  })

  if (!profile) return c.json({ error: 'Agent profile not found' }, 404)
  if (profile.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  return c.json({ webhookUrl: profile.webhookUrl })
})

// GET /api/agents — optional ?category=<slug> filter
agents.get('/', async (c) => {
  const prisma = c.get('prisma')
  const category = c.req.query('category')
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const agentProfiles = await prisma.agentProfile.findMany({
    where: {
      isActive: true,
      ...(category ? { categories: { some: { slug: category } } } : {}),
    },
    take: limit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
    select: agentProfileSelect,
  })

  c.header('Cache-Control', 'public, max-age=300, s-maxage=300')
  return c.json({ agentProfiles, limit, offset })
})

// GET /api/agents/by-user/:userId — list all agents for a user
agents.get('/by-user/:userId', async (c) => {
  const prisma = c.get('prisma')
  const userId = c.req.param('userId')

  const agentProfiles = await prisma.agentProfile.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: agentProfileSelect,
  })

  return c.json({ agentProfiles })
})

// GET /api/agents/:slug
agents.get('/:slug', async (c) => {
  const prisma = c.get('prisma')
  const slug = c.req.param('slug')
  const agentProfile = await prisma.agentProfile.findUnique({
    where: { slug },
    select: agentProfileSelect,
  })

  if (!agentProfile) {
    return c.json({ error: 'Agent not found' }, 404)
  }

  c.header('Cache-Control', 'public, max-age=300, s-maxage=300')
  return c.json({ agentProfile })
})

export default agents
