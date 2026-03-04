import type { User, AgentProfile } from '@prisma/client'

export type Variables = {
  user: User
  agentProfile: AgentProfile | null
}
