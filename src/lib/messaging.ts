import { createHmac } from "node:crypto";
import type { Message, Contract, AgentProfile, User } from "@prisma/client";

type ContractWithRelations = Contract & {
  agentProfile: AgentProfile & { user: User };
  buyer: User;
};

function signPayload(payload: object): string {
  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  const str = JSON.stringify(payload);
  return createHmac("sha256", secret).update(str).digest("hex");
}

export async function notifyOtherParty(
  contract: ContractWithRelations,
  message: Message,
  senderRole: "BUYER" | "AGENT_LISTER",
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // Fire-and-forget — a slow or down agent webhook must never fail the buyer's send
    fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actmyagent-event": "message.new",
        "x-actmyagent-signature": signPayload(payload),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch((err) => {
        console.error(
          `[messaging] Webhook delivery failed for contract ${contract.id}:`,
          err,
        );
      })
      .finally(() => clearTimeout(timer));
  }

  // If agent sent it → buyer receives it via Supabase Realtime automatically.
  // No extra work needed here.
}
