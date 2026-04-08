import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import { combinedAuthMiddleware } from "../middleware/combinedAuth.js";
import type { Variables } from "../types/index.js";
import type { PrismaClient, ContractStatus } from "@prisma/client";
import {
  notifyBuyerPaymentRequired,
  notifyAgentContractSigned,
} from "../lib/notifications.js";

const contracts = new Hono<{ Variables: Variables }>();

async function getContractAndCheckAccess(
  prisma: PrismaClient,
  contractId: string,
  userId: string,
) {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          contractId: true,
          senderId: true,
          senderRole: true,
          content: true,
          readAt: true,
          createdAt: true,
          sender: {
            select: { id: true, name: true, userName: true, roles: true },
          },
        },
      },
      payment: true,
      delivery: {
        select: {
          id: true,
          contractId: true,
          description: true,
          fileKeys: true,
          fileNames: true,
          fileSizes: true,
          status: true,
          submittedAt: true,
          reviewDeadline: true,
          approvedAt: true,
          disputedAt: true,
          disputeReason: true,
          autoApproveJobId: true,
        },
      },
      agentProfile: { include: { user: true } },
    },
  });
  if (!contract) return { contract: null, isBuyer: false, isAgent: false };

  const isBuyer = contract.buyerId === userId;
  const isAgent = contract.agentProfile.user.id === userId;

  return { contract, isBuyer, isAgent };
}

// GET /api/contracts/:id
contracts.get("/:id", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Contract not found" }, 404);

  const { contract, isBuyer, isAgent } = await getContractAndCheckAccess(
    prisma,
    id,
    user.id,
  );
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  if (!isBuyer && !isAgent) return c.json({ error: "Forbidden" }, 403);

  return c.json({ contract });
});

// POST /api/contracts/:id/sign
contracts.post("/:id/sign", authMiddleware, async (c) => {
  const user = c.get("user");
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Contract not found" }, 404);

  const contract = await prisma.contract.findFirst({
    where: {
      id,
      status: { in: ["DRAFT", "SIGNED_BUYER", "SIGNED_AGENT"] },
      OR: [
        { buyerId: user.id },
        { agentProfile: { userId: user.id } },
      ],
    },
    include: {
      agentProfile: { include: { user: true } },
      buyer: true,
    },
  });

  if (!contract) return c.json({ error: "Contract not found" }, 404);

  const isBuyer = contract.buyerId === user.id;
  const isAgent = contract.agentProfile.userId === user.id;

  if (!isBuyer && !isAgent) return c.json({ error: "Forbidden" }, 403);

  // Prevent double-signing
  if (isBuyer && contract.buyerSignedAt) {
    return c.json({ error: "You have already signed this contract" }, 400);
  }
  if (isAgent && contract.agentSignedAt) {
    return c.json({ error: "You have already signed this contract" }, 400);
  }

  const now = new Date();
  const otherPartySigned = isBuyer ? !!contract.agentSignedAt : !!contract.buyerSignedAt;

  let newStatus: ContractStatus;
  let bothSignedAt: Date | null = null;
  let paymentDeadline: Date | null = null;

  if (otherPartySigned) {
    // Second signature — open 24-hour payment window
    newStatus = "SIGNED_BOTH";
    bothSignedAt = now;
    paymentDeadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  } else {
    newStatus = isBuyer ? "SIGNED_BUYER" : "SIGNED_AGENT";
  }

  const updated = await prisma.contract.update({
    where: { id },
    data: {
      ...(isBuyer ? { buyerSignedAt: now } : { agentSignedAt: now }),
      status: newStatus,
      ...(bothSignedAt && { bothSignedAt, paymentDeadline }),
    },
  });

  if (newStatus === "SIGNED_BOTH") {
    await notifyBuyerPaymentRequired(contract as any, paymentDeadline!);
    await notifyAgentContractSigned(contract as any);
  }

  return c.json({ contract: updated });
});

// GET /api/contracts/:id/status
// Polling endpoint for agents (API key) and buyers/agent listers (JWT).
contracts.get("/:id/status", combinedAuthMiddleware, async (c) => {
  const user = c.get("user");
  const agentProfile = c.get("agentProfile");
  const prisma = c.get("prisma");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Contract not found" }, 404);

  const contract = await prisma.contract.findFirst({
    where: {
      id,
      OR: [
        { buyerId: user.id },
        { agentProfile: { userId: user.id } },
      ],
    },
    include: {
      payment: {
        select: {
          status: true,
          amountTotal: true,
          currency: true,
        },
      },
    },
  });

  if (!contract) return c.json({ error: "Contract not found" }, 404);

  // If API key auth, verify the authenticated agent profile matches this contract
  if (agentProfile && contract.agentProfileId !== agentProfile.id) {
    return c.json({ error: "Contract not found" }, 404);
  }

  const agentAction = getAgentAction(contract.status);

  const paymentDeadlineMs = contract.paymentDeadline
    ? contract.paymentDeadline.getTime()
    : null;

  return c.json({
    contractId: contract.id,
    status: contract.status,
    agentAction,
    payment: {
      status: contract.payment?.status ?? null,
      secured: contract.payment?.status === "ESCROWED",
      amountTotal: contract.payment?.amountTotal ?? null,
      currency: contract.payment?.currency ?? null,
    },
    timing: {
      paymentDeadline: contract.paymentDeadline,
      paymentDeadlineHoursRemaining: paymentDeadlineMs
        ? Math.max(0, Math.round((paymentDeadlineMs - Date.now()) / 3_600_000))
        : null,
      contractDeadline: contract.deadline,
      bothSignedAt: contract.bothSignedAt,
    },
    // Only expose scope/deliverables once payment is confirmed
    ...(contract.status === "ACTIVE" && {
      scope: contract.scope,
      deliverables: contract.deliverables,
    }),
  });
});

function getAgentAction(status: ContractStatus): string {
  switch (status) {
    case "DRAFT":
    case "SIGNED_BUYER":
    case "SIGNED_AGENT":
    case "SIGNED_BOTH":
      return "wait";
    case "ACTIVE":
      return "start_work";
    case "COMPLETED":
    case "VOIDED":
    case "DISPUTED":
      return "stop";
    default:
      return "wait";
  }
}

export default contracts;
