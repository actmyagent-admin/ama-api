import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { combinedAuthMiddleware } from "../middleware/combinedAuth.js";
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
  combinedAuthMiddleware,
  async (c) => {
    const user = c.get("user");
    const actorType = c.get("actorType");
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

    // For AGENT auth the profile is already in context; for HUMAN look it up by userId
    const agentProfile =
      actorType === "AGENT"
        ? c.get("agentProfile")
        : await prisma.agentProfile.findFirst({ where: { userId: user.id } });

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
        actorType,
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

// GET /api/proposals/agent/:agentProfileId
// Returns all proposals sent from a specific agent profile.
// Only the owner of that agent profile can access this.
proposals.get("/agent/:agentProfileId", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const agentProfileId = c.req.param("agentProfileId");

  const agentProfile = await prisma.agentProfile.findUnique({
    where: { id: agentProfileId },
  });

  if (!agentProfile) return c.json({ error: "Agent profile not found" }, 404);
  if (agentProfile.userId !== user.id) return c.json({ error: "Forbidden" }, 403);

  const proposals = await prisma.proposal.findMany({
    where: { agentProfileId },
    select: {
      id: true,
      jobId: true,
      agentProfileId: true,
      message: true,
      price: true,
      currency: true,
      estimatedDays: true,
      status: true,
      isActive: true,
      createdAt: true,
      job: {
        select: {
          id: true,
          title: true,
          description: true,
          category: true,
          budget: true,
          currency: true,
          status: true,
          deadline: true,
        },
      },
      contract: {
        select: {
          id: true,
          status: true,
          scope: true,
          deliverables: true,
          price: true,
          currency: true,
          deadline: true,
          buyerSignedAt: true,
          agentSignedAt: true,
          bothSignedAt: true,
          paymentDeadline: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ proposals });
});

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

  const proposals = await prisma.proposal.findMany({
    where: { jobId },
    select: {
      id: true,
      jobId: true,
      agentProfileId: true,
      message: true,
      price: true,
      currency: true,
      estimatedDays: true,
      status: true,
      isActive: true,
      createdAt: true,
      agentProfile: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ proposals });
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

// POST /api/proposals/:id/reject
proposals.post("/:id/reject", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can reject proposals" }, 403);
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id },
    include: { job: true },
  });

  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  if (proposal.job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);
  if (proposal.status !== "PENDING") {
    return c.json({ error: `Proposal is already ${proposal.status.toLowerCase()}` }, 409);
  }

  const updated = await prisma.proposal.update({
    where: { id },
    data: { status: "REJECTED" },
  });

  return c.json({ proposal: updated });
});

export default proposals;
