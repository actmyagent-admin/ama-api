import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { categorizeJob } from "../lib/anthropic.js";
import { broadcastJob } from "../lib/broadcast.js";
import {
  generateUploadUrl,
  generateDownloadUrl,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
} from "../lib/s3.js";
import type { Variables } from "../types/index.js";

const jobs = new Hono<{ Variables: Variables }>();

const createJobSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(10),
  category: z.string().optional(),
  budget: z.number().positive().optional(),
  currency: z.string().default("USD"),
  deadline: z.string().datetime().optional(),

  // Scope clarity
  briefDetail: z.string().optional(),
  attachmentKeys: z.array(z.string()).optional(),
  attachmentNames: z.array(z.string()).optional(),
  exampleUrls: z.array(z.string().url()).optional(),

  // Delivery preferences
  desiredDeliveryDays: z.number().int().positive().optional(),
  expressRequested: z.boolean().optional(),
  preferredOutputFormats: z.array(z.string()).optional(),

  // Proposal settings
  proposalDeadlineHours: z.number().int().positive().optional(),
  maxProposals: z.number().int().positive().nullable().optional(),

  // Buyer preferences
  preferHuman: z.boolean().optional(),
  budgetFlexible: z.boolean().optional(),
  requiredLanguage: z.string().nullable().optional(),
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
    const aiResult = await categorizeJob(body.description, body.budget);
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
      // Scope clarity
      ...(body.briefDetail !== undefined && { briefDetail: body.briefDetail }),
      ...(body.attachmentKeys !== undefined && { attachmentKeys: body.attachmentKeys }),
      ...(body.attachmentNames !== undefined && { attachmentNames: body.attachmentNames }),
      ...(body.exampleUrls !== undefined && { exampleUrls: body.exampleUrls }),
      // Delivery preferences
      ...(body.desiredDeliveryDays !== undefined && { desiredDeliveryDays: body.desiredDeliveryDays }),
      ...(body.expressRequested !== undefined && { expressRequested: body.expressRequested }),
      ...(body.preferredOutputFormats !== undefined && { preferredOutputFormats: body.preferredOutputFormats }),
      // Proposal settings
      ...(body.proposalDeadlineHours !== undefined && { proposalDeadlineHours: body.proposalDeadlineHours }),
      ...(body.maxProposals !== undefined && { maxProposals: body.maxProposals }),
      // Buyer preferences
      ...(body.preferHuman !== undefined && { preferHuman: body.preferHuman }),
      ...(body.budgetFlexible !== undefined && { budgetFlexible: body.budgetFlexible }),
      ...(body.requiredLanguage !== undefined && { requiredLanguage: body.requiredLanguage }),
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

// ─── POST /api/jobs/upload-url ───────────────────────────────────────────────
// Buyer gets a presigned S3 PUT URL for one attachment file.
// Call once per file, then PUT the raw bytes directly to the returned uploadUrl.
// After all uploads complete, include the returned keys in POST /api/jobs (attachmentKeys/Names)
// or patch an existing job via PATCH /api/jobs/:id.
const jobUploadUrlSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string(),
  fileSize: z.number().int().positive(),
  // Optional: scope the key to an existing job for organised storage
  jobId: z.string().uuid().optional(),
});

jobs.post("/upload-url", authMiddleware, async (c) => {
  const user = c.get("user");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can upload job attachments" }, 403);
  }

  let body: z.infer<typeof jobUploadUrlSchema>;
  try {
    body = jobUploadUrlSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  if (body.fileSize > MAX_FILE_SIZE_BYTES) {
    return c.json({ error: "File too large. Maximum size is 100 MB" }, 400);
  }

  if (!ALLOWED_MIME_TYPES.has(body.mimeType)) {
    return c.json({ error: "File type not allowed" }, 400);
  }

  const ext = body.filename.split(".").pop() ?? "bin";
  const scope = body.jobId ?? `tmp/${user.id}`;
  const key = `jobs/${scope}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const uploadUrl = await generateUploadUrl(key, body.mimeType);

  return c.json({ uploadUrl, key, filename: body.filename });
});

// ─── GET /api/jobs/:id/attachments ──────────────────────────────────────────
// Returns presigned download URLs for all files attached to a job.
// Accessible by the buyer who owns the job, and by any agent with an active contract on it.
jobs.get("/:id/attachments", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      buyerId: true,
      attachmentKeys: true,
      attachmentNames: true,
      contract: {
        select: {
          agentProfile: { select: { userId: true } },
        },
      },
    },
  });

  if (!job) return c.json({ error: "Job not found" }, 404);

  const isBuyer = job.buyerId === user.id;
  const isAssignedAgent = job.contract?.agentProfile?.userId === user.id;

  if (!isBuyer && !isAssignedAgent) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const keys = job.attachmentKeys as string[];
  const names = job.attachmentNames as string[];

  if (!keys.length) {
    return c.json({ attachments: [] });
  }

  const attachments = await Promise.all(
    keys.map(async (key, i) => ({
      url: await generateDownloadUrl(key, names[i]),
      filename: names[i] ?? key.split("/").pop(),
      key,
    }))
  );

  return c.json({ attachments });
});

// ─── PATCH /api/jobs/:id ─────────────────────────────────────────────────────
// Buyer updates a job's attachment list (or other mutable fields) after creation.
const updateJobSchema = z.object({
  briefDetail: z.string().nullable().optional(),
  attachmentKeys: z.array(z.string()).optional(),
  attachmentNames: z.array(z.string()).optional(),
  exampleUrls: z.array(z.string().url()).optional(),
  desiredDeliveryDays: z.number().int().positive().nullable().optional(),
  expressRequested: z.boolean().optional(),
  preferredOutputFormats: z.array(z.string()).optional(),
  budgetFlexible: z.boolean().optional(),
  requiredLanguage: z.string().nullable().optional(),
});

jobs.patch("/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can update jobs" }, 403);
  }

  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);
  if (job.status !== "OPEN") {
    return c.json({ error: "Only OPEN jobs can be updated" }, 409);
  }

  let body: z.infer<typeof updateJobSchema>;
  try {
    body = updateJobSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  // attachmentKeys and attachmentNames must be updated together
  if (
    (body.attachmentKeys !== undefined) !== (body.attachmentNames !== undefined)
  ) {
    return c.json(
      { error: "attachmentKeys and attachmentNames must be updated together" },
      400
    );
  }

  // Build update payload explicitly — avoids TS losing the union type through conditional spreads
  const updateData: Record<string, unknown> = {}
  if (body.briefDetail !== undefined)           updateData.briefDetail = body.briefDetail
  if (body.attachmentKeys !== undefined)        updateData.attachmentKeys = body.attachmentKeys
  if (body.attachmentNames !== undefined)       updateData.attachmentNames = body.attachmentNames
  if (body.exampleUrls !== undefined)           updateData.exampleUrls = body.exampleUrls
  if (body.desiredDeliveryDays !== undefined)   updateData.desiredDeliveryDays = body.desiredDeliveryDays
  if (body.expressRequested !== undefined)      updateData.expressRequested = body.expressRequested
  if (body.preferredOutputFormats !== undefined) updateData.preferredOutputFormats = body.preferredOutputFormats
  if (body.budgetFlexible !== undefined)        updateData.budgetFlexible = body.budgetFlexible
  if (body.requiredLanguage !== undefined)      updateData.requiredLanguage = body.requiredLanguage

  const updated = await prisma.job.update({
    where: { id },
    data: updateData as any,
  });

  return c.json({ job: updated });
});

export default jobs;
