import type { PrismaClient } from '@prisma/client'

export interface PlanLimits {
  maxAgentListings: number // -1 = unlimited
  canAccessAnalytics: boolean
  hasPrioritySupport: boolean
  hasCustomBranding: boolean
  broadcastPriority: number
  isActive: boolean // false if past_due, canceled, unpaid
}

export async function getPlanLimits(userId: string, prisma: PrismaClient): Promise<PlanLimits> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  })

  if (!subscription) {
    // No subscription = Starter (free tier)
    const starterPlan = await prisma.plan.findUnique({ where: { slug: 'starter' } })
    return {
      maxAgentListings: starterPlan!.maxAgentListings,
      canAccessAnalytics: false,
      hasPrioritySupport: false,
      hasCustomBranding: false,
      broadcastPriority: 0,
      isActive: true,
    }
  }

  const isActive = ['active', 'trialing'].includes(subscription.status)

  return {
    maxAgentListings: subscription.customMaxAgentListings ?? subscription.plan.maxAgentListings,
    canAccessAnalytics: subscription.plan.canAccessAnalytics && isActive,
    hasPrioritySupport: subscription.plan.hasPrioritySupport && isActive,
    hasCustomBranding: subscription.plan.hasCustomBranding && isActive,
    broadcastPriority: isActive ? subscription.plan.broadcastPriority : 0,
    isActive,
  }
}

export async function canCreateAgentListing(
  userId: string,
  prisma: PrismaClient,
): Promise<{
  allowed: boolean
  currentCount: number
  limit: number
  reason?: string
}> {
  const limits = await getPlanLimits(userId, prisma)

  if (!limits.isActive) {
    return {
      allowed: false,
      currentCount: 0,
      limit: 0,
      reason: 'Your subscription is inactive. Please update your billing details.',
    }
  }

  const currentCount = await prisma.agentProfile.count({
    where: { userId, isDeleted: false },
  })

  if (limits.maxAgentListings === -1) {
    return { allowed: true, currentCount, limit: -1 }
  }

  if (currentCount >= limits.maxAgentListings) {
    return {
      allowed: false,
      currentCount,
      limit: limits.maxAgentListings,
      reason: `Your plan allows up to ${limits.maxAgentListings} agent listing${limits.maxAgentListings === 1 ? '' : 's'}. Upgrade to add more.`,
    }
  }

  return { allowed: true, currentCount, limit: limits.maxAgentListings }
}
