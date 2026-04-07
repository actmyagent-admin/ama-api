import { createHmac } from "node:crypto";
import type { Contract, AgentProfile, User, Job } from "@prisma/client";

type ContractWithRelations = Contract & {
  agentProfile: AgentProfile & { user: User };
  buyer: User;
  job?: Pick<Job, "title" | "description" | "category"> | null;
};

function signPayload(payloadStr: string): string {
  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  return createHmac("sha256", secret).update(payloadStr).digest("hex");
}

// Notify buyer they need to pay within 24 hours to activate the contract.
// TODO: replace console.log with email/in-app notification when email service is added.
export async function notifyBuyerPaymentRequired(
  contract: ContractWithRelations,
  paymentDeadline: Date,
): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL ?? "https://actmyagent.com";
  console.log(
    `[notify] buyer=${contract.buyer.email} contract=${contract.id} ` +
      `action=payment_required deadline=${paymentDeadline.toISOString()} ` +
      `pay_at=${frontendUrl}/contracts/${contract.id}/pay`,
  );
}

// Push contract.signed_both to the agent's webhook so it knows to stand by.
export async function notifyAgentContractSigned(
  contract: ContractWithRelations,
): Promise<void> {
  const webhookUrl = contract.agentProfile.webhookUrl;
  if (!webhookUrl) return;

  const payload = {
    event: "contract.signed_both",
    contractId: contract.id,
    jobId: contract.jobId,
    message:
      "Contract signed by both parties. Standby — work begins once buyer secures payment.",
  };

  const payloadStr = JSON.stringify(payload);
  const signature = signPayload(payloadStr);

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actmyagent-event": "contract.signed_both",
        "x-actmyagent-signature": signature,
        "x-actmyagent-timestamp": Date.now().toString(),
      },
      body: payloadStr,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error(
      `[notify] contract.signed_both webhook failed contract=${contract.id}:`,
      err,
    );
  }
}

// Notify buyer that payment is secured and agent has been notified.
// TODO: replace console.log with email/in-app notification when email service is added.
export async function notifyBuyerContractActive(
  contract: ContractWithRelations,
): Promise<void> {
  console.log(
    `[notify] buyer=${contract.buyer.email} contract=${contract.id} ` +
      `action=contract_active message="Payment secured — agent notified, work starting."`,
  );
}

// Notify buyer their contract was voided because payment wasn't received in time.
// TODO: replace console.log with email/in-app notification when email service is added.
export async function notifyBuyerContractVoided(
  contract: ContractWithRelations,
): Promise<void> {
  console.log(
    `[notify] buyer=${contract.buyer.email} contract=${contract.id} ` +
      `action=contract_voided reason=payment_timeout message="Contract voided — job reopened."`,
  );
}

// Push contract.voided to the agent's webhook so it stops any preparation.
export async function notifyAgentContractVoided(
  contract: ContractWithRelations,
): Promise<void> {
  const webhookUrl = contract.agentProfile.webhookUrl;
  if (!webhookUrl) return;

  const payload = {
    event: "contract.voided",
    contractId: contract.id,
    reason: "payment_timeout",
    message: "Buyer did not complete payment within 24 hours.",
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actmyagent-event": "contract.voided",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(
      `[notify] contract.voided webhook failed contract=${contract.id}:`,
      err,
    );
  }
}
