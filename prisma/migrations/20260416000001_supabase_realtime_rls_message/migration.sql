-- Migration: Supabase Realtime + RLS for the Message table
-- All idempotent — safe to run more than once.

-- ─── 1. Schema-level grants ──────────────────────────────────────────────────
-- Without USAGE on public the authenticated role cannot see any tables at all.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;

-- ─── 2. Table-level SELECT grants ────────────────────────────────────────────
-- Supabase Realtime evaluates RLS policies as the `authenticated` role.
-- The inline EXISTS policy (step 5) JOINs Contract / User / AgentProfile,
-- so `authenticated` must hold SELECT on all four tables — otherwise
-- PostgreSQL raises "permission denied for table User/Contract/AgentProfile"
-- and every Realtime payload arrives as {}.
--
-- NOTE: Contract / User / AgentProfile do not yet have RLS enabled, which means
-- any authenticated Supabase client can SELECT all rows from them directly.
-- Those tables should have their own RLS policies added in a future migration
-- once the access patterns for each are decided.
GRANT SELECT ON "Message"      TO authenticated;
GRANT SELECT ON "Contract"     TO authenticated;
GRANT SELECT ON "User"         TO authenticated;
GRANT SELECT ON "AgentProfile" TO authenticated;

-- ─── 3. Enable Row Level Security on Message ─────────────────────────────────
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;

-- ─── 4. RLS SELECT policy — contract parties only ────────────────────────────
-- Allows a row when auth.uid() matches the supabaseId of either:
--   a) the buyer on the related Contract, OR
--   b) the owner of the AgentProfile on the related Contract.
-- Inline EXISTS is used (not a helper function) because a SECURITY DEFINER
-- function only elevates to the privilege level of its owner; the Prisma
-- migration role does not have SELECT on these tables, so the function
-- would fail with the same permission error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'Message'
      AND policyname = 'contract parties can read messages'
  ) THEN
    CREATE POLICY "contract parties can read messages"
      ON "Message"
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM   "Contract" c
          JOIN   "User"     u  ON u.id = c."buyerId"
          WHERE  c.id           = "Message"."contractId"
            AND  u."supabaseId" = auth.uid()
        )
        OR
        EXISTS (
          SELECT 1
          FROM   "Contract"     c
          JOIN   "AgentProfile" ap ON ap.id = c."agentProfileId"
          JOIN   "User"         u  ON u.id  = ap."userId"
          WHERE  c.id           = "Message"."contractId"
            AND  u."supabaseId" = auth.uid()
        )
      );
  END IF;
END $$;

-- ─── 5. Add Message to the Supabase Realtime publication ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_publication_tables
    WHERE  pubname    = 'supabase_realtime'
      AND  schemaname = 'public'
      AND  tablename  = 'Message'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "Message";
  END IF;
END $$;
