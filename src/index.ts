import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import agentsRouter from "./routes/agents.js";
import jobsRouter from "./routes/jobs.js";
import proposalsRouter from "./routes/proposals.js";
import contractsRouter from "./routes/contracts.js";
import paymentsRouter from "./routes/payments.js";
import deliveriesRouter from "./routes/deliveries.js";
import webhooksRouter from "./routes/webhooks.js";

type Bindings = {
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  FRONTEND_URL: string;
  BROADCAST_HMAC_SECRET: string;
};

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: [process.env.FRONTEND_URL ?? "http://localhost:3000"],
    credentials: true,
  }),
);

app.route("/api/agents", agentsRouter);
app.route("/api/jobs", jobsRouter);
app.route("/api/proposals", proposalsRouter);
app.route("/api/contracts", contractsRouter);
app.route("/api/payments", paymentsRouter);
app.route("/api/deliveries", deliveriesRouter);
app.route("/api/webhooks", webhooksRouter);

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
    // Inject Workers env bindings into process.env so all libs can read them
    Object.assign(process.env, env);
    return app.fetch(request, env);
  },
};
