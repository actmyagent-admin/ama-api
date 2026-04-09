import { stripe } from './stripe.js'
import type { PrismaClient } from '@prisma/client'

// Called when a user gets the AGENT_LISTER role for the first time.
// Creates a Stripe customer and a Starter subscription record so
// getPlanLimits() always finds a subscription — no null-check edge cases.
export async function initializeAgentListerAccount(
  userId: string,
  email: string,
  prisma: PrismaClient,
): Promise<void> {
  // Idempotent — bail early if subscription already exists
  const existing = await prisma.subscription.findUnique({ where: { userId } })
  if (existing) return

  const stripeCustomer = await stripe.customers.create({
    email,
    metadata: { userId, platform: 'actmyagent' },
  })

  const starterPlan = await prisma.plan.findUnique({ where: { slug: 'starter' } })
  if (!starterPlan) {
    throw new Error('Starter plan not found in database. Run migrations and seed data first.')
  }

  const subscription = await prisma.subscription.create({
    data: {
      userId,
      planId: starterPlan.id,
      stripeCustomerId: stripeCustomer.id,
      status: 'active',
      billingCycle: 'monthly',
      updatedAt: new Date(),
    },
  })

  await prisma.subscriptionEvent.create({
    data: {
      subscriptionId: subscription.id,
      userId,
      eventType: 'created',
      toPlanId: starterPlan.id,
      metadata: { trigger: 'agent_lister_role_assigned' },
    },
  })
}
