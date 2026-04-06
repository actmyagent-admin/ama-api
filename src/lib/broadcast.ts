import { createHmac } from "node:crypto";
import type { Job } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

const MAX_RESPONSE_BODY_BYTES = 2048;

export async function broadcastJob(
  job: Job,
  prisma: PrismaClient,
): Promise<number> {
  const agents = await prisma.agentProfile.findMany({
    where: {
      isActive: true,
      categories: { some: { slug: job.category } },
    },
  });

  const secret = process.env.BROADCAST_HMAC_SECRET ?? "default-secret";
  const proposalDeadline = new Date(
    Date.now() + 4 * 60 * 60 * 1000,
  ).toISOString();

  const payload = {
    event: "job.new",
    jobId: job.id,
    title: job.title,
    description: job.description,
    category: job.category,
    budget: job.budget,
    deadline: job.deadline,
    proposalEndpoint: `${process.env.FRONTEND_URL ?? "https://api.actmyagent.com"}/api/proposals`,
    proposalDeadline,
  };

  const payloadStr = JSON.stringify(payload);
  const signature = createHmac("sha256", secret)
    .update(payloadStr)
    .digest("hex");

  const totalAgentsInBatch = agents.length;

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const attemptedAt = new Date();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      let status: "SUCCESS" | "HTTP_ERROR" | "TIMEOUT" | "FAILED" = "FAILED";
      let httpStatus: number | null = null;
      let responseBody: string | null = null;
      let errorMessage: string | null = null;
      let respondedAt: Date | null = null;
      let durationMs: number | null = null;

      try {
        const start = Date.now();
        const res = await fetch(agent.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-actmyagent-signature": signature,
          },
          body: payloadStr,
          signal: controller.signal,
        });

        durationMs = Date.now() - start;
        respondedAt = new Date();
        httpStatus = res.status;

        const rawBody = await res.text().catch(() => null);
        if (rawBody) {
          responseBody = rawBody.length > MAX_RESPONSE_BODY_BYTES
            ? rawBody.slice(0, MAX_RESPONSE_BODY_BYTES) + "…[truncated]"
            : rawBody;
        }

        if (res.ok) {
          status = "SUCCESS";
        } else {
          status = "HTTP_ERROR";
          errorMessage = `HTTP ${res.status}`;
          throw new Error(errorMessage);
        }
      } catch (err) {
        if (status !== "HTTP_ERROR") {
          const isTimeout =
            err instanceof Error && err.name === "AbortError";
          status = isTimeout ? "TIMEOUT" : "FAILED";
          errorMessage = err instanceof Error ? err.message : String(err);
          if (!durationMs) durationMs = Date.now() - attemptedAt.getTime();
        }
      } finally {
        clearTimeout(timer);

        await prisma.broadcastLog.create({
          data: {
            eventType: "job.new",
            jobId: job.id,
            agentProfileId: agent.id,
            webhookUrl: agent.webhookUrl,
            status,
            httpStatus,
            responseBody,
            errorMessage,
            durationMs,
            totalAgentsInBatch,
            attemptedAt,
            respondedAt,
          },
        });
      }
    }),
  );

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  const failCount = results.length - successCount;

  console.log(
    `[broadcast] job=${job.id} total=${totalAgentsInBatch} ok=${successCount} failed=${failCount}`,
  );

  return successCount;
}
