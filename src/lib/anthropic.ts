import Anthropic from "@anthropic-ai/sdk";
import type { Job, Proposal } from "@prisma/client";

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

export interface JobAnalysis {
  suggestedCategory: string;
  estimatedBudget: number | null;
  estimatedTimeline: string | null;
  keyDeliverables: string[];
}

export interface ContractContent {
  scope: string;
  deliverables: string;
  fullContractText: string;
}

export interface AiAuditMeta {
  model: string;
  inputPrompt: string;
  rawOutput: string;
  parsedOutputJson: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  status: "SUCCESS" | "PARSE_ERROR" | "API_ERROR";
  errorMessage: string | null;
}

const MODEL = "claude-sonnet-4-20250514";

export async function categorizeJob(
  description: string,
  budget?: number | null,
): Promise<{ result: JobAnalysis; audit: AiAuditMeta }> {
  const budgetLine = budget != null
    ? `- The buyer has provided a budget of $${budget} USD. Use this as estimatedBudget.`
    : `- estimatedBudget: estimate a reasonable number in USD based on the task, or null if impossible to estimate.`;

  const inputPrompt = `Given this task description: "${description}", extract:\n- suggestedCategory (one of: development, design, writing, video, data, marketing, legal, travel, other)\n${budgetLine}\n- estimatedTimeline (string like "3 days" or null)\n- keyDeliverables (array of strings)\nRespond in JSON only, no markdown.`;

  const startedAt = Date.now();
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: inputPrompt }],
  });
  const durationMs = Date.now() - startedAt;

  const rawOutput =
    message.content[0].type === "text" ? message.content[0].text : "";
  const inputTokens = message.usage?.input_tokens ?? null;
  const outputTokens = message.usage?.output_tokens ?? null;

  try {
    const parsed = JSON.parse(rawOutput) as JobAnalysis;
    return {
      result: parsed,
      audit: {
        model: MODEL,
        inputPrompt,
        rawOutput,
        parsedOutputJson: parsed,
        inputTokens,
        outputTokens,
        durationMs,
        status: "SUCCESS",
        errorMessage: null,
      },
    };
  } catch (err) {
    const fallback: JobAnalysis = {
      suggestedCategory: "other",
      estimatedBudget: null,
      estimatedTimeline: null,
      keyDeliverables: [],
    };
    return {
      result: fallback,
      audit: {
        model: MODEL,
        inputPrompt,
        rawOutput,
        parsedOutputJson: null,
        inputTokens,
        outputTokens,
        durationMs,
        status: "PARSE_ERROR",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function generateContract(
  job: Job,
  proposal: Proposal,
): Promise<{ result: ContractContent; audit: AiAuditMeta }> {
  const deadline = proposal.estimatedDays
    ? new Date(Date.now() + proposal.estimatedDays * 86400000)
        .toISOString()
        .split("T")[0]
    : "TBD";

  const inputPrompt = `Generate a plain English service contract for:\nJob: ${job.title} - ${job.description}\nAgreed price: ${proposal.price} ${proposal.currency}\nDeadline: ${deadline} (${proposal.estimatedDays} days)\nAgent proposal: ${proposal.message}\n\nInclude sections: Scope of Work, Deliverables, Payment Terms,\nRevision Policy (2 revisions), IP Ownership (buyer owns on payment),\nDispute Resolution. Keep it clear and under 400 words.\nRespond in JSON only (no markdown): { "scope": string, "deliverables": string, "fullContractText": string }`;

  const startedAt = Date.now();
  const message = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: inputPrompt }],
  });
  const durationMs = Date.now() - startedAt;

  const rawOutput =
    message.content[0].type === "text" ? message.content[0].text : "";
  const inputTokens = message.usage?.input_tokens ?? null;
  const outputTokens = message.usage?.output_tokens ?? null;

  try {
    const parsed = JSON.parse(rawOutput) as ContractContent;
    return {
      result: parsed,
      audit: {
        model: MODEL,
        inputPrompt,
        rawOutput,
        parsedOutputJson: parsed,
        inputTokens,
        outputTokens,
        durationMs,
        status: "SUCCESS",
        errorMessage: null,
      },
    };
  } catch (err) {
    const fallback: ContractContent = {
      scope: `Provide services for: ${job.title}`,
      deliverables: `Completed deliverable as described in the job posting`,
      fullContractText: `Service Agreement\n\nScope: ${job.title}\nPrice: ${proposal.price} ${proposal.currency}\nDeadline: ${deadline}\n\nBoth parties agree to the terms outlined in the proposal.`,
    };
    return {
      result: fallback,
      audit: {
        model: MODEL,
        inputPrompt,
        rawOutput,
        parsedOutputJson: null,
        inputTokens,
        outputTokens,
        durationMs,
        status: "PARSE_ERROR",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
