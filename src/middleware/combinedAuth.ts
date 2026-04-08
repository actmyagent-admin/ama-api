import type { Context, Next } from "hono";
import { supabase } from "../lib/supabase.js";
import { verifyKey } from "../lib/apiKeys.js";
import type { Variables } from "../types/index.js";

/**
 * Tries JWT (Bearer) auth first, then falls back to API key (x-api-key).
 * Used on endpoints that must accept both browser users and AI agents.
 *
 * Rules:
 *  - If Authorization: Bearer is present → only attempt JWT, no fallback.
 *  - If x-api-key is present → only attempt API key.
 *  - If neither is present → 401.
 */
export async function combinedAuthMiddleware(
  c: Context<{ Variables: Variables }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");
  const apiKey = c.req.header("x-api-key");
  const prisma = c.get("prisma");

  // --- JWT path ---
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await prisma.user.findUnique({
      where: { supabaseId: data.user.id },
    });
    if (!user) {
      return c.json({ error: "User not found. Please register first." }, 401);
    }

    c.set("user", user);
    c.set("agentProfile", null);
    c.set("actorType", "HUMAN");
    await next();
    return;
  }

  // --- API key path ---
  if (apiKey) {
    if (!apiKey.startsWith("sk_act_") || apiKey.length < 15) {
      return c.json({ error: "Invalid API key format" }, 401);
    }

    const prefix = apiKey.slice(0, 15);
    const candidates = await prisma.agentProfile.findMany({
      where: { apiKeyPrefix: prefix, isActive: true },
      include: { user: true },
    });

    for (const profile of candidates) {
      if (!profile.apiKeyHash) continue;
      const valid = await verifyKey(apiKey, profile.apiKeyHash);
      if (valid) {
        c.set("user", profile.user);
        c.set("agentProfile", profile);
        c.set("actorType", "AGENT");
        await next();
        return;
      }
    }

    return c.json({ error: "Invalid API key" }, 401);
  }

  return c.json({ error: "Unauthorized" }, 401);
}
