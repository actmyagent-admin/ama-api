import Anthropic from '@anthropic-ai/sdk'
import type { Job, Proposal } from '@prisma/client'

let _client: Anthropic | undefined

function getClient(): Anthropic {
  return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
}

export interface JobAnalysis {
  suggestedCategory: string
  estimatedBudget: number | null
  estimatedTimeline: string | null
  keyDeliverables: string[]
}

export interface ContractContent {
  scope: string
  deliverables: string
  fullContractText: string
}

export async function categorizeJob(description: string): Promise<JobAnalysis> {
  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `Given this task description: "${description}", extract:
- suggestedCategory (one of: development, design, writing, video, data, marketing, legal, travel, other)
- estimatedBudget (number in USD or null)
- estimatedTimeline (string like "3 days" or null)
- keyDeliverables (array of strings)
Respond in JSON only, no markdown.`,
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  try {
    return JSON.parse(text) as JobAnalysis
  } catch {
    return {
      suggestedCategory: 'other',
      estimatedBudget: null,
      estimatedTimeline: null,
      keyDeliverables: [],
    }
  }
}

export async function generateContract(
  job: Job,
  proposal: Proposal
): Promise<ContractContent> {
  const deadline = proposal.estimatedDays
    ? new Date(Date.now() + proposal.estimatedDays * 86400000).toISOString().split('T')[0]
    : 'TBD'

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: `Generate a plain English service contract for:
Job: ${job.title} - ${job.description}
Agreed price: ${proposal.price} ${proposal.currency}
Deadline: ${deadline} (${proposal.estimatedDays} days)
Agent proposal: ${proposal.message}

Include sections: Scope of Work, Deliverables, Payment Terms,
Revision Policy (2 revisions), IP Ownership (buyer owns on payment),
Dispute Resolution. Keep it clear and under 400 words.
Respond in JSON only (no markdown): { "scope": string, "deliverables": string, "fullContractText": string }`,
      },
    ],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}'
  try {
    return JSON.parse(text) as ContractContent
  } catch {
    return {
      scope: `Provide services for: ${job.title}`,
      deliverables: `Completed deliverable as described in the job posting`,
      fullContractText: `Service Agreement\n\nScope: ${job.title}\nPrice: ${proposal.price} ${proposal.currency}\nDeadline: ${deadline}\n\nBoth parties agree to the terms outlined in the proposal.`,
    }
  }
}
