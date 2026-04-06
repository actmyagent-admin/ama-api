import { createHmac } from "node:crypto";
import type { Message, Contract, AgentProfile, User } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

type ContractWithRelations = Contract & {
  agentProfile: AgentProfile & { user: User };
  buyer: User;
};

const MAX_RESPONSE_BODY_BYTES = 2048;

function signPayload(payload: object): string {
  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  const str = JSON.stringify(payload);
  return createHmac("sha256", secret).update(str).digest("hex");
}

// Returns a promise that resolves when both the webhook call and DB log are done.
// Caller should register this with ctx.waitUntil() so Cloudflare Workers doesn't
// kill the promise after the HTTP response is sent.
export function notifyOtherParty(
  contract: ContractWithRelations,
  message: Message,
  senderRole: "BUYER" | "AGENT_LISTER",
  prisma: PrismaClient,
): Promise<void> {
  // If agent sent it → buyer receives it via Supabase Realtime automatically.
  if (senderRole !== "BUYER") return Promise.resolve();

  const webhookUrl = contract.agentProfile.webhookUrl;
  if (!webhookUrl) return Promise.resolve();

  const payload = {
    event: "message.new",
    contractId: contract.id,
    messageId: message.id,
    content: message.content,
    senderRole: "BUYER",
    sentAt: message.createdAt,
    replyEndpoint: `${process.env.FRONTEND_URL ?? "https://api.actmyagent.com"}/api/messages`,
  };

  const payloadStr = JSON.stringify(payload);
  const signature = signPayload(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const attemptedAt = new Date();

  // Return the full promise chain — caller registers it with waitUntil()
  return fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-actmyagent-event": "message.new",
      "x-actmyagent-signature": signature,
    },
    body: payloadStr,
    signal: controller.signal,
  })
    .then(async (res) => {
      const durationMs = Date.now() - attemptedAt.getTime();
      const respondedAt = new Date();
      const httpStatus = res.status;

      const rawBody = await res.text().catch(() => null);
      const responseBody = rawBody
        ? rawBody.length > MAX_RESPONSE_BODY_BYTES
          ? rawBody.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]"
          : rawBody
        : null;

      const status = res.ok ? "SUCCESS" : "HTTP_ERROR";
      const errorMessage = res.ok ? null : `HTTP ${res.status}`;

      await prisma.broadcastLog.create({
        data: {
          eventType: "message.new",
          messageId: message.id,
          contractId: contract.id,
          agentProfileId: contract.agentProfileId,
          webhookUrl,
          status,
          httpStatus,
          responseBody,
          errorMessage,
          durationMs,
          attemptedAt,
          respondedAt,
        },
      });
    })
    .catch(async (err) => {
      const durationMs = Date.now() - attemptedAt.getTime();
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const status = isTimeout ? "TIMEOUT" : "FAILED";
      const errorMessage = err instanceof Error ? err.message : String(err);

      console.error(
        `[messaging] Webhook delivery failed for contract ${contract.id}:`,
        err,
      );

      await prisma.broadcastLog.create({
        data: {
          eventType: "message.new",
          messageId: message.id,
          contractId: contract.id,
          agentProfileId: contract.agentProfileId,
          webhookUrl,
          status,
          httpStatus: null,
          responseBody: null,
          errorMessage,
          durationMs,
          attemptedAt,
          respondedAt: null,
        },
      }).catch((logErr) =>
        console.error("[messaging] Failed to write BroadcastLog:", logErr),
      );
    })
    .finally(() => clearTimeout(timer));
}
