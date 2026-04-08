import { Hono } from "hono";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { authMiddleware } from "../middleware/auth.js";
import type { Variables } from "../types/index.js";
import type { PrismaClient, ContractStatus } from "@prisma/client";

const users = new Hono<{ Variables: Variables }>();

// Generate a base username slug from a full name (e.g. "Peter Smith" → "peter-smith")
function generateUserName(fullName: string): string {
  return fullName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 30);
}

async function uniqueUserName(
  fullName: string,
  prisma: PrismaClient,
): Promise<string> {
  const base = generateUserName(fullName);
  const exists = await prisma.user.findUnique({ where: { userName: base } });
  if (!exists) return base;

  for (let i = 1; i <= 100; i++) {
    const candidate = `${base}-${i}`;
    const taken = await prisma.user.findUnique({ where: { userName: candidate } });
    if (!taken) return candidate;
  }
  // Fallback: base + timestamp suffix
  return `${base}-${Date.now()}`;
}

const registerSchema = z.object({
  name: z.string().optional(),
});

// POST /api/users/register
// Called right after Supabase signup — creates the DB user record
users.post("/register", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const prisma = c.get("prisma");
  const existing = await prisma.user.findUnique({
    where: { supabaseId: data.user.id },
  });
  if (existing) {
    return c.json({ user: existing }, 200);
  }

  let body: z.infer<typeof registerSchema> = {};
  try {
    body = registerSchema.parse(await c.req.json());
  } catch {
    // Body is optional
  }

  const email = data.user.email!;
  const nameForUsername = body.name ?? email.split("@")[0];
  const userName = await uniqueUserName(nameForUsername, prisma);

  const user = await prisma.user.create({
    data: {
      supabaseId: data.user.id,
      email,
      userName,
      name: body.name ?? null,
      roles: [],
    },
  });

  return c.json({ user }, 201);
});

// GET /api/users/me
users.get("/me", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  const [profile, agentProfiles] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id } }),
    prisma.agentProfile.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        mainPic: true,
        coverPic: true,
        categories: {
          select: { id: true, name: true, slug: true, mainPic: true, coverPic: true },
        },
        priceFrom: true,
        priceTo: true,
        currency: true,
        webhookUrl: true,
        apiKeyPrefix: true,
        isVerified: true,
        isActive: true,
        avgRating: true,
        totalJobs: true,
        createdAt: true,
      },
    }),
  ]);

  return c.json({ user: { ...profile, agentProfiles } });
});

const updateRoleSchema = z.object({
  role: z.enum(["BUYER", "AGENT_LISTER"]),
});

// POST /api/users/me/role — add a role (idempotent; one account can hold both)
users.post("/me/role", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  let body: z.infer<typeof updateRoleSchema>;
  try {
    body = updateRoleSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  if (user.roles.includes(body.role)) {
    return c.json({ user }, 200);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { roles: { push: body.role } },
  });

  return c.json({ user: updated });
});

const updateUsernameSchema = z.object({
  userName: z
    .string()
    .min(3)
    .max(30)
    .regex(
      /^[a-z0-9_]+$/,
      "Only lowercase letters, numbers, and underscores allowed",
    ),
});

// PATCH /api/users/me/username
users.patch("/me/username", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  let body: z.infer<typeof updateUsernameSchema>;
  try {
    body = updateUsernameSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const taken = await prisma.user.findUnique({
    where: { userName: body.userName },
  });
  if (taken && taken.id !== user.id) {
    return c.json({ error: "Username is already taken" }, 409);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { userName: body.userName },
  });

  return c.json({ user: updated });
});

// GET /api/users/me/stats/buyer — buyer-side stats
users.get("/me/stats/buyer", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("BUYER")) {
    return c.json({ error: "Only BUYER accounts can access buyer stats" }, 403);
  }

  const [jobsPosted, activeContracts, completedContracts, totalSpentResult] =
    await Promise.all([
      prisma.job.count({ where: { buyerId: user.id } }),
      prisma.contract.count({
        where: { buyerId: user.id, status: { in: ["ACTIVE", "SIGNED_AGENT", "SIGNED_BUYER"] } },
      }),
      prisma.contract.count({ where: { buyerId: user.id, status: "COMPLETED" } }),
      prisma.payment.aggregate({
        where: { contract: { buyerId: user.id }, status: "RELEASED" },
        _sum: { amountTotal: true },
      }),
    ]);

  return c.json({
    jobsPosted,
    activeContracts,
    completed: completedContracts,
    // amountTotal is in cents — divide by 100 for display
    totalSpentCents: totalSpentResult._sum?.amountTotal ?? 0,
  });
});

// GET /api/users/me/stats/agent — agent-side stats
users.get("/me/stats/agent", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  if (!user.roles.includes("AGENT_LISTER")) {
    return c.json({ error: "Only AGENT_LISTER accounts can access agent stats" }, 403);
  }

  const agentProfiles = await prisma.agentProfile.findMany({
    where: { userId: user.id },
    select: { id: true, totalJobs: true, avgRating: true },
  });

  if (!agentProfiles.length) {
    return c.json({ error: "Agent profile not found" }, 404);
  }

  const agentProfileIds = agentProfiles.map((p) => p.id);
  const activeStatuses: ContractStatus[] = ["ACTIVE", "SIGNED_AGENT", "SIGNED_BUYER", "SIGNED_BOTH"];

  const [activeContracts, completedContracts, totalEarnedResult, pendingProposals] =
    await Promise.all([
      prisma.contract.count({
        where: { agentProfileId: { in: agentProfileIds }, status: { in: activeStatuses } },
      }),
      prisma.contract.count({
        where: { agentProfileId: { in: agentProfileIds }, status: "COMPLETED" },
      }),
      prisma.payment.aggregate({
        where: { contract: { agentProfileId: { in: agentProfileIds } }, status: "RELEASED" },
        _sum: { amountAgentReceives: true },
      }),
      prisma.proposal.count({
        where: { agentProfileId: { in: agentProfileIds }, status: "PENDING" },
      }),
    ]);

  const totalJobs = agentProfiles.reduce((sum, p) => sum + p.totalJobs, 0);
  const ratingsWithValues = agentProfiles.filter((p) => p.avgRating !== null);
  const avgRating =
    ratingsWithValues.length > 0
      ? ratingsWithValues.reduce((sum, p) => sum + p.avgRating!, 0) / ratingsWithValues.length
      : null;

  return c.json({
    totalJobs,
    activeContracts,
    completed: completedContracts,
    totalEarnedCents: totalEarnedResult._sum?.amountAgentReceives ?? 0,
    pendingProposals,
    avgRating,
  });
});

export default users;
