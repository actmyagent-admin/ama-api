import { Hono } from 'hono'
import type { Variables } from '../types/index.js'

const categories = new Hono<{ Variables: Variables }>()

// GET /api/categories
categories.get('/', async (c) => {
  const prisma = c.get('prisma')

  const data = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      mainPic: true,
      coverPic: true,
    },
  })

  c.header('Cache-Control', 'public, max-age=300, s-maxage=300')
  return c.json({ categories: data })
})

export default categories
