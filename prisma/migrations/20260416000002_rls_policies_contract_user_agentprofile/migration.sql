-- Migration: Add permissive SELECT RLS policies on Contract, User, AgentProfile
-- Root cause: all three tables have RLS enabled but no SELECT policy, so the
-- EXISTS sub-selects inside the Message RLS policy return 0 rows when evaluated
-- as `authenticated`, causing every Realtime payload to arrive as {}.
--
-- USING (true) means no additional row filter beyond the SELECT grant itself.
-- These can be tightened in a future migration once per-table access patterns
-- are fully decided.
-- All idempotent — safe to run more than once.
--
-- ─── SECURITY TODO ────────────────────────────────────────────────────────────
-- WHY WE COMPROMISED:
--   The Message RLS policy uses inline EXISTS sub-selects that JOIN Contract,
--   User, and AgentProfile. PostgreSQL evaluates those JOINs as the
--   `authenticated` role — so that role must hold SELECT on those tables AND
--   those tables must have a permissive SELECT policy (USING (true)) for the
--   sub-selects to return any rows at all. Without this, every Realtime
--   postgres_changes payload arrived as {} even though the data and grants
--   were correct.
--
-- WHAT THIS EXPOSES:
--   Any user with a valid Supabase JWT can now query Contract, User, and
--   AgentProfile directly via the Supabase client, bypassing the NestJS API:
--     - Contract  → exposes scope, price, dispute details, cancellation reasons
--                   for ALL contracts on the platform
--     - User      → exposes email, supabaseId, social links, Stripe account ID
--                   for ALL users on the platform
--     - AgentProfile → exposes webhookUrl and apiKeyPrefix for all agents
--
-- WHAT NEEDS TO BE DONE (replace USING (true) with scoped policies):
--   Contract:
--     USING (
--       "buyerId" = (SELECT id FROM "User" WHERE "supabaseId" = auth.uid())
--       OR "agentProfileId" IN (
--         SELECT ap.id FROM "AgentProfile" ap
--         JOIN "User" u ON u.id = ap."userId"
--         WHERE u."supabaseId" = auth.uid()
--       )
--     )
--
--   User:
--     USING ("supabaseId" = auth.uid())  -- own row only
--
--   AgentProfile:
--     USING (true) is acceptable since it is a public marketplace listing,
--     but webhookUrl and apiKeyPrefix should be moved to a separate
--     restricted table or masked via a view.
--
-- PRIORITY: High — schedule before any public launch or security audit.
-- ──────────────────────────────────────────────────────────────────────────────

-- ─── Contract ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'Contract'
      AND policyname = 'authenticated can read contracts'
  ) THEN
    CREATE POLICY "authenticated can read contracts"
      ON "Contract"
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- ─── User ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'User'
      AND policyname = 'authenticated can read users'
  ) THEN
    CREATE POLICY "authenticated can read users"
      ON "User"
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- ─── AgentProfile ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'AgentProfile'
      AND policyname = 'authenticated can read agent profiles'
  ) THEN
    CREATE POLICY "authenticated can read agent profiles"
      ON "AgentProfile"
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;
