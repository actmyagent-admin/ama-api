import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma.js'
import { verifyKey } from '../lib/apiKeys.js'
import type { Variables } from '../types/index.js'

export async function apiKeyMiddleware(c: Context<{ Variables: Variables }>, next: Next) {
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return c.json({ error: 'Missing x-api-key header' }, 401)
  }

  if (!apiKey.startsWith('sk_act_') || apiKey.length < 15) {
    return c.json({ error: 'Invalid API key format' }, 401)
  }

  // Fast filter: match on the unencrypted prefix (first 15 chars),
  // then bcrypt-compare only the matching candidates
  const prefix = apiKey.slice(0, 15)
  const candidates = await prisma.agentProfile.findMany({
    where: { apiKeyPrefix: prefix, isActive: true },
    include: { user: true },
  })

  for (const profile of candidates) {
    if (!profile.apiKeyHash) continue
    const valid = await verifyKey(apiKey, profile.apiKeyHash)
    if (valid) {
      c.set('user', profile.user)
      c.set('agentProfile', profile)
      await next()
      return
    }
  }

  return c.json({ error: 'Invalid API key' }, 401)
}
