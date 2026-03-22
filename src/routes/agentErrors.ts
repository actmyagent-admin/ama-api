import { Hono } from "hono";
import { z } from "zod";
import { combinedAuthMiddleware } from "../middleware/combinedAuth.js";
import type { Variables } from "../types/index.js";

const agentErrors = new Hono<{ Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /api/agent-errors
// AI agents report errors they encounter while interacting with the platform.
//
// Auth: API key only (x-api-key: sk_act_...).
// Browser users cannot post to this endpoint.
//
// Use cases:
//   • Agent received our job-broadcast webhook but failed to process it
//   • Agent tried to submit a proposal and our API returned an error
//   • Agent tried to send a message and got a network timeout
//   • Agent failed to parse a contract payload we sent
// ---------------------------------------------------------------------------
const errorSchema = z.object({
  // Where in the agent<>platform workflow did the error occur?
  step: z.enum([
    "JOB_RECEIVED",
    "MESSAGE_RECEIVED",
    "PROPOSAL_SUBMISSION",
    "MESSAGE_SEND",
    "CONTRACT_REVIEW",
    "DELIVERY_SUBMISSION",
    "AUTHENTICATION",
    "OTHER",
  ]),
  // Human-readable explanation of what went wrong (required)
  errorMessage: z.string().min(1).max(2000).trim(),
  // Short machine-readable code the agent assigns, e.g. "TIMEOUT", "HTTP_500"
  errorCode: z.string().max(100).trim().optional(),
  // HTTP status code the agent received from our API, when applicable
  httpStatus: z.number().int().min(100).max(599).optional(),
  // The payload the agent was trying to send (will be stored as-is)
  requestPayload: z.record(z.unknown()).optional(),
  // Raw response body or error object the agent received
  responseBody: z.string().max(5000).optional(),
  // Context — which job/proposal/contract was being worked on
  jobId: z.string().uuid().optional(),
  proposalId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  // Any extra diagnostic data that doesn't fit above fields
  metadata: z.record(z.unknown()).optional(),
});

agentErrors.post("/", combinedAuthMiddleware, async (c) => {
  const agentProfile = c.get("agentProfile");

  // This endpoint is exclusively for AI agents; browser JWT sessions are rejected
  if (!agentProfile) {
    return c.json(
      { error: "This endpoint requires an agent API key, not a user JWT" },
      403,
    );
  }

  let body: z.infer<typeof errorSchema>;
  try {
    body = errorSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid request body", details: err }, 400);
  }

  const prisma = c.get("prisma");

  // Verify that the referenced job/proposal/contract IDs actually exist and
  // belong to this agent, to prevent agents from polluting each other's logs.
  if (body.jobId) {
    const job = await prisma.job.findUnique({ where: { id: body.jobId } });
    if (!job) return c.json({ error: "jobId not found" }, 404);
  }

  if (body.proposalId) {
    const proposal = await prisma.proposal.findUnique({
      where: { id: body.proposalId, agentProfileId: agentProfile.id },
    });
    if (!proposal)
      return c.json(
        { error: "proposalId not found or does not belong to this agent" },
        404,
      );
  }

  if (body.contractId) {
    const contract = await prisma.contract.findUnique({
      where: { id: body.contractId, agentProfileId: agentProfile.id },
    });
    if (!contract)
      return c.json(
        { error: "contractId not found or does not belong to this agent" },
        404,
      );
  }

  const log = await prisma.agentErrorLog.create({
    data: {
      agentProfileId: agentProfile.id,
      step: body.step,
      errorMessage: body.errorMessage,
      errorCode: body.errorCode,
      httpStatus: body.httpStatus,
      requestPayload: body.requestPayload,
      responseBody: body.responseBody,
      jobId: body.jobId,
      proposalId: body.proposalId,
      contractId: body.contractId,
      metadata: body.metadata,
    },
  });

  return c.json({ id: log.id, createdAt: log.createdAt }, 201);
});

export default agentErrors;
