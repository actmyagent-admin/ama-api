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
  // Access new fields via `as any` — Prisma TS cache may lag after migrations
  const p = proposal as any;
  const j = job as any;

  const deliveryDays: number = p.deliveryDays ?? proposal.estimatedDays ?? 7;
  const revisionsIncluded: number = p.revisionsIncluded ?? 2;
  const deliveryVariants: number = p.deliveryVariants ?? 1;
  const expressDelivery: boolean = p.expressRequested ?? false;
  // basePrice is in cents; fall back to proposal.price (already currency units)
  const agreedPrice: number = p.basePrice
    ? p.basePrice / 100
    : (proposal as any).price ?? 0;
  const currency: string = (proposal as any).currency ?? "USD";

  const deadline = new Date(Date.now() + deliveryDays * 86400000)
    .toISOString()
    .split("T")[0];

  // Build optional context lines only when data is present
  const lines: string[] = [
    `Job Title: ${job.title}`,
    `Job Description: ${job.description}`,
  ];
  if (j.briefDetail) lines.push(`Detailed Brief: ${j.briefDetail}`);
  if (j.preferredOutputFormats?.length) lines.push(`Preferred Output Formats: ${(j.preferredOutputFormats as string[]).join(", ")}`);
  if (j.requiredLanguage) lines.push(`Required Language: ${j.requiredLanguage}`);
  if (j.desiredDeliveryDays) lines.push(`Buyer Desired Delivery: ${j.desiredDeliveryDays} days`);
  lines.push(`Agent Proposal Message: ${proposal.message}`);
  if (p.scopeNotes) lines.push(`Agent Scope Notes: ${p.scopeNotes}`);
  if (p.questionsForBuyer) lines.push(`Agent Questions to Buyer: ${p.questionsForBuyer}`);
  if (p.buyerAnswers) lines.push(`Buyer Answers: ${p.buyerAnswers}`);
  lines.push(`Agreed Price: ${agreedPrice} ${currency}`);
  lines.push(`Delivery Deadline: ${deadline} (${deliveryDays} days)`);
  lines.push(`Revisions Included: ${revisionsIncluded}`);
  if (deliveryVariants > 1) lines.push(`Delivery Variants: ${deliveryVariants}`);
  if (expressDelivery) lines.push(`Express Delivery: Yes`);

  const inputPrompt = `Generate a plain English service contract for the following engagement:\n\n${lines.join("\n")}\n\nInclude these sections: Scope of Work, Deliverables, Payment Terms, Revision Policy (${revisionsIncluded} revision${revisionsIncluded !== 1 ? "s" : ""} included), IP Ownership (buyer owns all work upon payment), Dispute Resolution${expressDelivery ? ", Express Delivery Terms" : ""}. Keep it clear and under 500 words.\nRespond in JSON only (no markdown): { "scope": string, "deliverables": string, "fullContractText": string }`;

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
      fullContractText: `Service Agreement\n\nScope: ${job.title}\nPrice: ${agreedPrice} ${currency}\nDeadline: ${deadline} (${deliveryDays} days)\nRevisions: ${revisionsIncluded}\n\nBoth parties agree to the terms outlined in the proposal.`,
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
