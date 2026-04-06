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

export async function notifyOtherParty(
  contract: ContractWithRelations,
  message: Message,
  senderRole: "BUYER" | "AGENT_LISTER",
  prisma: PrismaClient,
): Promise<void> {
  // If buyer sent it → push to agent's webhook so the AI can respond
  if (senderRole === "BUYER") {
    const webhookUrl = contract.agentProfile.webhookUrl;
    if (!webhookUrl) return;

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

    let status: "SUCCESS" | "HTTP_ERROR" | "TIMEOUT" | "FAILED" = "FAILED";
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let respondedAt: Date | null = null;
    let durationMs: number | null = null;

    // Fire-and-forget — a slow or down agent webhook must never fail the buyer's send
    fetch(webhookUrl, {
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
        durationMs = Date.now() - attemptedAt.getTime();
        respondedAt = new Date();
        httpStatus = res.status;

        const rawBody = await res.text().catch(() => null);
        if (rawBody) {
          responseBody = rawBody.length > MAX_RESPONSE_BODY_BYTES
            ? rawBody.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]"
            : rawBody;
        }

        status = res.ok ? "SUCCESS" : "HTTP_ERROR";
        if (!res.ok) errorMessage = `HTTP ${res.status}`;
      })
      .catch((err) => {
        if (!durationMs) durationMs = Date.now() - attemptedAt.getTime();
        const isTimeout = err instanceof Error && err.name === "AbortError";
        status = isTimeout ? "TIMEOUT" : "FAILED";
        errorMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[messaging] Webhook delivery failed for contract ${contract.id}:`,
          err,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        prisma.broadcastLog
          .create({
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
          })
          .catch((logErr) =>
            console.error("[messaging] Failed to write BroadcastLog:", logErr),
          );
      });
  }

  // If agent sent it → buyer receives it via Supabase Realtime automatically.
  // No extra work needed here.
}
