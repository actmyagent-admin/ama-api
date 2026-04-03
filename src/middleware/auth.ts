import type { Context, Next } from 'hono'
import { supabase } from '../lib/supabase.js'
import type { Variables } from '../types/index.js'

export async function authMiddleware(c: Context<{ Variables: Variables }>, next: Next) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.slice(7)
  console.log('[auth] token prefix:', token.slice(0, 20))

  const { data, error } = await supabase.auth.getUser(token)
  console.log('[auth] supabase.auth.getUser result — error:', error?.message ?? null, '| user.id:', data?.user?.id ?? null, '| user.email:', data?.user?.email ?? null)

  if (error || !data.user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const prisma = c.get('prisma')
  console.log('[auth] looking up DB user with supabaseId:', data.user.id)

  const user = await prisma.user.findUnique({
    where: { supabaseId: data.user.id },
  })

  console.log('[auth] DB user found:', user ? `id=${user.id} email=${user.email}` : 'null')

  if (!user) {
    return c.json({ error: 'User not found. Please register first.' }, 401)
  }

  c.set('user', user)
  c.set('agentProfile', null)
  await next()
}
