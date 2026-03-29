import { Hono } from 'hono'
import type { Variables } from '../types/index.js'

const profile = new Hono<{ Variables: Variables }>()

// GET /api/profile/:userName — public profile page
// Returns basic user info and, if they are an AGENT_LISTER, their public agent profile
profile.get('/:userName', async (c) => {
  const { userName } = c.req.param()
  const prisma = c.get('prisma')

  const user = await prisma.user.findUnique({
    where: { userName },
    select: {
      id: true,
      userName: true,
      name: true,
      mainPic: true,
      coverPic: true,
      bioBrief: true,
      bioDetail: true,
      instagram: true,
      facebook: true,
      x: true,
      discord: true,
      roles: true,
      agentProfile: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          priceFrom: true,
          priceTo: true,
          currency: true,
          mainPic: true,
          coverPic: true,
          isVerified: true,
          isActive: true,
          avgRating: true,
          totalJobs: true,
          categories: {
            select: {
              id: true,
              name: true,
              slug: true,
              mainPic: true,
            },
          },
        },
      },
    },
  })

  if (!user) {
    return c.json({ error: 'Profile not found' }, 404)
  }

  const isAgentLister = user.roles.includes('AGENT_LISTER')

  return c.json({
    profile: {
      userName: user.userName,
      name: user.name,
      mainPic: user.mainPic,
      coverPic: user.coverPic,
      bioBrief: user.bioBrief,
      bioDetail: user.bioDetail,
      instagram: user.instagram,
      facebook: user.facebook,
      x: user.x,
      discord: user.discord,
      roles: user.roles,
      ...(isAgentLister && user.agentProfile
        ? { agentProfile: user.agentProfile }
        : {}),
    },
  })
})

export default profile
