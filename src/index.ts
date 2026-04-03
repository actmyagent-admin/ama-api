import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import type { ExecutionContext } from '@cloudflare/workers-types'
import { createPrisma } from './lib/prisma.js'
import { releaseEscrow } from './lib/escrow.js'
import type { Variables } from './types/index.js'

import usersRouter from './routes/users.js'
import agentsRouter from './routes/agents.js'
import jobsRouter from './routes/jobs.js'
import proposalsRouter from './routes/proposals.js'
import contractsRouter from './routes/contracts.js'
import paymentsRouter from './routes/payments.js'
import deliveriesRouter from './routes/deliveries.js'
import webhooksRouter from './routes/webhooks.js'
import contactRouter from './routes/contact.js'
import categoriesRouter from './routes/categories.js'
import messagesRouter from './routes/messages.js'
import agentErrorsRouter from './routes/agentErrors.js'
import adminRouter from './routes/admin.js'
import settingsRouter from './routes/settings.js'
import profileRouter from './routes/profile.js'
import stripeConnectRouter from './routes/stripeConnect.js'

type Bindings = {
  DATABASE_URL: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  ANTHROPIC_API_KEY: string
  FRONTEND_URL: string
  BROADCAST_HMAC_SECRET: string
  AWS_REGION: string
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  AWS_S3_BUCKET: string
  ADMIN_SECRET: string
  HYPERDRIVE?: { connectionString: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('*', logger())
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowed = [
        c.env.FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:3001',
      ].filter(Boolean) as string[]
      return allowed.includes(origin) ? origin : null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
)

// Create a fresh Prisma client per request using the Hyperdrive connection string.
// Hyperdrive caching is disabled via `wrangler hyperdrive update --caching-disabled`
// (dashboard toggle alone is not enough — must be set via CLI).
// Caching caused read-after-write failures: a null result for a new user's supabaseId
// lookup was cached for 60s across edge nodes, so GET /me returned 401 even after
// POST /register succeeded.
app.use('*', async (c, next) => {
  const connectionString = c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL
  c.set('prisma', createPrisma(connectionString))
  await next()
})

// Disable Cloudflare CDN caching for all API routes by default.
// Individual public listing endpoints (categories, agents) override this with their own headers.
app.use('/api/*', async (c, next) => {
  await next()
  if (!c.res.headers.get('Cache-Control')) {
    c.header('Cache-Control', 'no-store')
  }
})

app.route('/api/users', usersRouter)
app.route('/api/agents', agentsRouter)
app.route('/api/jobs', jobsRouter)
app.route('/api/proposals', proposalsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/payments', paymentsRouter)
app.route('/api/deliveries', deliveriesRouter)
app.route('/api/webhooks', webhooksRouter)
app.route('/api/contact', contactRouter)
app.route('/api/categories', categoriesRouter)
app.route('/api/messages', messagesRouter)
app.route('/api/agent-errors', agentErrorsRouter)
app.route('/api/admin', adminRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/profile', profileRouter)
app.route('/api/stripe/connect', stripeConnectRouter)

app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
)

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('[error]', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// ─── Scheduled handler — auto-approves overdue deliveries ───────────────────
// Runs on the cron schedule defined in wrangler.toml (every hour).
// Finds all SUBMITTED deliveries whose reviewDeadline has passed and releases escrow.
async function runAutoApprovals(env: Bindings): Promise<void> {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL
  const prisma = createPrisma(connectionString)

  try {
    const overdue = await prisma.delivery.findMany({
      where: {
        status: 'SUBMITTED',
        reviewDeadline: { lte: new Date() },
      },
      include: {
        contract: { include: { payment: true } },
      },
    })

    console.log(`[cron] Auto-approval check: ${overdue.length} overdue deliveries found`)

    for (const delivery of overdue) {
      const payment = delivery.contract.payment
      if (!payment || payment.status !== 'ESCROWED') {
        console.log(`[cron] Skipping delivery ${delivery.id} — payment not in escrow`)
        continue
      }

      try {
        await releaseEscrow(
          delivery.id,
          delivery.contractId,
          payment.id,
          payment.stripePaymentIntentId,
          prisma,
        )
        console.log(
          `[cron] Auto-approved delivery ${delivery.id} for contract ${delivery.contractId}`,
        )
      } catch (err) {
        console.error(`[cron] Failed to auto-approve delivery ${delivery.id}:`, err)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

export default {
  fetch(request: Request, env: Bindings) {
    // Set only string env vars so singleton libs (supabase, stripe, anthropic, s3) can read them.
    // Never use Object.assign(process.env, env) — that would corrupt non-string bindings
    // like HYPERDRIVE into "[object Object]", breaking pg pool initialization.
    process.env.SUPABASE_URL = env.SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
    process.env.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY
    process.env.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
    process.env.FRONTEND_URL = env.FRONTEND_URL
    process.env.BROADCAST_HMAC_SECRET = env.BROADCAST_HMAC_SECRET
    process.env.AWS_REGION = env.AWS_REGION
    process.env.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID
    process.env.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_S3_BUCKET = env.AWS_S3_BUCKET
    process.env.ADMIN_SECRET = env.ADMIN_SECRET
    return app.fetch(request, env)
  },

  async scheduled(_event: unknown, env: Bindings, ctx: ExecutionContext) {
    process.env.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY
    process.env.AWS_REGION = env.AWS_REGION
    process.env.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID
    process.env.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_S3_BUCKET = env.AWS_S3_BUCKET
    ctx.waitUntil(runAutoApprovals(env))
  },
}
