import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { supabase } from '../lib/supabase.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const users = new Hono<{ Variables: Variables }>()

// Generate a username from email prefix + random suffix
function generateUserName(email: string): string {
  const prefix = email
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toLowerCase()
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${suffix}`
}

async function uniqueUserName(email: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = generateUserName(email)
    const exists = await prisma.user.findUnique({ where: { userName: candidate } })
    if (!exists) return candidate
  }
  // Fallback: fully random
  return `user_${Math.random().toString(36).slice(2, 10)}`
}

const registerSchema = z.object({
  name: z.string().optional(),
})

// POST /api/users/register
// Called right after Supabase signup — creates the DB user record
users.post('/register', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.slice(7)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const existing = await prisma.user.findUnique({
    where: { supabaseId: data.user.id },
  })
  if (existing) {
    return c.json({ user: existing }, 200)
  }

  let body: z.infer<typeof registerSchema> = {}
  try {
    body = registerSchema.parse(await c.req.json())
  } catch {
    // Body is optional
  }

  const email = data.user.email!
  const userName = await uniqueUserName(email)

  const user = await prisma.user.create({
    data: {
      supabaseId: data.user.id,
      email,
      userName,
      name: body.name ?? null,
      roles: [],
    },
  })

  return c.json({ user }, 201)
})

// GET /api/users/me
users.get('/me', authMiddleware, async (c) => {
  const user = c.get('user')
  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    include: { agentProfile: { select: { id: true, name: true, isActive: true, isVerified: true } } },
  })
  return c.json({ user: profile })
})

const updateRoleSchema = z.object({
  role: z.enum(['BUYER', 'AGENT_LISTER']),
})

// POST /api/users/me/role — add a role (idempotent; one account can hold both)
users.post('/me/role', authMiddleware, async (c) => {
  const user = c.get('user')

  let body: z.infer<typeof updateRoleSchema>
  try {
    body = updateRoleSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  if (user.roles.includes(body.role)) {
    return c.json({ user }, 200)
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { roles: { push: body.role } },
  })

  return c.json({ user: updated })
})

const updateUsernameSchema = z.object({
  userName: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9_]+$/, 'Only lowercase letters, numbers, and underscores allowed'),
})

// PATCH /api/users/me/username
users.patch('/me/username', authMiddleware, async (c) => {
  const user = c.get('user')

  let body: z.infer<typeof updateUsernameSchema>
  try {
    body = updateUsernameSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const taken = await prisma.user.findUnique({ where: { userName: body.userName } })
  if (taken && taken.id !== user.id) {
    return c.json({ error: 'Username is already taken' }, 409)
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { userName: body.userName },
  })

  return c.json({ user: updated })
})

export default users
