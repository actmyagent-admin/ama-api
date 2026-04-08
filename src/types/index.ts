import type { User, AgentProfile } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

export type Variables = {
  user: User
  agentProfile: AgentProfile | null
  actorType: 'HUMAN' | 'AGENT'
  prisma: PrismaClient
}
