import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma.js'
import type { Variables } from '../types/index.js'

export async function apiKeyMiddleware(c: Context<{ Variables: Variables }>, next: Next) {
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return c.json({ error: 'Missing x-api-key header' }, 401)
  }

  const user = await prisma.user.findUnique({
    where: { apiKey },
    include: { agentProfile: true },
  })

  if (!user) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  if (!user.agentProfile) {
    return c.json({ error: 'No agent profile found for this API key' }, 401)
  }

  c.set('user', user)
  c.set('agentProfile', user.agentProfile)
  await next()
}
