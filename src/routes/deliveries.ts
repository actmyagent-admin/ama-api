import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { combinedAuthMiddleware } from '../middleware/combinedAuth.js'
import { releaseEscrow } from '../lib/escrow.js'
import {
  generateUploadUrl,
  generateDownloadUrl,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
} from '../lib/s3.js'
import type { Variables } from '../types/index.js'

const deliveries = new Hono<{ Variables: Variables }>()

// ─── POST /api/deliveries/upload-url ────────────────────────────────────────
// Agent calls this once per file to get a presigned S3 upload URL.
// The browser then PUTs the file directly to S3 (no proxy through our API).
const uploadUrlSchema = z.object({
  contractId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string(),
  fileSize: z.number().int().positive(),
})

deliveries.post('/upload-url', combinedAuthMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agents can upload delivery files' }, 403)
  }

  let body: z.infer<typeof uploadUrlSchema>
  try {
    body = uploadUrlSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  if (body.fileSize > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: 'File too large. Maximum size is 100 MB' }, 400)
  }

  if (!ALLOWED_MIME_TYPES.has(body.mimeType)) {
    return c.json({ error: 'File type not allowed' }, 400)
  }

  // Verify user is the agent on this contract
  const contract = await prisma.contract.findFirst({
    where: {
      id: body.contractId,
      agentProfile: { userId: user.id },
      status: 'ACTIVE',
    },
  })
  if (!contract) return c.json({ error: 'Contract not found or not active' }, 404)

  // Build an organised, unguessable S3 key
  const ext = body.filename.split('.').pop() ?? 'bin'
  const key = `deliveries/${body.contractId}/${Date.now()}-${crypto.randomUUID()}.${ext}`

  const uploadUrl = await generateUploadUrl(key, body.mimeType, body.fileSize)

  return c.json({ uploadUrl, key })
})

// ─── POST /api/deliveries ────────────────────────────────────────────────────
// Agent calls this after ALL files have been uploaded to S3.
const submitDeliverySchema = z.object({
  contractId: z.string().uuid(),
  description: z.string().min(1),
  files: z
    .array(
      z.object({
        key: z.string().min(1),
        filename: z.string().min(1),
        size: z.number().int().positive(),
      }),
    )
    .min(1, 'At least one file is required'),
})

deliveries.post('/', combinedAuthMiddleware, async (c) => {
  const user = c.get('user')
  const actorType = c.get('actorType')
  const agentProfile = c.get('agentProfile')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agents can submit deliveries' }, 403)
  }

  let body: z.infer<typeof submitDeliverySchema>
  try {
    body = submitDeliverySchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const contract = await prisma.contract.findFirst({
    where: {
      id: body.contractId,
      agentProfile: { userId: user.id },
      status: 'ACTIVE',
    },
    include: { payment: true, delivery: true },
  })

  if (!contract) return c.json({ error: 'Contract not found or not active' }, 404)

  if (!contract.payment || contract.payment.status !== 'ESCROWED') {
    return c.json({ error: 'Payment must be in escrow before submitting delivery' }, 409)
  }

  if (contract.delivery) {
    return c.json({ error: 'Delivery already submitted for this contract' }, 409)
  }

  const now = new Date()
  const reviewDeadline = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000) // +5 days

  const delivery = await prisma.delivery.create({
    data: {
      contractId: body.contractId,
      actorType,
      // AGENT: profile is in context from API key auth
      // HUMAN: derive from the contract (human acts on behalf of their agent profile)
      agentProfileId: actorType === 'AGENT' ? agentProfile?.id : contract.agentProfileId,
      description: body.description,
      fileKeys: body.files.map((f) => f.key),
      fileNames: body.files.map((f) => f.filename),
      fileSizes: body.files.map((f) => f.size),
      status: 'SUBMITTED',
      reviewDeadline,
    },
  })

  // Record the auto-release deadline on the contract for the cron to query
  await prisma.contract.update({
    where: { id: body.contractId },
    data: { autoReleaseAt: reviewDeadline },
  })

  console.log(
    `[deliveries] Delivery ${delivery.id} submitted for contract ${body.contractId}. ` +
      `Auto-approval at ${reviewDeadline.toISOString()}. Buyer should be notified.`,
  )

  return c.json({ delivery }, 201)
})

// ─── GET /api/deliveries/:contractId/files ───────────────────────────────────
// Returns temporary signed download URLs — never exposes raw S3 keys.
deliveries.get('/:contractId/files', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const { contractId } = c.req.param()

  const delivery = await prisma.delivery.findFirst({
    where: {
      contractId,
      contract: {
        OR: [{ buyerId: user.id }, { agentProfile: { userId: user.id } }],
      },
    },
  })

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404)

  const files = await Promise.all(
    delivery.fileKeys.map(async (key, i) => ({
      url: await generateDownloadUrl(key, delivery.fileNames[i]),
      filename: delivery.fileNames[i],
      size: delivery.fileSizes[i],
    })),
  )

  return c.json({ files })
})

// ─── POST /api/deliveries/:id/approve ───────────────────────────────────────
// Buyer approves delivery → escrow is released to agent.
deliveries.post('/:id/approve', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only buyers can approve deliveries' }, 403)
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { contract: { include: { payment: true } } },
  })

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404)
  if (delivery.contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (delivery.status !== 'SUBMITTED') {
    return c.json({ error: 'Delivery is not in SUBMITTED state' }, 409)
  }

  const payment = delivery.contract.payment
  if (!payment || payment.status !== 'ESCROWED') {
    return c.json({ error: 'Payment is not in escrow' }, 409)
  }

  try {
    await releaseEscrow(
      delivery.id,
      delivery.contractId,
      payment.id,
      payment.stripePaymentIntentId,
      prisma,
    )
  } catch (err) {
    console.error('[deliveries] Escrow release failed:', err)
    return c.json({ error: 'Payment release failed. Please contact support.' }, 500)
  }

  // Clear the auto-release deadline (buyer responded in time)
  await prisma.contract.update({
    where: { id: delivery.contractId },
    data: { autoReleaseAt: null },
  })

  console.log(`[deliveries] Delivery ${id} approved. Escrow released to agent.`)
  return c.json({ message: 'Delivery approved and payment released to agent.' })
})

// ─── POST /api/deliveries/:id/dispute ───────────────────────────────────────
// Buyer disputes delivery — freezes auto-approval, flags for admin review.
const disputeSchema = z.object({
  reason: z.string().min(10, 'Please provide a detailed reason for the dispute'),
})

deliveries.post('/:id/dispute', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')
  const id = c.req.param('id')

  if (!user.roles.includes('BUYER')) {
    return c.json({ error: 'Only buyers can dispute deliveries' }, 403)
  }

  let body: z.infer<typeof disputeSchema>
  try {
    body = disputeSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { contract: true },
  })

  if (!delivery) return c.json({ error: 'Delivery not found' }, 404)
  if (delivery.contract.buyerId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (delivery.status !== 'SUBMITTED') {
    return c.json({ error: 'Delivery is not in SUBMITTED state' }, 409)
  }

  await prisma.$transaction([
    prisma.delivery.update({
      where: { id },
      data: {
        status: 'DISPUTED',
        disputedAt: new Date(),
        disputeReason: body.reason,
      },
    }),
    prisma.contract.update({
      where: { id: delivery.contractId },
      // Clear auto-release — dispute freezes the clock
      data: { status: 'DISPUTED', autoReleaseAt: null },
    }),
  ])

  console.log(
    `[deliveries] Delivery ${id} disputed. Reason: ${body.reason}. Admin notified.`,
  )

  return c.json({
    message: 'Dispute opened. Our team will review within 2 business days.',
  })
})

export default deliveries
