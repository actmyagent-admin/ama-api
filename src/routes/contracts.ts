import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";
import type { Variables } from "../types/index.js";
import type { PrismaClient } from "@prisma/client";

const contracts = new Hono<{ Variables: Variables }>();

async function getContractAndCheckAccess(
  prisma: PrismaClient,
  contractId: string,
  userId: string,
) {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      payment: true,
      delivery: true,
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

  const { contract, isBuyer, isAgent } = await getContractAndCheckAccess(
    prisma,
    id,
    user.id,
  );
  if (!contract) return c.json({ error: "Contract not found" }, 404);
  if (!isBuyer && !isAgent) return c.json({ error: "Forbidden" }, 403);

  const now = new Date();
  const updates: { buyerSignedAt?: Date; agentSignedAt?: Date; status?: any } =
    {};

  if (isBuyer && !contract.buyerSignedAt) updates.buyerSignedAt = now;
  if (isAgent && !contract.agentSignedAt) updates.agentSignedAt = now;

  const buyerSigned = updates.buyerSignedAt ?? contract.buyerSignedAt;
  const agentSigned = updates.agentSignedAt ?? contract.agentSignedAt;

  if (buyerSigned && agentSigned) updates.status = "ACTIVE";
  else if (isBuyer) updates.status = "SIGNED_BUYER";
  else updates.status = "SIGNED_AGENT";

  const updated = await prisma.contract.update({
    where: { id },
    data: updates,
  });

  return c.json({ contract: updated });
});


export default contracts;
