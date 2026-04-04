import { Hono } from 'hono'
import { stripe } from '../lib/stripe.js'
import { authMiddleware } from '../middleware/auth.js'
import type { Variables } from '../types/index.js'

const stripeConnect = new Hono<{ Variables: Variables }>()

// GET /api/stripe/connect/status
// Returns live Stripe Connect account status for the authenticated AGENT_LISTER
stripeConnect.get('/status', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agent listers can access Stripe Connect' }, 403)
  }

  const connectAccount = await prisma.stripeConnectAccount.findUnique({
    where: { userId: user.id },
  })

  if (!connectAccount) {
    return c.json({
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      accountId: null,
    })
  }

  // Cross-check with Stripe for live status and sync any changes
  try {
    const account = await stripe.accounts.retrieve(connectAccount.stripeAccountId)

    const updated = await prisma.stripeConnectAccount.update({
      where: { id: connectAccount.id },
      data: {
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        lastVerifiedAt: new Date(),
      },
    })

    return c.json({
      connected: true,
      chargesEnabled: updated.chargesEnabled,
      payoutsEnabled: updated.payoutsEnabled,
      detailsSubmitted: updated.detailsSubmitted,
      accountId: connectAccount.stripeAccountId,
    })
  } catch (err) {
    console.error('[stripe-connect] Failed to retrieve account from Stripe:', err)
    // Return cached DB values if Stripe API is unreachable
    return c.json({
      connected: true,
      chargesEnabled: connectAccount.chargesEnabled,
      payoutsEnabled: connectAccount.payoutsEnabled,
      detailsSubmitted: connectAccount.detailsSubmitted,
      accountId: connectAccount.stripeAccountId,
    })
  }
})

// GET /api/stripe/connect/onboarding-url
// Creates or resumes Stripe Standard account onboarding and returns the hosted URL
stripeConnect.get('/onboarding-url', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agent listers can connect Stripe' }, 403)
  }

  const frontendUrl = process.env.FRONTEND_URL
  if (!frontendUrl) {
    console.error('[stripe-connect] FRONTEND_URL env var is not set')
    return c.json({ error: 'Server misconfiguration: FRONTEND_URL not set' }, 500)
  }

  try {
    let stripeAccountId: string

    const existing = await prisma.stripeConnectAccount.findUnique({
      where: { userId: user.id },
    })

    if (existing) {
      stripeAccountId = existing.stripeAccountId
    } else {
      // Create a new Standard Stripe connected account
      const account = await stripe.accounts.create({
        type: 'standard',
        email: user.email,
        metadata: { userId: user.id },
      })
      stripeAccountId = account.id

      await prisma.stripeConnectAccount.create({
        data: {
          userId: user.id,
          stripeAccountId: account.id,
          updatedAt: new Date(),
        },
      })

      // Mirror account ID onto User for quick lookups in existing payment flow
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountId: account.id },
      })
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${frontendUrl}/settings/payments?stripe=error&message=onboarding_expired`,
      return_url: `${frontendUrl}/settings/payments?stripe=success`,
      type: 'account_onboarding',
    })

    return c.json({ url: accountLink.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[stripe-connect] Failed to create onboarding URL:', err)
    return c.json({ error: 'Failed to create Stripe onboarding link', detail: message }, 500)
  }
})

// GET /api/stripe/connect/dashboard-url
// Returns a Stripe Express Dashboard login link for fully connected accounts
stripeConnect.get('/dashboard-url', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agent listers can access the Stripe dashboard' }, 403)
  }

  const connectAccount = await prisma.stripeConnectAccount.findUnique({
    where: { userId: user.id },
  })

  if (!connectAccount) {
    return c.json({ error: 'No Stripe account connected' }, 404)
  }

  try {
    const loginLink = await stripe.accounts.createLoginLink(connectAccount.stripeAccountId)
    return c.json({ url: loginLink.url })
  } catch (err) {
    console.error('[stripe-connect] Failed to create dashboard login link:', err)
    return c.json({ error: 'Failed to create Stripe dashboard link' }, 500)
  }
})

// DELETE /api/stripe/connect/disconnect
// Removes the Stripe Connect account and deactivates all agents for this user
stripeConnect.delete('/disconnect', authMiddleware, async (c) => {
  const user = c.get('user')
  const prisma = c.get('prisma')

  if (!user.roles.includes('AGENT_LISTER')) {
    return c.json({ error: 'Only agent listers can disconnect Stripe' }, 403)
  }

  const connectAccount = await prisma.stripeConnectAccount.findUnique({
    where: { userId: user.id },
  })

  if (!connectAccount) {
    return c.json({ error: 'No Stripe account connected' }, 404)
  }

  try {
    // Delete the StripeConnectAccount record and deactivate all agents atomically
    await prisma.$transaction([
      prisma.stripeConnectAccount.delete({
        where: { userId: user.id },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { stripeAccountId: null },
      }),
      prisma.agentProfile.updateMany({
        where: { userId: user.id },
        data: { isActive: false },
      }),
    ])

    console.log(
      `[stripe-connect] User ${user.id} disconnected Stripe account ${connectAccount.stripeAccountId}. Agents deactivated.`,
    )

    return c.json({ disconnected: true })
  } catch (err) {
    console.error('[stripe-connect] Failed to disconnect Stripe account:', err)
    return c.json({ error: 'Failed to disconnect Stripe account' }, 500)
  }
})

export default stripeConnect
