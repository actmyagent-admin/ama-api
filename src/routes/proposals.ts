import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { apiKeyMiddleware } from "../middleware/apiKey.js";
import { generateContract } from "../lib/anthropic.js";
import type { AiAuditMeta } from "../lib/anthropic.js";
import type { Variables } from "../types/index.js";

const proposals = new Hono<{ Variables: Variables }>();

const createProposalSchema = z.object({
  jobId: z.string().uuid(),
  message: z.string().min(10),
  price: z.number().positive(),
  currency: z.string().default("USD"),
  estimatedDays: z.number().int().positive(),
});

// POST /api/proposals — accepts JWT or API key auth
proposals.post(
  "/",
  async (c, next) => {
    const hasApiKey = c.req.header("x-api-key");
    if (hasApiKey) {
      return apiKeyMiddleware(c, next);
    }
    return authMiddleware(c, next);
  },
  async (c) => {
    const user = c.get("user");
    const prisma = c.get("prisma");

    if (!user.roles.includes("AGENT_LISTER")) {
      return c.json(
        { error: "Only AGENT_LISTER accounts can submit proposals" },
        403,
      );
    }

    let body: z.infer<typeof createProposalSchema>;
    try {
      body = createProposalSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: "Invalid request body", details: err }, 400);
    }

    const job = await prisma.job.findUnique({ where: { id: body.jobId } });
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.status !== "OPEN")
      return c.json({ error: "Job is not open for proposals" }, 409);

    const agentProfile = await prisma.agentProfile.findUnique({
      where: { userId: user.id },
    });
    if (!agentProfile) return c.json({ error: "Agent profile not found" }, 404);

    const existing = await prisma.proposal.findFirst({
      where: { jobId: body.jobId, agentProfileId: agentProfile.id },
    });
    if (existing)
      return c.json(
        { error: "You already submitted a proposal for this job" },
        409,
      );

    const proposal = await prisma.proposal.create({
      data: {
        jobId: body.jobId,
        agentProfileId: agentProfile.id,
        message: body.message,
        price: body.price,
        currency: body.currency,
        estimatedDays: body.estimatedDays,
      },
    });

    console.log(
      `[proposals] New proposal ${proposal.id} for job ${body.jobId}. Buyer should be notified.`,
    );

    return c.json({ proposal }, 201);
  },
);

// GET /api/proposals/job/:jobId
proposals.get("/job/:jobId", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const jobId = c.req.param("jobId");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can view proposals" }, 403);
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  const proposalList = await prisma.proposal.findMany({
    where: { jobId },
    include: { agentProfile: true },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ proposals: proposalList });
});

// POST /api/proposals/:id/accept
proposals.post("/:id/accept", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can accept proposals" }, 403);
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id },
    include: { job: true },
  });

  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  if (proposal.job.buyerId !== user.id)
    return c.json({ error: "Forbidden" }, 403);
  if (proposal.job.status !== "OPEN")
    return c.json({ error: "Job is not open" }, 409);
  if (proposal.status !== "PENDING")
    return c.json({ error: "Proposal is not pending" }, 409);

  // Generate contract via Anthropic
  let contractContent = {
    scope: `Provide services for: ${proposal.job.title}`,
    deliverables: "Completed deliverable as described in the job posting",
    fullContractText: "",
  };
  let aiAuditMeta: AiAuditMeta | null = null;
  let aiApiError: string | null = null;
  try {
    const aiResult = await generateContract(proposal.job, proposal);
    contractContent = aiResult.result;
    aiAuditMeta = aiResult.audit;
  } catch (err) {
    console.error("[proposals] Contract generation failed:", err);
    aiApiError = err instanceof Error ? err.message : String(err);
  }

  const deadline = new Date(Date.now() + proposal.estimatedDays * 86400000);

  // Transaction: reject others, accept this, create contract, update job
  const [, contract] = await prisma.$transaction([
    prisma.proposal.updateMany({
      where: { jobId: proposal.jobId, id: { not: id } },
      data: { status: "REJECTED" },
    }),
    prisma.contract.create({
      data: {
        jobId: proposal.jobId,
        proposalId: proposal.id,
        buyerId: user.id,
        agentProfileId: proposal.agentProfileId,
        scope: contractContent.scope,
        deliverables: contractContent.deliverables,
        price: proposal.price,
        currency: proposal.currency,
        deadline,
      },
      include: { proposal: true, job: true },
    }),
    prisma.proposal.update({ where: { id }, data: { status: "ACCEPTED" } }),
    prisma.job.update({
      where: { id: proposal.jobId },
      data: { status: "IN_PROGRESS" },
    }),
  ]);

  // Persist AI audit log — fire-and-forget, never block the response
  const auditPayload = aiAuditMeta ?? {
    model: "claude-sonnet-4-20250514",
    inputPrompt: `Job: ${proposal.job.title}`,
    rawOutput: "",
    parsedOutputJson: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    status: "API_ERROR" as const,
    errorMessage: aiApiError,
  };
  prisma.aiAuditLog
    .create({
      data: {
        type: "CONTRACT_GENERATION",
        status: auditPayload.status,
        model: auditPayload.model,
        inputPrompt: auditPayload.inputPrompt,
        rawOutput: auditPayload.rawOutput,
        parsedOutputJson: auditPayload.parsedOutputJson ?? undefined,
        inputTokens: auditPayload.inputTokens,
        outputTokens: auditPayload.outputTokens,
        durationMs: auditPayload.durationMs,
        errorMessage: auditPayload.errorMessage,
        jobId: proposal.jobId,
        proposalId: proposal.id,
        contractId: contract.id,
        triggeredByUserId: user.id,
      },
    })
    .catch((err: unknown) =>
      console.error("[proposals] Failed to save AI audit log:", err),
    );

  return c.json(
    { contract, fullContractText: contractContent.fullContractText },
    201,
  );
});

export default proposals;
