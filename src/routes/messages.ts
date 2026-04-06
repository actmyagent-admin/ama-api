import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { combinedAuthMiddleware } from "../middleware/combinedAuth.js";
import { notifyOtherParty } from "../lib/messaging.js";
import type { Variables } from "../types/index.js";

const messages = new Hono<{ Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /api/messages/:contractId
// Load conversation history for a contract.
//
// Query params:
//   limit  — max messages to return (default 50, max 100)
//   cursor — message ID; returns messages created AFTER this ID (for pagination)
//
// Supabase Realtime delivers new messages in real time after page mount.
// This endpoint is called once on mount to hydrate the conversation.
// ---------------------------------------------------------------------------
messages.get("/:contractId", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const contractId = c.req.param("contractId");

  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor"); // message id — skip to messages after this one
  const limit = Math.min(parseInt(limitParam ?? "50", 10) || 50, 100);

  // Verify the requester is a party to this contract
  const contract = await prisma.contract.findFirst({
    where: {
      id: contractId,
      OR: [{ buyerId: user.id }, { agentProfile: { userId: user.id } }],
    },
  });
  if (!contract) return c.json({ error: "Contract not found" }, 404);

  const msgs = await prisma.message.findMany({
    where: { contractId },
    orderBy: { createdAt: "asc" },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      sender: {
        select: { id: true, name: true, userName: true, roles: true },
      },
    },
  });

  // Provide nextCursor so the client can page forward (older → newer)
  const nextCursor = msgs.length === limit ? msgs[msgs.length - 1].id : null;

  return c.json({ messages: msgs, nextCursor });
});

// ---------------------------------------------------------------------------
// POST /api/messages
// Send a message on a contract.
//
// Auth: accepts both browser users (Authorization: Bearer <jwt>)
//       and AI agents              (x-api-key: sk_act_...)
//
// On success:
//   • Message is persisted in Postgres.
//   • Supabase Realtime broadcasts to subscribed clients immediately.
//   • If sender is buyer → agent's webhookUrl is called (fire-and-forget).
//   • If sender is agent → buyer receives via Realtime, no webhook needed.
// ---------------------------------------------------------------------------
const sendSchema = z.object({
  contractId: z.string().uuid(),
  content: z.string().min(1).max(4000).trim(),
});

messages.post("/", combinedAuthMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");

  let body: z.infer<typeof sendSchema>;
  try {
    body = sendSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const { contractId, content } = body;

  // Verify party to contract and load relations needed for webhook
  const contract = await prisma.contract.findFirst({
    where: {
      id: contractId,
      OR: [{ buyerId: user.id }, { agentProfile: { userId: user.id } }],
    },
    include: {
      agentProfile: { include: { user: true } },
      buyer: true,
    },
  });

  if (!contract) return c.json({ error: "Forbidden" }, 403);

  if (contract.status === "COMPLETED") {
    return c.json({ error: "Contract is closed" }, 400);
  }

  const isBuyer = contract.buyerId === user.id;
  const senderRole = isBuyer ? "BUYER" : "AGENT_LISTER";

  // Insert message — Supabase Realtime fires automatically from this DB insert
  const message = await prisma.message.create({
    data: {
      contractId,
      senderId: user.id,
      senderRole,
      content,
    },
    include: {
      sender: {
        select: { id: true, name: true, userName: true, roles: true },
      },
    },
  });

  console.log(`[messages] Message saved id=${message.id} senderRole=${senderRole} contractId=${contractId}`);
  // Use waitUntil in production so Workers keeps the promise alive after the response.
  // Fall back to plain fire-and-forget in local dev where executionCtx is unavailable.
  const notifyPromise = notifyOtherParty(contract, message, senderRole, prisma);
  try {
    c.executionCtx.waitUntil(notifyPromise);
    console.log(`[messages] waitUntil registered for message=${message.id}`);
  } catch (err) {
    console.log(`[messages] waitUntil unavailable (local dev), floating promise. err=${err}`);
  }

  return c.json({ message }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/messages/:messageId/read
// Mark a received message as read (sets readAt once; idempotent thereafter).
// Only the recipient — not the sender — can mark a message as read.
// ---------------------------------------------------------------------------
messages.patch("/:messageId/read", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const messageId = c.req.param("messageId");

  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      contract: {
        include: { agentProfile: { include: { user: true } } },
      },
    },
  });

  if (!msg) return c.json({ error: "Message not found" }, 404);

  const { contract } = msg;
  const isBuyer = contract.buyerId === user.id;
  const isAgent = contract.agentProfile.user.id === user.id;

  if (!isBuyer && !isAgent) return c.json({ error: "Forbidden" }, 403);

  if (msg.senderId === user.id) {
    return c.json({ error: "Cannot mark your own message as read" }, 400);
  }

  // Idempotent — return existing record if already read
  if (msg.readAt) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { contract: _contract, ...msgWithoutContract } = msg;
    return c.json({ message: msgWithoutContract });
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { readAt: new Date() },
    include: {
      sender: {
        select: { id: true, name: true, userName: true, roles: true },
      },
    },
  });

  return c.json({ message: updated });
});

export default messages;
