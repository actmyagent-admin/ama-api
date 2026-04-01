import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { categorizeJob } from "../lib/anthropic.js";
import { broadcastJob } from "../lib/broadcast.js";
import type { Variables } from "../types/index.js";

const jobs = new Hono<{ Variables: Variables }>();

const createJobSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(10),
  category: z.string().optional(),
  budget: z.number().positive().optional(),
  currency: z.string().default("USD"),
  deadline: z.string().datetime().optional(),
});

// POST /api/jobs
jobs.post("/", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only BUYER accounts can post jobs" }, 403);
  }

  let body: z.infer<typeof createJobSchema>;
  try {
    body = createJobSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  // Enhance with Anthropic analysis
  let analysis = {
    suggestedCategory: body.category ?? "other",
    estimatedBudget: null as number | null,
    estimatedTimeline: null as string | null,
    keyDeliverables: [] as string[],
  };
  let aiAuditMeta: Awaited<ReturnType<typeof categorizeJob>>["audit"] | null =
    null;
  let aiApiError: string | null = null;
  try {
    const aiResult = await categorizeJob(body.description);
    analysis = aiResult.result;
    aiAuditMeta = aiResult.audit;
  } catch (err) {
    console.error("[jobs] Anthropic categorization failed:", err);
    aiApiError = err instanceof Error ? err.message : String(err);
  }

  const job = await prisma.job.create({
    data: {
      buyerId: user.id,
      title: body.title,
      description: body.description,
      category: body.category ?? analysis.suggestedCategory,
      budget: body.budget ?? analysis.estimatedBudget ?? undefined,
      currency: body.currency,
      deadline: body.deadline ? new Date(body.deadline) : null,
    },
  });

  // Persist AI audit log — fire-and-forget, never block the response
  const auditPayload = aiAuditMeta ?? {
    model: "claude-sonnet-4-20250514",
    inputPrompt: body.description,
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
        type: "JOB_CATEGORIZATION",
        status: auditPayload.status,
        model: auditPayload.model,
        inputPrompt: auditPayload.inputPrompt,
        rawOutput: auditPayload.rawOutput,
        parsedOutputJson: auditPayload.parsedOutputJson ?? undefined,
        inputTokens: auditPayload.inputTokens,
        outputTokens: auditPayload.outputTokens,
        durationMs: auditPayload.durationMs,
        errorMessage: auditPayload.errorMessage,
        jobId: job.id,
        triggeredByUserId: user.id,
      },
    })
    .catch((err: unknown) => console.error("[jobs] Failed to save AI audit log:", err));

  let broadcastCount = 0;
  try {
    broadcastCount = await broadcastJob(job, prisma);
  } catch (err) {
    console.error("[jobs] Broadcast failed:", err);
  }

  return c.json({ job, broadcastCount, analysis }, 201);
});

// GET /api/jobs
jobs.get("/", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const category = c.req.query("category");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  if (user.roles.includes("BUYER")) {
    const jobList = await prisma.job.findMany({
      where: {
        buyerId: user.id,
        ...(category ? { category } : {}),
        ...(status ? { status: status as any } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    return c.json({ jobs: jobList, limit, offset });
  }

  // AGENT_LISTER: show all OPEN jobs in their categories
  const agentProfile = await prisma.agentProfile.findFirst({
    where: { userId: user.id },
    include: { categories: { select: { slug: true } } },
  });
  const categoryFilter = category
    ? { category }
    : agentProfile
      ? { category: { in: agentProfile.categories.map((c) => c.slug) } }
      : {};

  const jobList = await prisma.job.findMany({
    where: {
      status: "OPEN",
      ...categoryFilter,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      budget: true,
      currency: true,
      deadline: true,
      status: true,
      createdAt: true,
    },
  });

  return c.json({ jobs: jobList, limit, offset });
});

// GET /api/jobs/my — all jobs for the signed-in BUYER
jobs.get("/my", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only BUYER accounts can access their jobs" }, 403);
  }

  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  const jobList = await prisma.job.findMany({
    where: {
      buyerId: user.id,
      ...(status ? { status: status as any } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
    include: {
      proposals: {
        select: { id: true, status: true, price: true, currency: true, estimatedDays: true },
      },
      contract: {
        select: { id: true, status: true, price: true, currency: true, deadline: true },
      },
    },
  });

  return c.json({ jobs: jobList, limit, offset });
});

// GET /api/jobs/:id
jobs.get("/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      proposals: user.roles.includes("BUYER")
        ? { include: { agentProfile: true }, orderBy: { createdAt: "desc" } }
        : false,
    },
  });

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (user.roles.includes("BUYER") && job.buyerId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({ job });
});

export default jobs;
