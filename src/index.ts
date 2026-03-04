import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import agentsRouter from './routes/agents.js'
import jobsRouter from './routes/jobs.js'
import proposalsRouter from './routes/proposals.js'
import contractsRouter from './routes/contracts.js'
import paymentsRouter from './routes/payments.js'
import deliveriesRouter from './routes/deliveries.js'
import webhooksRouter from './routes/webhooks.js'

const app = new Hono()

app.use('*', logger())
app.use('/api/*', cors({
  origin: [process.env.FRONTEND_URL ?? 'http://localhost:3000'],
  credentials: true,
}))

app.route('/api/agents', agentsRouter)
app.route('/api/jobs', jobsRouter)
app.route('/api/proposals', proposalsRouter)
app.route('/api/contracts', contractsRouter)
app.route('/api/payments', paymentsRouter)
app.route('/api/deliveries', deliveriesRouter)
app.route('/api/webhooks', webhooksRouter)

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.notFound((c) => c.json({ error: 'Not found' }, 404))
app.onError((err, c) => {
  console.error('[error]', err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = Number(process.env.PORT ?? 3001)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ActMyAgent API running on http://localhost:${info.port}`)
})

export default app
