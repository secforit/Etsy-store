-- 002_orchestrator.sql — orchestrator additions. Runs on Postgres 16+ and on PGlite.
-- OWNER: orchestrator builder. Never edit 001_init.sql; add 003_*.sql for later changes.

-- Every product state change (who, which event, which job). Source of the daily draft count and the desk history.
CREATE TABLE product_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  event text NOT NULL,
  actor text NOT NULL,
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_events_product_idx ON product_events (product_id, created_at);
CREATE INDEX product_events_to_state_idx ON product_events (to_state, created_at);

-- Razvan's rejection reasons. The latest 20 active rules feed the Designer and the Listing Writer.
CREATE TABLE avoid_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 500),
  source_product_id uuid REFERENCES products(id),
  actor text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avoid_rules_active_created_idx ON avoid_rules (created_at DESC) WHERE active;

-- Printify blueprint / print provider pinned by `setup-catalog` (SHOP.products ids are the fallback).
CREATE TABLE printify_catalog (
  product_type text PRIMARY KEY CHECK (product_type IN ('tshirt', 'mug', 'poster')),
  blueprint_id int NOT NULL CHECK (blueprint_id > 0),
  print_provider_id int NOT NULL CHECK (print_provider_id > 0),
  details jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The weekly report is refreshed during the week; keep when it was last written.
ALTER TABLE weekly_reports ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS jobs_running_locked_idx ON jobs (locked_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_product_idx ON jobs (product_id);
CREATE INDEX IF NOT EXISTS jobs_kind_status_idx ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS agent_runs_job_idx ON agent_runs (job_id);
CREATE INDEX IF NOT EXISTS approvals_decided_idx ON approvals (decided_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS metrics_daily_date_idx ON metrics_daily (date);
CREATE INDEX IF NOT EXISTS products_niche_idx ON products (niche_id);
