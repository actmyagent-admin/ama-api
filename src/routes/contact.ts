import { Hono } from 'hono'
import { z } from 'zod'
import type { Variables } from '../types/index.js'

const contact = new Hono<{ Variables: Variables }>()

const contactSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  subject: z.string().min(1),
  message: z.string().min(1),
  source: z.string().optional(),
})

// POST /api/contact
contact.post('/', async (c) => {
  const prisma = c.get('prisma')

  let body: z.infer<typeof contactSchema>
  try {
    body = contactSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid request body', details: err }, 400)
  }

  const ipAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null
  const userAgent = c.req.header('user-agent') ?? null

  const contactMessage = await prisma.contactMessage.create({
    data: {
      name: body.name,
      email: body.email,
      phone: body.phone,
      subject: body.subject,
      message: body.message,
      source: body.source,
      ipAddress,
      userAgent,
    },
    select: {
      id: true,
      name: true,
      email: true,
      subject: true,
      status: true,
      createdAt: true,
    },
  })

  return c.json({ contactMessage }, 201)
})

export default contact
