import { createHmac } from "node:crypto";
import type { Job, AgentProfile, User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { broadcastJob } from "./broadcast.js";

type AgentProfileWithUser = AgentProfile & { user: User };

// Shorthand — avoids repeating `(prisma as any)` everywhere in this file.
// Safe to remove once `prisma generate` is run with the updated schema.
function dr(prisma: PrismaClient) {
  return (prisma as any).directRequestEvent;
}

function signPayload(payloadStr: string): string {
  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  return createHmac("sha256", secret).update(payloadStr).digest("hex");
}

/**
 * Fires the direct-request webhook to a single agent and logs the attempt.
 * One attempt only — no blocking retries. Failure is logged but never throws,
 * so the caller's response is never held up by a slow or broken agent webhook.
 */
export async function sendDirectRequestWebhook(
  job: Job,
  agent: AgentProfileWithUser,
  prisma: PrismaClient,
): Promise<void> {
  const apiUrl = process.env.API_URL ?? "https://api.actmyagent.com";

  const payload = {
    event: "job.direct_request",
    jobId: job.id,
    title: job.title,
    description: job.description,
    category: job.category,
    budget: job.budget,
    deadline: job.deadline,
    desiredDeliveryDays: job.desiredDeliveryDays,
    isDirectRequest: true,
    exclusiveUntil: (job as any).directRequestExpiresAt ?? null,
    endpoints: {
      propose: `${apiUrl}/api/proposals`,
      decline: `${apiUrl}/api/jobs/${job.id}/decline-direct`,
      status:  `${apiUrl}/api/jobs/${job.id}/direct-status`,
    },
  };

  const payloadStr = JSON.stringify(payload);
  const signature = signPayload(payloadStr);

  // Log the attempt before firing
  await dr(prisma).create({
    data: {
      jobId:           job.id,
      agentProfileId:  agent.id,
      buyerId:         job.buyerId,
      eventType:       "sent",
      webhookAttempts: 1,
      metadata:        { attempt: 1 },
    },
  });

  try {
    const response = await fetch(agent.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type":           "application/json",
        "x-actmyagent-event":     "job.direct_request",
        "x-actmyagent-signature": signature,
        "x-actmyagent-timestamp": Date.now().toString(),
      },
      body: payloadStr,
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  } catch (err: any) {
    await dr(prisma).create({
      data: {
        jobId:            job.id,
        agentProfileId:   agent.id,
        buyerId:          job.buyerId,
        eventType:        "webhook_failed",
        webhookAttempts:  1,
        webhookLastError: err.message,
        metadata:         { error: err.message },
      },
    });

    console.error(
      `[directRequest] Webhook failed job=${job.id} agent=${agent.id}: ${err.message}`,
    );
  }
}

/**
 * Converts a DIRECT job to BROADCAST: updates the job record, logs the event,
 * then fires the regular broadcast to all matching agents in the category.
 * Returns the number of agents successfully reached.
 */
export async function convertDirectToBroadcast(
  jobId: string,
  prisma: PrismaClient,
): Promise<number> {
  const job = await (prisma as any).job.findUnique({
    where: { id: jobId },
    select: { targetAgentId: true, buyerId: true },
  }) as { targetAgentId: string | null; buyerId: string } | null;

  if (!job?.targetAgentId) {
    throw new Error("Job not found or has no targetAgentId");
  }

  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        ...({
          directRequestStatus: "BROADCAST_CONVERTED",
          broadcastConvertedAt: new Date(),
          routingType: "DIRECT_THEN_BROADCAST",
        } as any),
      },
    }),
    dr(prisma).create({
      data: {
        jobId,
        agentProfileId: job.targetAgentId,
        buyerId:        job.buyerId,
        eventType:      "broadcast_converted",
      },
    }),
  ]);

  const fullJob = await prisma.job.findUnique({ where: { id: jobId } });
  if (!fullJob) throw new Error("Job not found after update");

  return broadcastJob(fullJob, prisma);
}

/**
 * Notifies the buyer that their chosen agent declined.
 * TODO: replace console.log with email/in-app notification when email service is ready.
 */
export async function notifyBuyerDirectDeclined(
  job: Job & { buyer: User },
): Promise<void> {
  console.log(
    `[notify] buyer=${job.buyer.email} jobId=${job.id} ` +
      `action=direct_request_declined message="The agent you requested has declined. ` +
      `You can repost or try another agent."`,
  );
}
