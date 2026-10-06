-- 001_init.sql — runs on Postgres 16+ and on PGlite (tests / mock mode).
-- CONTRACT FILE: owned by the foundation. Add new migrations as 002_*.sql; never edit this one.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused boolean NOT NULL DEFAULT false,
  daily_draft_cap int NOT NULL DEFAULT 5 CHECK (daily_draft_cap BETWEEN 0 AND 100),
  daily_spend_cap_usd numeric(10,2) NOT NULL DEFAULT 10 CHECK (daily_spend_cap_usd >= 0),
  blocklist text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE trend_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  keyword text NOT NULL,
  region text NOT NULL DEFAULT 'US',
  score numeric(6,2) NOT NULL,
  growth numeric(8,4),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_signals_fetched_idx ON trend_signals (fetched_at DESC);

CREATE TABLE niches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keywords text[] NOT NULL,
  theme text NOT NULL,
  brief text NOT NULL,
  season text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'rejected')),
  score int CHECK (score BETWEEN 0 AND 100),
  reasoning text,
  source_signal_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche_id uuid NOT NULL REFERENCES niches(id),
  product_type text NOT NULL CHECK (product_type IN ('tshirt', 'mug', 'poster')),
  concept_title text NOT NULL,
  design_phrase text,
  style_notes text NOT NULL DEFAULT '',
  target_price_eur numeric(10,2) NOT NULL CHECK (target_price_eur > 0),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN (
    'proposed', 'cleared', 'designed', 'edited', 'written', 'final_cleared',
    'drafted', 'live', 'retired', 'blocked', 'rejected')),
  block_reason text,
  attempt int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_state_idx ON products (state);

CREATE TABLE compliance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  stage text NOT NULL CHECK (stage IN ('concept', 'final')),
  verdict text NOT NULL CHECK (verdict IN ('pass', 'block')),
  reasons jsonb NOT NULL DEFAULT '[]',
  flagged_terms text[] NOT NULL DEFAULT '{}',
  trademark_hits jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_checks_product_idx ON compliance_checks (product_id);

CREATE TABLE designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id),
  prompt text NOT NULL,
  model text NOT NULL,
  seed bigint,
  art_key text NOT NULL,
  edited_key text,
  print_key text,
  qa_notes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id),
  title text NOT NULL CHECK (char_length(title) <= 140),
  tags text[] NOT NULL CHECK (cardinality(tags) <= 13),
  description text NOT NULL,
  price_eur numeric(10,2) NOT NULL CHECK (price_eur > 0),
  printify_product_id text UNIQUE,
  etsy_listing_id bigint UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text,
  actor text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metrics_daily (
  etsy_listing_id bigint NOT NULL,
  date date NOT NULL,
  views int NOT NULL DEFAULT 0,
  favorites int NOT NULL DEFAULT 0,
  orders int NOT NULL DEFAULT 0,
  revenue_eur numeric(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (etsy_listing_id, date)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'trend_scan', 'validate_niche', 'concept_check', 'design', 'write',
    'final_check', 'qa_publish', 'analyze')),
  product_id uuid REFERENCES products(id),
  niche_id uuid REFERENCES niches(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_after);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES jobs(id),
  agent text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  ok boolean NOT NULL,
  error text,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_created_idx ON agent_runs (created_at DESC);

CREATE TABLE weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
