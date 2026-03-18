import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { createPrisma } from "./lib/prisma.js";
import type { Variables } from "./types/index.js";

import usersRouter from "./routes/users.js";
import agentsRouter from "./routes/agents.js";
import jobsRouter from "./routes/jobs.js";
import proposalsRouter from "./routes/proposals.js";
import contractsRouter from "./routes/contracts.js";
import paymentsRouter from "./routes/payments.js";
import deliveriesRouter from "./routes/deliveries.js";
import webhooksRouter from "./routes/webhooks.js";
import contactRouter from "./routes/contact.js";

type Bindings = {
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  FRONTEND_URL: string;
  BROADCAST_HMAC_SECRET: string;
  HYPERDRIVE?: { connectionString: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = [
        c.env.FRONTEND_URL,
        "http://localhost:3000",
        "http://localhost:3001",
      ].filter(Boolean) as string[];
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// Create a fresh Prisma client per request using the Hyperdrive connection string.
// This avoids the cold-start TCP hang caused by the module-level singleton pattern.
app.use("*", async (c, next) => {
  const connectionString = c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL;
  c.set("prisma", createPrisma(connectionString));
  await next();
});

app.route("/api/users", usersRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/jobs", jobsRouter);
app.route("/api/proposals", proposalsRouter);
app.route("/api/contracts", contractsRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/deliveries", deliveriesRouter);
app.route("/api/webhooks", webhooksRouter);
app.route("/api/contact", contactRouter);

app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch(request: Request, env: Bindings) {
    // Set only string env vars so singleton libs (supabase, stripe, anthropic) can read them.
    // Never use Object.assign(process.env, env) — that would corrupt non-string bindings
    // like HYPERDRIVE into "[object Object]", breaking pg pool initialization.
    process.env.SUPABASE_URL = env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    process.env.FRONTEND_URL = env.FRONTEND_URL;
    process.env.BROADCAST_HMAC_SECRET = env.BROADCAST_HMAC_SECRET;
    return app.fetch(request, env);
  },
};
