import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { generateRawKey, hashKey } from '../lib/apiKeys.js'
import { canCreateAgentListing } from '../lib/subscriptions.js'
import type { Variables } from '../types/index.js'

const agents = new Hono<{ Variables: Variables }>()

const serviceTermsSchema = z.object({
  // Categorisation
  tags: z.array(z.string()).optional(),
  skillLevel: z.enum(['entry', 'professional', 'expert']).optional(),

  // Pricing structure
  pricingModel: z.enum(['fixed', 'hourly', 'per_word', 'per_minute', 'custom']).optional(),
  basePrice: z.number().int().nonnegative().optional(), // cents
  expressMultiplier: z.number().positive().nullable().optional(),

  // Delivery terms
  deliveryDays: z.number().int().positive().optional(),
  expressDeliveryDays: z.number().int().positive().nullable().optional(),
  maxFileSizeMb: z.number().int().positive().nullable().optional(),
  outputFormats: z.array(z.string()).optional(),
  inputRequirements: z.string().nullable().optional(),

  // Revision terms
  revisionsIncluded: z.number().int().nonnegative().optional(),
  pricePerExtraRevision: z.number().int().nonnegative().nullable().optional(), // cents
  maxRevisionRounds: z.number().int().positive().nullable().optional(),
  revisionWindowDays: z.number().int().positive().optional(),
  revisionsPolicy: z.string().nullable().optional(),

  // Delivery variants
  deliveryVariants: z.number().int().positive().optional(),
  pricePerExtraVariant: z.number().int().nonnegative().nullable().optional(), // cents
  maxDeliveryVariants: z.number().int().positive().nullable().optional(),

  // Service scope
  whatsIncluded: z.array(z.string()).optional(),
  whatsNotIncluded: z.array(z.string()).optional(),
  perfectFor: z.array(z.string()).optional(),

  // Operational terms
  responseTimeSlaHours: z.number().int().positive().optional(),
  maxConcurrentJobs: z.number().int().positive().nullable().optional(),
  availabilityStatus: z.enum(['available', 'busy', 'vacation', 'paused']).optional(),
  availableUntil: z.string().datetime().nullable().optional(),

  // Languages
  languagesSupported: z.array(z.string()).optional(),

  // Portfolio & proof
  portfolioItems: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    imageUrl: z.string().url().optional(),
    externalUrl: z.string().url().optional(),
    tags: z.array(z.string()).optional(),
  })).optional(),
  sampleOutputUrl: z.string().url().nullable().optional(),

  // Guarantee
  moneyBackGuarantee: z.boolean().optional(),
  guaranteeTerms: z.string().nullable().optional(),
})

const registerSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // Array of Category slugs e.g. ["development", "design"]
  categorySlugs: z.array(z.string()).min(1),
  priceFrom: z.number().positive(),
  priceTo: z.number().positive(),
  currency: z.string().default('USD'),
  webhookUrl: z.string().url(),
}).merge(serviceTermsSchema)

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  priceFrom: z.number().positive().optional(),
  priceTo: z.number().positive().optional(),
  webhookUrl: z.string().url().optional(),
  mainPic: z.string().url().nullable().optional(),
  coverPic: z.string().url().nullable().optional(),
  categorySlugs: z.array(z.string()).min(1).optional(),
}).merge(serviceTermsSchema)

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
  // Service terms
  tags: true,
  skillLevel: true,
  pricingModel: true,
  basePrice: true,
  expressMultiplier: true,
  deliveryDays: true,
  expressDeliveryDays: true,
  maxFileSizeMb: true,
  outputFormats: true,
  inputRequirements: true,
  revisionsIncluded: true,
  pricePerExtraRevision: true,
  maxRevisionRounds: true,
  revisionWindowDays: true,
  revisionsPolicy: true,
  deliveryVariants: true,
  pricePerExtraVariant: true,
  maxDeliveryVariants: true,
  whatsIncluded: true,
  whatsNotIncluded: true,
  perfectFor: true,
  responseTimeSlaHours: true,
  maxConcurrentJobs: true,
  availabilityStatus: true,
  availableUntil: true,
  languagesSupported: true,
  portfolioItems: true,
  sampleOutputUrl: true,
  totalReviews: true,
  completionRate: true,
  onTimeDeliveryRate: true,
  repeatClientRate: true,
  avgResponseHours: true,
  moneyBackGuarantee: true,
  guaranteeTerms: true,
} as const

// POST /api/agents/register
agents.post('/register', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only AGENT_LISTER accounts can register agents' }, 403)
  }

  const limitCheck = await canCreateAgentListing(user.id, prisma)
  if (!limitCheck.allowed) {
    return c.json({
      error: limitCheck.reason,
      code: 'PLAN_LIMIT_REACHED',
      currentCount: limitCheck.currentCount,
      limit: limitCheck.limit,
      upgradeUrl: '/settings/billing',
    }, 403)
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
      // Service terms (all optional at registration)
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.skillLevel !== undefined && { skillLevel: body.skillLevel }),
      ...(body.pricingModel !== undefined && { pricingModel: body.pricingModel }),
      ...(body.basePrice !== undefined && { basePrice: body.basePrice }),
      ...(body.expressMultiplier !== undefined && { expressMultiplier: body.expressMultiplier }),
      ...(body.deliveryDays !== undefined && { deliveryDays: body.deliveryDays }),
      ...(body.expressDeliveryDays !== undefined && { expressDeliveryDays: body.expressDeliveryDays }),
      ...(body.maxFileSizeMb !== undefined && { maxFileSizeMb: body.maxFileSizeMb }),
      ...(body.outputFormats !== undefined && { outputFormats: body.outputFormats }),
      ...(body.inputRequirements !== undefined && { inputRequirements: body.inputRequirements }),
      ...(body.revisionsIncluded !== undefined && { revisionsIncluded: body.revisionsIncluded }),
      ...(body.pricePerExtraRevision !== undefined && { pricePerExtraRevision: body.pricePerExtraRevision }),
      ...(body.maxRevisionRounds !== undefined && { maxRevisionRounds: body.maxRevisionRounds }),
      ...(body.revisionWindowDays !== undefined && { revisionWindowDays: body.revisionWindowDays }),
      ...(body.revisionsPolicy !== undefined && { revisionsPolicy: body.revisionsPolicy }),
      ...(body.deliveryVariants !== undefined && { deliveryVariants: body.deliveryVariants }),
      ...(body.pricePerExtraVariant !== undefined && { pricePerExtraVariant: body.pricePerExtraVariant }),
      ...(body.maxDeliveryVariants !== undefined && { maxDeliveryVariants: body.maxDeliveryVariants }),
      ...(body.whatsIncluded !== undefined && { whatsIncluded: body.whatsIncluded }),
      ...(body.whatsNotIncluded !== undefined && { whatsNotIncluded: body.whatsNotIncluded }),
      ...(body.perfectFor !== undefined && { perfectFor: body.perfectFor }),
      ...(body.responseTimeSlaHours !== undefined && { responseTimeSlaHours: body.responseTimeSlaHours }),
      ...(body.maxConcurrentJobs !== undefined && { maxConcurrentJobs: body.maxConcurrentJobs }),
      ...(body.availabilityStatus !== undefined && { availabilityStatus: body.availabilityStatus }),
      ...(body.availableUntil !== undefined && { availableUntil: body.availableUntil ? new Date(body.availableUntil) : null }),
      ...(body.languagesSupported !== undefined && { languagesSupported: body.languagesSupported }),
      ...(body.portfolioItems !== undefined && { portfolioItems: body.portfolioItems }),
      ...(body.sampleOutputUrl !== undefined && { sampleOutputUrl: body.sampleOutputUrl }),
      ...(body.moneyBackGuarantee !== undefined && { moneyBackGuarantee: body.moneyBackGuarantee }),
      ...(body.guaranteeTerms !== undefined && { guaranteeTerms: body.guaranteeTerms }),
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
      webhookSecret: process.env.BROADCAST_HMAC_SECRET,
      warning: 'Store both the apiKey and webhookSecret now — they will never be shown again.',
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
      // Service terms
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.skillLevel !== undefined && { skillLevel: body.skillLevel }),
      ...(body.pricingModel !== undefined && { pricingModel: body.pricingModel }),
      ...(body.basePrice !== undefined && { basePrice: body.basePrice }),
      ...(body.expressMultiplier !== undefined && { expressMultiplier: body.expressMultiplier }),
      ...(body.deliveryDays !== undefined && { deliveryDays: body.deliveryDays }),
      ...(body.expressDeliveryDays !== undefined && { expressDeliveryDays: body.expressDeliveryDays }),
      ...(body.maxFileSizeMb !== undefined && { maxFileSizeMb: body.maxFileSizeMb }),
      ...(body.outputFormats !== undefined && { outputFormats: body.outputFormats }),
      ...(body.inputRequirements !== undefined && { inputRequirements: body.inputRequirements }),
      ...(body.revisionsIncluded !== undefined && { revisionsIncluded: body.revisionsIncluded }),
      ...(body.pricePerExtraRevision !== undefined && { pricePerExtraRevision: body.pricePerExtraRevision }),
      ...(body.maxRevisionRounds !== undefined && { maxRevisionRounds: body.maxRevisionRounds }),
      ...(body.revisionWindowDays !== undefined && { revisionWindowDays: body.revisionWindowDays }),
      ...(body.revisionsPolicy !== undefined && { revisionsPolicy: body.revisionsPolicy }),
      ...(body.deliveryVariants !== undefined && { deliveryVariants: body.deliveryVariants }),
      ...(body.pricePerExtraVariant !== undefined && { pricePerExtraVariant: body.pricePerExtraVariant }),
      ...(body.maxDeliveryVariants !== undefined && { maxDeliveryVariants: body.maxDeliveryVariants }),
      ...(body.whatsIncluded !== undefined && { whatsIncluded: body.whatsIncluded }),
      ...(body.whatsNotIncluded !== undefined && { whatsNotIncluded: body.whatsNotIncluded }),
      ...(body.perfectFor !== undefined && { perfectFor: body.perfectFor }),
      ...(body.responseTimeSlaHours !== undefined && { responseTimeSlaHours: body.responseTimeSlaHours }),
      ...(body.maxConcurrentJobs !== undefined && { maxConcurrentJobs: body.maxConcurrentJobs }),
      ...(body.availabilityStatus !== undefined && { availabilityStatus: body.availabilityStatus }),
      ...(body.availableUntil !== undefined && { availableUntil: body.availableUntil ? new Date(body.availableUntil) : null }),
      ...(body.languagesSupported !== undefined && { languagesSupported: body.languagesSupported }),
      ...(body.portfolioItems !== undefined && { portfolioItems: body.portfolioItems }),
      ...(body.sampleOutputUrl !== undefined && { sampleOutputUrl: body.sampleOutputUrl }),
      ...(body.moneyBackGuarantee !== undefined && { moneyBackGuarantee: body.moneyBackGuarantee }),
      ...(body.guaranteeTerms !== undefined && { guaranteeTerms: body.guaranteeTerms }),
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
    webhookSecret: process.env.BROADCAST_HMAC_SECRET,
    warning: 'Store both the apiKey and webhookSecret now — they will never be shown again.',
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

// GET /api/agents — optional ?category=<slug>, ?search=<term>, ?sortBy=latest|rating|jobs filters
// search matches on agent name or category name (case-insensitive)
// sortBy=latest (default) sorts by createdAt desc, rating by avgRating desc, jobs by totalJobs desc
agents.get('/', async (c) => {
  const prisma = c.get('prisma')
  const category = c.req.query('category')
  const search = c.req.query('search')?.trim()
  const sortBy = c.req.query('sortBy') ?? 'latest'
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
  const offset = Number(c.req.query('offset') ?? 0)

  const orderBy =
    sortBy === 'rating'
      ? { avgRating: 'desc' as const }
      : sortBy === 'jobs'
        ? { totalJobs: 'desc' as const }
        : { createdAt: 'desc' as const }

  const agentProfiles = await prisma.agentProfile.findMany({
    where: {
      isActive: true,
      ...(category ? { categories: { some: { slug: category } } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { categories: { some: { name: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    },
    take: limit,
    skip: offset,
    orderBy,
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

// GET /api/agents/:slugOrId — lookup by slug (public pages) or UUID (dashboard)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

agents.get('/:slugOrId', async (c) => {
  const prisma = c.get('prisma')
  const param = c.req.param('slugOrId')

  const agentProfile = await prisma.agentProfile.findUnique({
    where: UUID_RE.test(param) ? { id: param } : { slug: param },
    select: agentProfileSelect,
  })

  if (!agentProfile) {
    return c.json({ error: 'Agent not found' }, 404)
  }

  c.header('Cache-Control', 'public, max-age=300, s-maxage=300')
  return c.json({ agentProfile })
})

export default agents
