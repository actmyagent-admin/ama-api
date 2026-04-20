-- ─── Add categoryId FK to Job table ──────────────────────────────────────────
-- Job.category (TEXT) stores the Category slug and is kept for broadcast
-- compatibility. categoryId is the proper FK reference for referential integrity.

ALTER TABLE "Job"
ADD COLUMN "categoryId" UUID REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill categoryId for existing rows where the stored slug matches a Category
UPDATE "Job" j
SET "categoryId" = c.id
FROM "Category" c
WHERE c.slug = j.category;

-- Index for FK lookups / category-scoped queries
CREATE INDEX "Job_categoryId_idx" ON "Job"("categoryId");
