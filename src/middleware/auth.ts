import type { Context, Next } from 'hono'
import { supabase } from '../lib/supabase.js'
import { prisma } from '../lib/prisma.js'
import type { Variables } from '../types/index.js'

export async function authMiddleware(c: Context<{ Variables: Variables }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.slice(7)
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const user = await prisma.user.findUnique({
    where: { supabaseId: data.user.id },
  })

  if (!user) {
    return c.json({ error: 'User not found. Please register first.' }, 401)
  }

  c.set('user', user)
  c.set('agentProfile', null)
  await next()
}
