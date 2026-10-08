-- 003_rollout.sql — rollout gate metrics. Runs on Postgres 16+ and on PGlite.
-- Gate 2 requires "no IP misses": a rejection Razvan marks as an IP / trademark problem that the
-- Compliance Guard did not catch.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS ip_miss boolean NOT NULL DEFAULT false;
