import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  notifyBuyerContractActive,
} from "./notifications.js";

// Called from the Stripe webhook handler when payment_intent.succeeded fires.
// Moves the contract from SIGNED_BOTH → ACTIVE and pushes contract.active to the agent.
export async function activateContract(
  contractId: string,
  prisma: PrismaClient,
): Promise<void> {
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, status: "SIGNED_BOTH" },
    include: {
      agentProfile: { include: { user: true } },
      buyer: true,
      job: true,
    },
  });

  if (!contract) {
    console.error(
      `[activation] Cannot activate contract ${contractId}: not in SIGNED_BOTH state`,
    );
    return;
  }

  await prisma.contract.update({
    where: { id: contractId },
    data: { status: "ACTIVE" },
  });

  await pushContractActiveToAgent(contract as any);
  await notifyBuyerContractActive(contract as any);
}

async function pushContractActiveToAgent(contract: {
  id: string;
  jobId: string;
  scope: string;
  deliverables: string;
  price: number;
  currency: string;
  deadline: Date;
  agentProfile: { webhookUrl: string | null };
  buyer: { name: string | null };
  job: { title: string; description: string; category: string } | null;
}): Promise<void> {
  const webhookUrl = contract.agentProfile.webhookUrl;
  if (!webhookUrl) return;

  const apiUrl = process.env.API_URL ?? "https://api.actmyagent.com";

  const payload = {
    event: "contract.active",
    contractId: contract.id,
    jobId: contract.jobId,
    job: contract.job
      ? {
          title: contract.job.title,
          description: contract.job.description,
          category: contract.job.category,
        }
      : null,
    contract: {
      scope: contract.scope,
      deliverables: contract.deliverables,
      price: contract.price,
      currency: contract.currency,
      deadline: contract.deadline,
    },
    buyer: {
      name: contract.buyer.name,
      // No email — preserve buyer privacy
    },
    endpoints: {
      status: `${apiUrl}/api/contracts/${contract.id}/status`,
      messages: `${apiUrl}/api/messages`,
      deliver: `${apiUrl}/api/deliveries`,
    },
    activatedAt: new Date().toISOString(),
  };

  const payloadStr = JSON.stringify(payload);
  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  const signature = createHmac("sha256", secret).update(payloadStr).digest("hex");

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actmyagent-event": "contract.active",
        "x-actmyagent-signature": signature,
        "x-actmyagent-timestamp": Date.now().toString(),
      },
      body: payloadStr,
      signal: AbortSignal.timeout(8000),
    });
    console.log(
      `[activation] contract.active webhook sent for contract ${contract.id}`,
    );
  } catch (err) {
    // Webhook failed — agent falls back to polling GET /api/contracts/:id/status
    console.error(
      `[activation] contract.active webhook failed for contract ${contract.id}:`,
      err,
    );
  }
}
