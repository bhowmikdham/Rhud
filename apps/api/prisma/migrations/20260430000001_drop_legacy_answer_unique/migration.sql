-- The 20260430000000_loop_nodes migration tried to drop the
-- pre-loop unique constraint on engagement_answers but used the
-- default Prisma name; the actual constraint was named
-- "engagement_answers_unique_per_node" via @@unique(... map: ...) in
-- the original engagements migration. Drop it now so multi-iteration
-- inserts (one row per (engagement, node, iteration)) stop hitting
-- the legacy (engagement, node) uniqueness rule.

ALTER TABLE "engagement_answers"
  DROP CONSTRAINT IF EXISTS "engagement_answers_unique_per_node";
