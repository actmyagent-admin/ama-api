import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { combinedAuthMiddleware } from "../middleware/combinedAuth.js";
import { categorizeJob } from "../lib/anthropic.js";
import { broadcastJob } from "../lib/broadcast.js";
import {
  sendDirectRequestWebhook,
  convertDirectToBroadcast,
  notifyBuyerDirectDeclined,
} from "../lib/directRequest.js";
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

  // Resolve category slug → Category row (AI suggestion falls back to "other")
  const rawCategorySlug = body.category ?? analysis.suggestedCategory;
  const categoryRow = await prisma.category.findFirst({
    where: { slug: rawCategorySlug },
    select: { id: true, slug: true, name: true },
  }) ?? await prisma.category.findFirst({
    where: { slug: "other" },
    select: { id: true, slug: true, name: true },
  });

  if (!categoryRow) {
    return c.json({ error: "Category not found. Please provide a valid category slug." }, 400);
  }

  const job = await prisma.job.create({
    data: {
      buyerId: user.id,
      title: body.title,
      description: body.description,
      category: categoryRow.slug,
      categoryId: categoryRow.id,
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
    include: { categoryRef: { select: { id: true, name: true, slug: true } } },
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
      categoryRef: { select: { id: true, name: true, slug: true } },
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

  const [jobList, inhouseOrders] = await Promise.all([
    prisma.job.findMany({
      where: {
        buyerId: user.id,
        ...(status ? { status: status as any } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        categoryRef: { select: { id: true, name: true, slug: true } },
        buyer: {
          select: { id: true, name: true, email: true, userName: true, mainPic: true },
        },
        proposals: {
          select: { id: true, status: true, price: true, currency: true, estimatedDays: true },
        },
        contract: {
          select: { id: true, status: true, price: true, currency: true, deadline: true },
        },
      },
    }),
    prisma.inhouseOrder.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        service: {
          select: {
            id: true,
            pageSlug: true,
            packageName: true,
            priceCents: true,
            deliveryDays: true,
          },
        },
        contract: {
          select: {
            id: true,
            status: true,
            paymentDeadline: true,
            payment: { select: { status: true } },
            delivery: { select: { id: true, status: true, submittedAt: true } },
          },
        },
      },
    }),
  ]);

  return c.json({ jobs: jobList, inhouseOrders, limit, offset });
});

// ─── GET /api/jobs/received-direct-requests ─────────────────────────────────
// Frontend endpoint for AGENT_LISTER users.
// Returns all direct-request jobs addressed to ANY agent profile owned by
// the authenticated user, across all their listings.
// Query: status? (PENDING|ACCEPTED|DECLINED|BROADCAST_CONVERTED), limit?, offset?
jobs.get("/received-direct-requests", authMiddleware, async (c) => {
  const user   = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("AGENT_LISTER")) {
    return c.json({ error: "Only AGENT_LISTER accounts can access this endpoint" }, 403);
  }

  const status = c.req.query("status");
  const limit  = Math.min(Number(c.req.query("limit")  ?? 20), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  // Collect all agent profiles owned by this user
  const ownedProfiles = await prisma.agentProfile.findMany({
    where: { userId: user.id, isDeleted: false },
    select: { id: true },
  });

  if (!ownedProfiles.length) {
    return c.json({ directRequests: [], limit, offset });
  }

  const profileIds = ownedProfiles.map((p) => p.id);

  const requests = await (prisma as any).job.findMany({
    where: {
      targetAgentId: { in: profileIds },
      ...(status ? { directRequestStatus: status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take:    limit,
    skip:    offset,
    select: {
      id:                          true,
      title:                       true,
      description:                 true,
      category:                    true,
      budget:                      true,
      currency:                    true,
      deadline:                    true,
      status:                      true,
      createdAt:                   true,
      desiredDeliveryDays:         true,
      expressRequested:            true,
      preferredOutputFormats:      true,
      briefDetail:                 true,
      attachmentKeys:              true,
      attachmentNames:             true,
      routingType:                 true,
      broadcastOnDecline:          true,
      directRequestStatus:         true,
      directRequestSentAt:         true,
      directRequestExpiresAt:      true,
      directRequestDeclinedAt:     true,
      directRequestDeclineReason:  true,
      broadcastConvertedAt:        true,
      targetAgent: {
        select: { id: true, name: true, slug: true, mainPic: true },
      },
      buyer: {
        select: { id: true, name: true, userName: true, mainPic: true },
      },
      proposals: {
        where: { agentProfileId: { in: profileIds } },
        select: { id: true, status: true, price: true, currency: true, estimatedDays: true, createdAt: true },
      },
      contract: {
        select: { id: true, status: true, price: true, currency: true, deadline: true },
      },
    },
  });

  return c.json({ directRequests: requests, limit, offset });
});

// ─── GET /api/jobs/direct-requests ──────────────────────────────────────────
// Agent fetches all direct requests addressed to them (single profile).
// Auth: API key (agent system) or JWT (human lister).
// Query: status? (PENDING | ACCEPTED | DECLINED | BROADCAST_CONVERTED), limit?, offset?
jobs.get("/direct-requests", combinedAuthMiddleware, async (c) => {
  const prisma    = c.get("prisma");
  const actorType = c.get("actorType");

  const agentProfile =
    actorType === "AGENT"
      ? c.get("agentProfile")
      : await prisma.agentProfile.findFirst({
          where: { userId: c.get("user").id },
        });

  if (!agentProfile) {
    return c.json({ error: "Agent profile not found" }, 404);
  }

  const status  = c.req.query("status");
  const limit   = Math.min(Number(c.req.query("limit")  ?? 20), 100);
  const offset  = Number(c.req.query("offset") ?? 0);

  const requests = await (prisma as any).job.findMany({
    where: {
      targetAgentId:       agentProfile.id,
      ...(status ? { directRequestStatus: status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take:    limit,
    skip:    offset,
    select: {
      id:                         true,
      title:                      true,
      description:                true,
      category:                   true,
      budget:                     true,
      currency:                   true,
      deadline:                   true,
      status:                     true,
      createdAt:                  true,
      desiredDeliveryDays:        true,
      preferredOutputFormats:     true,
      routingType:                true,
      directRequestStatus:        true,
      directRequestSentAt:        true,
      directRequestExpiresAt:     true,
      directRequestDeclinedAt:    true,
      directRequestDeclineReason: true,
      broadcastConvertedAt:       true,
      buyer: {
        select: { id: true, name: true, userName: true, mainPic: true },
      },
    },
  });

  return c.json({ directRequests: requests, limit, offset });
});

// GET /api/jobs/:id
jobs.get("/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      categoryRef: { select: { id: true, name: true, slug: true } },
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

// ─── POST /api/jobs/:id/attachments ─────────────────────────────────────────
// Buyer adds a single already-uploaded file to a job's attachment list.
// Max 3 attachments at any time. Owner only.
const addAttachmentSchema = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(255),
});

jobs.post("/:id/attachments", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can manage job attachments" }, 403);
  }

  let body: z.infer<typeof addAttachmentSchema>;
  try {
    body = addAttachmentSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const job = await prisma.job.findUnique({
    where: { id },
    select: { buyerId: true, attachmentKeys: true, attachmentNames: true },
  });

  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  const keys = job.attachmentKeys as string[];
  const names = job.attachmentNames as string[];

  if (keys.length >= 3) {
    return c.json(
      { error: "Maximum 3 attachments allowed. Remove one before adding another." },
      409
    );
  }

  if (keys.includes(body.key)) {
    return c.json({ error: "This file is already attached to the job" }, 409);
  }

  const updated = await prisma.job.update({
    where: { id },
    data: {
      attachmentKeys: [...keys, body.key],
      attachmentNames: [...names, body.filename],
    } as any,
    select: { id: true, attachmentKeys: true, attachmentNames: true },
  });

  return c.json({
    attachments: (updated.attachmentKeys as string[]).map((k, i) => ({
      key: k,
      filename: (updated.attachmentNames as string[])[i],
    })),
  }, 201);
});

// ─── DELETE /api/jobs/:id/attachments ────────────────────────────────────────
// Buyer removes a single attachment from a job by its S3 key. Owner only.
const removeAttachmentSchema = z.object({
  key: z.string().min(1),
});

jobs.delete("/:id/attachments", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can manage job attachments" }, 403);
  }

  let body: z.infer<typeof removeAttachmentSchema>;
  try {
    body = removeAttachmentSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const job = await prisma.job.findUnique({
    where: { id },
    select: { buyerId: true, attachmentKeys: true, attachmentNames: true },
  });

  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  const keys = job.attachmentKeys as string[];
  const names = job.attachmentNames as string[];
  const idx = keys.indexOf(body.key);

  if (idx === -1) {
    return c.json({ error: "Attachment not found on this job" }, 404);
  }

  const newKeys = keys.filter((_, i) => i !== idx);
  const newNames = names.filter((_, i) => i !== idx);

  const updated = await prisma.job.update({
    where: { id },
    data: {
      attachmentKeys: newKeys,
      attachmentNames: newNames,
    } as any,
    select: { id: true, attachmentKeys: true, attachmentNames: true },
  });

  return c.json({
    attachments: (updated.attachmentKeys as string[]).map((k, i) => ({
      key: k,
      filename: (updated.attachmentNames as string[])[i],
    })),
  });
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
// Buyer updates a job. Blocked if any proposal exists (any status).
// Category cannot be changed. No rebroadcast on update.
const updateJobSchema = z.object({
  // Core fields
  title: z.string().min(1).optional(),
  description: z.string().min(10).optional(),
  budget: z.number().positive().nullable().optional(),
  currency: z.string().optional(),
  deadline: z.string().datetime().nullable().optional(),
  // Scope clarity
  briefDetail: z.string().nullable().optional(),
  attachmentKeys: z.array(z.string()).optional(),
  attachmentNames: z.array(z.string()).optional(),
  exampleUrls: z.array(z.string().url()).optional(),
  // Delivery preferences
  desiredDeliveryDays: z.number().int().positive().nullable().optional(),
  expressRequested: z.boolean().optional(),
  preferredOutputFormats: z.array(z.string()).optional(),
  // Proposal settings
  proposalDeadlineHours: z.number().int().positive().nullable().optional(),
  maxProposals: z.number().int().positive().nullable().optional(),
  // Buyer preferences
  preferHuman: z.boolean().optional(),
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

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      buyerId: true,
      status: true,
      _count: { select: { proposals: true } },
    },
  });
  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);
  if (job.status !== "OPEN") {
    return c.json({ error: "Only OPEN jobs can be updated" }, 409);
  }
  if (job._count.proposals > 0) {
    return c.json(
      { error: "This job cannot be edited because it already has proposals" },
      409
    );
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

  const updateData: Record<string, unknown> = {};
  if (body.title !== undefined)                  updateData.title = body.title;
  if (body.description !== undefined)            updateData.description = body.description;
  if (body.budget !== undefined)                 updateData.budget = body.budget;
  if (body.currency !== undefined)               updateData.currency = body.currency;
  if (body.deadline !== undefined)               updateData.deadline = body.deadline ? new Date(body.deadline) : null;
  if (body.briefDetail !== undefined)            updateData.briefDetail = body.briefDetail;
  if (body.attachmentKeys !== undefined)         updateData.attachmentKeys = body.attachmentKeys;
  if (body.attachmentNames !== undefined)        updateData.attachmentNames = body.attachmentNames;
  if (body.exampleUrls !== undefined)            updateData.exampleUrls = body.exampleUrls;
  if (body.desiredDeliveryDays !== undefined)    updateData.desiredDeliveryDays = body.desiredDeliveryDays;
  if (body.expressRequested !== undefined)       updateData.expressRequested = body.expressRequested;
  if (body.preferredOutputFormats !== undefined) updateData.preferredOutputFormats = body.preferredOutputFormats;
  if (body.proposalDeadlineHours !== undefined)  updateData.proposalDeadlineHours = body.proposalDeadlineHours;
  if (body.maxProposals !== undefined)           updateData.maxProposals = body.maxProposals;
  if (body.preferHuman !== undefined)            updateData.preferHuman = body.preferHuman;
  if (body.budgetFlexible !== undefined)         updateData.budgetFlexible = body.budgetFlexible;
  if (body.requiredLanguage !== undefined)       updateData.requiredLanguage = body.requiredLanguage;

  const updated = await prisma.job.update({
    where: { id },
    data: updateData as any,
  });

  return c.json({ job: updated });
});

// ─── DELETE /api/jobs/:id ────────────────────────────────────────────────────
// Hard-deletes a job and all its proposals.
// Blocked if any contract row references this job (any status).
jobs.delete("/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can delete jobs" }, 403);
  }

  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      buyerId: true,
      contract: { select: { id: true } },
    },
  });

  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  if (job.contract) {
    return c.json(
      { error: "This job cannot be deleted because it has an associated contract" },
      409
    );
  }

  await prisma.$transaction([
    prisma.proposal.deleteMany({ where: { jobId: id } }),
    prisma.job.delete({ where: { id } }),
  ]);

  return c.json({ success: true });
});

// ─── POST /api/jobs/direct-request ──────────────────────────────────────────
// Buyer sends a direct request to a specific agent. Creates a Job row with
// routingType DIRECT (or DIRECT_THEN_BROADCAST when broadcastOnDecline=true),
// fires one webhook to the target agent, and returns immediately.
const createDirectRequestSchema = z.object({
  agentProfileId:        z.string().uuid(),
  title:                 z.string().min(1),
  description:           z.string().min(10),
  category:              z.string().optional(),
  budget:                z.number().positive().optional(),
  currency:              z.string().default("USD"),
  deadline:              z.string().datetime().optional(),
  briefDetail:           z.string().optional(),
  attachmentKeys:        z.array(z.string()).optional(),
  attachmentNames:       z.array(z.string()).optional(),
  exampleUrls:           z.array(z.string().url()).optional(),
  desiredDeliveryDays:   z.number().int().positive().optional(),
  preferredOutputFormats: z.array(z.string()).optional(),
  budgetFlexible:        z.boolean().optional(),
  broadcastOnDecline:    z.boolean().default(false),
});

jobs.post("/direct-request", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only BUYER accounts can send direct requests" }, 403);
  }

  let body: z.infer<typeof createDirectRequestSchema>;
  try {
    body = createDirectRequestSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  // Verify agent exists, is active, and is not deleted
  const agent = await prisma.agentProfile.findFirst({
    where: {
      id:        body.agentProfileId,
      isActive:  true,
      isDeleted: false,
    },
    include: { user: true, categories: true },
  });

  if (!agent) {
    return c.json({ error: "Agent not found or not available for direct requests" }, 404);
  }

  // Check agent capacity
  if (
    agent.maxConcurrentJobs !== null &&
    agent.currentActiveJobs >= agent.maxConcurrentJobs
  ) {
    return c.json(
      {
        error: "This agent is currently at full capacity",
        code: "AGENT_AT_CAPACITY",
        availabilityStatus: agent.availabilityStatus,
      },
      409,
    );
  }

  // Resolve category: provided slug → agent's first category → "other"
  const rawCategorySlugDR = body.category ?? agent.categories[0]?.slug ?? "other";
  const categoryRowDR = await prisma.category.findFirst({
    where: { slug: rawCategorySlugDR },
    select: { id: true, slug: true, name: true },
  }) ?? await prisma.category.findFirst({
    where: { slug: "other" },
    select: { id: true, slug: true, name: true },
  });

  if (!categoryRowDR) {
    return c.json({ error: "Category not found. Please provide a valid category slug." }, 400);
  }

  const job = await prisma.job.create({
    data: {
      buyerId:     user.id,
      title:       body.title,
      description: body.description,
      category:    categoryRowDR.slug,
      categoryId:  categoryRowDR.id,
      budget:      body.budget ?? undefined,
      currency:    body.currency,
      deadline:    body.deadline ? new Date(body.deadline) : null,
      // Scope clarity
      ...(body.briefDetail           !== undefined && { briefDetail:           body.briefDetail }),
      ...(body.attachmentKeys        !== undefined && { attachmentKeys:        body.attachmentKeys }),
      ...(body.attachmentNames       !== undefined && { attachmentNames:       body.attachmentNames }),
      ...(body.exampleUrls           !== undefined && { exampleUrls:           body.exampleUrls }),
      // Delivery preferences
      ...(body.desiredDeliveryDays    !== undefined && { desiredDeliveryDays:   body.desiredDeliveryDays }),
      ...(body.preferredOutputFormats !== undefined && { preferredOutputFormats: body.preferredOutputFormats }),
      ...(body.budgetFlexible         !== undefined && { budgetFlexible:        body.budgetFlexible }),
      // Direct request routing (new fields — cast until `prisma generate` is run)
      ...({
        routingType:            body.broadcastOnDecline ? "DIRECT_THEN_BROADCAST" : "DIRECT",
        targetAgentId:          body.agentProfileId,
        broadcastOnDecline:     body.broadcastOnDecline,
        directRequestStatus:    "PENDING",
        directRequestSentAt:    new Date(),
        directRequestExpiresAt: null,
      } as any),
    },
    include: { categoryRef: { select: { id: true, name: true, slug: true } } },
  });

  // Fire webhook fire-and-forget — never block the response
  sendDirectRequestWebhook(job, agent, prisma).catch((err: unknown) =>
    console.error("[jobs] sendDirectRequestWebhook unhandled error:", err),
  );

  return c.json(
    {
      job,
      message: "Direct request sent. The agent has been notified via webhook.",
    },
    201,
  );
});

// ─── POST /api/jobs/:id/decline-direct ──────────────────────────────────────
// Agent (API key or human lister JWT) explicitly declines a direct request.
// If broadcastOnDecline=true the job is automatically converted to broadcast.
// Otherwise the buyer is notified and the job stays as DIRECT_DECLINED.
const declineDirectSchema = z.object({
  reason: z.string().optional(),
});

jobs.post("/:id/decline-direct", combinedAuthMiddleware, async (c) => {
  const prisma      = c.get("prisma");
  const actorType   = c.get("actorType");
  const id          = c.req.param("id");

  // Resolve the acting agent profile (from API key context or JWT lookup)
  const agentProfile =
    actorType === "AGENT"
      ? c.get("agentProfile")
      : await prisma.agentProfile.findFirst({
          where: { userId: c.get("user").id },
        });

  if (!agentProfile) {
    return c.json({ error: "Agent profile not found" }, 404);
  }

  let body: z.infer<typeof declineDirectSchema>;
  try {
    body = declineDirectSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const job = await (prisma as any).job.findFirst({
    where: {
      id,
      targetAgentId:       agentProfile.id,
      directRequestStatus: "PENDING",
    },
    include: { buyer: true },
  }) as (any & { buyerId: string; broadcastOnDecline: boolean; buyer: any }) | null;

  if (!job) {
    return c.json(
      { error: "Direct request not found or already handled" },
      404,
    );
  }

  const jobId = id!;

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        ...({
          directRequestStatus:        "DECLINED",
          directRequestDeclinedAt:    new Date(),
          directRequestDeclineReason: body.reason ?? null,
        } as any),
      },
    }),
    (prisma as any).directRequestEvent.create({
      data: {
        jobId,
        agentProfileId: agentProfile.id,
        buyerId:        job.buyerId,
        eventType:      "declined",
        metadata:       { reason: body.reason ?? null, actorType },
      },
    }),
  ]);

  // Convert to broadcast or notify buyer
  if (job.broadcastOnDecline) {
    convertDirectToBroadcast(jobId, prisma).catch((err: unknown) =>
      console.error("[jobs] convertDirectToBroadcast error:", err),
    );
  } else {
    notifyBuyerDirectDeclined(job).catch((err: unknown) =>
      console.error("[jobs] notifyBuyerDirectDeclined error:", err),
    );
  }

  return c.json({ received: true });
});

// ─── GET /api/jobs/:id/direct-status ────────────────────────────────────────
// Agent polls to check whether the direct request is still pending or has changed.
// Auth: API key (agent system) or JWT (human lister).
jobs.get("/:id/direct-status", combinedAuthMiddleware, async (c) => {
  const prisma    = c.get("prisma");
  const actorType = c.get("actorType");
  const id        = c.req.param("id");

  const agentProfile =
    actorType === "AGENT"
      ? c.get("agentProfile")
      : await prisma.agentProfile.findFirst({
          where: { userId: c.get("user").id },
        });

  if (!agentProfile) {
    return c.json({ error: "Agent profile not found" }, 404);
  }

  const job = await (prisma as any).job.findFirst({
    where: { id, targetAgentId: agentProfile.id },
    select: {
      directRequestStatus:    true,
      directRequestExpiresAt: true,
      title:                  true,
      category:               true,
      budget:                 true,
    },
  }) as {
    directRequestStatus:    string | null;
    directRequestExpiresAt: Date | null;
    title:                  string;
    category:               string;
    budget:                 number | null;
  } | null;

  if (!job) return c.json({ error: "Direct request not found" }, 404);

  const hoursRemaining =
    job.directRequestExpiresAt
      ? Math.max(
          0,
          Math.round(
            (job.directRequestExpiresAt.getTime() - Date.now()) / 3_600_000,
          ),
        )
      : null; // null = no expiry set

  return c.json({
    status:         job.directRequestStatus,
    hoursRemaining,
    expired:        hoursRemaining === 0,
    // Tells the agent what action is expected
    agentAction:
      job.directRequestStatus === "PENDING" && hoursRemaining !== 0
        ? "respond"  // submit a proposal or decline
        : "ignore",  // window closed or already handled
  });
});

// ─── POST /api/jobs/:id/convert-to-broadcast ────────────────────────────────
// Buyer manually converts a DIRECT (or declined) job to a full broadcast.
// Useful when broadcastOnDecline=false but the buyer still wants to open it up
// after the agent declines or ignores it.
jobs.post("/:id/convert-to-broadcast", authMiddleware, async (c) => {
  const user   = c.get("user");
  const prisma = c.get("prisma");
  const id     = c.req.param("id");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only buyers can convert a direct request to broadcast" }, 403);
  }

  const jobId = id!;

  const job = await (prisma as any).job.findUnique({
    where: { id: jobId },
    select: {
      buyerId:             true,
      routingType:         true,
      directRequestStatus: true,
      targetAgentId:       true,
    },
  }) as {
    buyerId:             string;
    routingType:         string | null;
    directRequestStatus: string | null;
    targetAgentId:       string | null;
  } | null;

  if (!job) return c.json({ error: "Job not found" }, 404);
  if (job.buyerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  if (!job.targetAgentId) {
    return c.json({ error: "This job is not a direct request" }, 409);
  }

  if (job.directRequestStatus === "BROADCAST_CONVERTED") {
    return c.json({ error: "Job has already been converted to broadcast" }, 409);
  }

  const broadcastCount = await convertDirectToBroadcast(jobId, prisma);

  return c.json({
    success: true,
    broadcastCount,
    message: `Job broadcast to ${broadcastCount} agent(s).`,
  });
});

export default jobs;
