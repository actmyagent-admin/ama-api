import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const settings = new Hono<{ Variables: Variables }>()

const updateSettingsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  userName: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, and underscores allowed')
    .optional(),
  stripeAccountId: z.string().optional().nullable(),
  mainPic: z.string().url().optional().nullable(),
  coverPic: z.string().url().optional().nullable(),
  bioBrief: z.string().max(200).optional().nullable(),
  bioDetail: z.string().max(5000).optional().nullable(),
  instagram: z.string().url().optional().nullable(),
  facebook: z.string().url().optional().nullable(),
  x: z.string().url().optional().nullable(),
  discord: z.string().url().optional().nullable(),
})

const userSelect = {
  id: true,
  email: true,
  userName: true,
  name: true,
  mainPic: true,
  coverPic: true,
  bioBrief: true,
  bioDetail: true,
  instagram: true,
  facebook: true,
  x: true,
  discord: true,
  stripeAccountId: true,
  roles: true,
  createdAt: true,
  updatedAt: true,
} as const

// GET /api/settings — return current user's settings
settings.get('/', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: userSelect,
  })

  return c.json({ settings: profile })
})

async function applyUpdate(
  c: Parameters<Parameters<typeof settings.put>[1]>[0],
) {
  const user = c.get('user')
  const prisma = c.get('prisma')

  let body: z.infer<typeof updateSettingsSchema>
  try {
    body = updateSettingsSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  if (body.userName && body.userName !== user.userName) {
    const taken = await prisma.user.findUnique({ where: { userName: body.userName } })
    if (taken && taken.id !== user.id) {
      return c.json({ error: 'Username is already taken' }, 409)
    }
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.userName !== undefined && { userName: body.userName }),
      ...(body.stripeAccountId !== undefined && { stripeAccountId: body.stripeAccountId }),
      ...(body.mainPic !== undefined && { mainPic: body.mainPic }),
      ...(body.coverPic !== undefined && { coverPic: body.coverPic }),
      ...(body.bioBrief !== undefined && { bioBrief: body.bioBrief }),
      ...(body.bioDetail !== undefined && { bioDetail: body.bioDetail }),
      ...(body.instagram !== undefined && { instagram: body.instagram }),
      ...(body.facebook !== undefined && { facebook: body.facebook }),
      ...(body.x !== undefined && { x: body.x }),
      ...(body.discord !== undefined && { discord: body.discord }),
    },
    select: userSelect,
  })

  return c.json({ settings: updated })
}

// PUT /api/settings — full settings update
settings.put('/', authMiddleware, (c) => applyUpdate(c))

// POST /api/settings — same as PUT (upsert-style, idempotent update)
settings.post('/', authMiddleware, (c) => applyUpdate(c))

export default settings
