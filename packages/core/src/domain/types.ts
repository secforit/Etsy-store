/**
 * Domain types shared by every part of the system.
 * CONTRACT FILE: owned by the foundation. Builders may ADD types, never change existing ones.
 */

export const PRODUCT_TYPES = ['tshirt', 'mug', 'poster'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** Every design idea is one row in `products`; `state` is the single source of truth. */
export const PRODUCT_STATES = [
  'proposed', // Niche Validator created it
  'cleared', // concept compliance passed
  'designed', // Designer made raw art; WAITING for Razvan's edited file
  'edited', // Razvan uploaded his edited design
  'written', // Listing Writer produced copy
  'final_cleared', // final compliance passed
  'drafted', // QA passed; Printify created the Etsy draft; WAITING for approval
  'live', // Razvan approved; listing active on Etsy
  'retired', // Analyst stopped renewal
  'blocked', // stop state: compliance or repeated QA failure
  'rejected', // stop state: Razvan rejected the draft
] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

/** Automated steps run by the orchestrator. Human steps are not jobs. */
export const JOB_KINDS = [
  'trend_scan', // Trend Scout: gather signals + write niches
  'validate_niche', // Niche Validator: niche -> 0..3 proposed products
  'concept_check', // Compliance Guard (concept): proposed -> cleared | blocked
  'design', // Designer: cleared -> designed
  'write', // Listing Writer: edited -> written
  'final_check', // Compliance Guard (final): written -> final_cleared | blocked
  'qa_publish', // QA & Publisher: final_cleared -> drafted | designed | blocked
  'analyze', // Analyst: metrics pull, retire, weekly report
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export const AGENT_NAMES = [
  'trend_scout',
  'niche_validator',
  'compliance_guard',
  'designer',
  'listing_writer',
  'qa_publisher',
  'analyst',
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export type ComplianceStage = 'concept' | 'final';
export type Verdict = 'pass' | 'block';

export interface Settings {
  paused: boolean;
  dailyDraftCap: number;
  dailySpendCapUsd: number;
  blocklist: string[];
  updatedAt: string;
}

export interface TrendSignal {
  id: string;
  source: string; // 'etsy_search' | 'pinterest' | 'seasonal' | ...
  keyword: string;
  region: string; // 'US'
  score: number; // 0..100, relative within its source
  growth: number | null; // fractional growth, e.g. 0.35 = +35%
  fetchedAt: string;
}

export interface Niche {
  id: string;
  keywords: string[];
  theme: string;
  brief: string;
  season: string | null;
  status: 'new' | 'accepted' | 'rejected';
  score: number | null;
  reasoning: string | null;
  sourceSignalIds: string[];
  createdAt: string;
}

export interface Product {
  id: string;
  nicheId: string;
  productType: ProductType;
  conceptTitle: string;
  designPhrase: string | null; // words printed on the product, if any
  styleNotes: string;
  targetPriceEur: number;
  state: ProductState;
  blockReason: string | null;
  attempt: number; // QA redesign attempts used
  createdAt: string;
  updatedAt: string;
}

export interface TrademarkHit {
  mark: string;
  serial: string;
  status: 'live' | 'dead';
  classes: number[]; // Nice classes
  owner: string | null;
}

export interface ComplianceCheck {
  id: string;
  productId: string;
  stage: ComplianceStage;
  verdict: Verdict;
  reasons: string[];
  flaggedTerms: string[];
  trademarkHits: TrademarkHit[];
  createdAt: string;
}

export interface Design {
  id: string;
  productId: string;
  prompt: string;
  model: string;
  seed: number | null;
  artKey: string; // raw AI art in blob storage
  editedKey: string | null; // Razvan's edited file
  printKey: string | null; // print-ready file prepared by QA
  qaNotes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Listing {
  id: string;
  productId: string;
  title: string;
  tags: string[];
  description: string;
  priceEur: number;
  printifyProductId: string | null;
  etsyListingId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  productId: string;
  decision: 'approve' | 'reject';
  reason: string | null;
  actor: string;
  decidedAt: string;
}

export interface MetricDaily {
  etsyListingId: number;
  date: string; // YYYY-MM-DD
  views: number;
  favorites: number;
  orders: number;
  revenueEur: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  productId: string | null;
  nicheId: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  jobId: string | null;
  agent: AgentName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string; // 'system' | 'razvan' | agent name
  action: string;
  entity: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
