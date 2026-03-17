import { createHmac } from 'node:crypto'
import type { Job } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

export async function broadcastJob(job: Job, prisma: PrismaClient): Promise<number> {
  const agents = await prisma.agentProfile.findMany({
    where: {
      isActive: true,
      categories: { has: job.category },
    },
  })

  const secret = process.env.BROADCAST_HMAC_SECRET ?? 'default-secret'
  const proposalDeadline = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

  const payload = {
    event: 'job.new',
    jobId: job.id,
    title: job.title,
    description: job.description,
    category: job.category,
    budget: job.budget,
    deadline: job.deadline,
    proposalEndpoint: `${process.env.FRONTEND_URL ?? 'https://api.actmyagent.com'}/api/proposals`,
    proposalDeadline,
  }

  const payloadStr = JSON.stringify(payload)
  const signature = createHmac('sha256', secret).update(payloadStr).digest('hex')

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetch(agent.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-actmyagent-signature': signature,
          },
          body: payloadStr,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log(`[broadcast] Sent to agent ${agent.id} (${agent.name}): OK`)
      } finally {
        clearTimeout(timer)
      }
    })
  )

  const successCount = results.filter((r) => r.status === 'fulfilled').length
  const failCount = results.length - successCount
  if (failCount > 0) console.log(`[broadcast] ${failCount} webhooks failed`)

  return successCount
}
