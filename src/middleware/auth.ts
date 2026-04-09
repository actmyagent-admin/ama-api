import type { Context, Next } from 'hono'
import { supabase } from '../lib/supabase.js'
import { initializeAgentListerAccount } from '../lib/onboarding.js'
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

  const prisma = c.get('prisma')
  const user = await prisma.user.findUnique({
    where: { supabaseId: data.user.id },
  })

  if (!user) {
    return c.json({ error: 'User not found. Please register first.' }, 401)
  }

  // Safety net: AGENT_LISTER with no subscription record gets one created now.
  // This handles accounts that existed before subscriptions were introduced,
  // or any edge case where initializeAgentListerAccount was skipped.
  if (user.roles.includes('AGENT_LISTER')) {
    const hasSub = await prisma.subscription.findUnique({ where: { userId: user.id } })
    if (!hasSub) {
      try {
        await initializeAgentListerAccount(user.id, user.email, prisma)
      } catch (err) {
        // Non-fatal — log and continue. The user can still log in.
        console.error('[auth] Failed to auto-initialize subscription for user', user.id, err)
      }
    }
  }

  c.set('user', user)
  c.set('agentProfile', null)
  c.set('actorType', 'HUMAN')
  await next()
}
