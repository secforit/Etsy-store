/**
 * MockLlm: deterministic, offline outputs per agent (MODE=mock and the demo). For each agent it tries a short
 * list of candidate outputs built from the request's untrusted data and returns the first one that passes the
 * request's own zod schema, so it keeps working when an agent narrows its schema (e.g. allowed product types).
 * Outputs are realistic enough to drive the full pipeline: niches, accepted products, compliance pass,
 * an image prompt, a listing, a passing mockup check and a weekly report.
 */
import type { AgentName } from '../domain/types.ts';
import type { GpuCoordinator } from '../integrations/types.ts';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './types.ts';

type Data = Record<string, unknown>;

const asObj = (v: unknown): Data => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

function trendScout(data: Data): unknown[] {
  const seen = new Set<string>();
  const picked: { id: string; keyword: string }[] = [];
  for (const s of asArr(data.signals)) {
    const o = asObj(s);
    const keyword = asStr(o.keyword).toLowerCase().trim();
    if (keyword.length < 2 || seen.has(keyword)) continue;
    seen.add(keyword);
    picked.push({ id: asStr(o.id), keyword });
    if (picked.length === 3) break;
  }
  if (picked.length === 0) picked.push({ id: '', keyword: 'retro camping' });
  const niches = picked.map((p) => ({
    theme: titleCase(`${p.keyword.slice(0, 100)} fans`),
    keywords: [p.keyword.slice(0, 60), `${p.keyword.slice(0, 54)} gift`, `funny ${p.keyword.slice(0, 54)}`],
    brief: `People who search for "${p.keyword.slice(0, 60)}" and want an original, bold design for themselves or as a gift.`,
    season: null,
    sourceSignalIds: p.id ? [p.id] : [],
  }));
  return [{ niches }, { niches: niches.slice(0, 1) }, { niches: [] }];
}

function nicheValidator(data: Data): unknown[] {
  const niche = asObj(data.niche);
  const theme = asStr(niche.theme, 'Retro Camping Fans');
  const word = titleCase(firstWords(asStr(asArr(niche.keywords)[0], theme), 2)) || 'Retro';
  const product = (productType: string, i: number) => ({
    productType,
    conceptTitle: `${theme.slice(0, 90)} ${i === 0 ? 'Retro Badge' : 'Minimal Line Art'}`,
    designPhrase: i === 0 ? `${word.slice(0, 60)} Club` : null,
    styleNotes: i === 0 ? 'Vintage badge, warm orange and cream, bold outline.' : 'Single-colour line art, lots of empty space.',
    targetPriceEur: productType === 'mug' ? 17.99 : productType === 'poster' ? 21.99 : 24.99,
  });
  const base = {
    decision: 'accept',
    score: 72,
    reasoning: 'Mock evaluation: steady search demand and moderate competition.',
  };
  return [
    { ...base, products: [product('tshirt', 0), product('mug', 1)] },
    { ...base, products: [product('tshirt', 0)] },
    { ...base, products: [product('mug', 0)] },
    { ...base, products: [product('poster', 0)] },
    { ...base, decision: 'reject', score: 30, products: [] },
  ];
}

function designer(data: Data): unknown[] {
  const concept = asStr(data.conceptTitle, 'an original concept');
  const phrase = asStr(data.designPhrase);
  const lettering = phrase ? ` with bold, clear lettering "${phrase}"` : ', no text';
  return [
    {
      prompt: `Flat vector illustration for "${concept.slice(0, 200)}"${lettering}, warm limited palette, centered composition, clean bold shapes`,
      style: 'vector_illustration',
    },
  ];
}

function listingWriter(data: Data, instructions: string): unknown[] {
  const concept = asStr(data.conceptTitle, 'Original Design');
  const keywords = asArr(data.nicheKeywords).map((k) => asStr(k)).filter(Boolean);
  const price = Number(/Target price: ([0-9.]+)/.exec(instructions)?.[1] ?? '24.99');
  const tags = [...keywords, 'graphic tee', 'gift idea', 'retro design', 'unique gift', 'birthday gift', 'gift for friend', 'cute gift', 'original art', 'fun present', 'everyday wear', 'gift for her', 'gift for him', 'cozy vibes'];
  return [
    {
      title: `${concept.slice(0, 80)} - Original Retro Design, Gift Idea`,
      tags: tags.slice(0, 13).map((t) => t.slice(0, 20)),
      description: `${concept} is an original design with a warm retro feel.\n\nA fun gift for friends and family who love ${keywords[0] ?? 'good design'}.`,
      priceEur: Number.isFinite(price) && price > 0 ? price : 24.99,
    },
  ];
}

const CANDIDATES: Record<AgentName, (data: Data, req: LlmRequest<unknown>) => unknown[]> = {
  trend_scout: (d) => trendScout(d),
  niche_validator: (d) => nicheValidator(d),
  compliance_guard: () => [{ verdict: 'pass', reasons: [], flaggedTerms: [] }],
  designer: (d) => designer(d),
  listing_writer: (d, r) => listingWriter(d, r.instructions),
  qa_publisher: () => [{ verdict: 'pass', issues: [] }],
  analyst: () => [
    {
      reportMarkdown:
        '## Summary\nMock report: the shop is running in mock mode.\n\n## What sold\nSee the table above.\n\n## What to make next\nNew designs for the follow-up niches.\n\n## Risks\nNone found in mock mode.',
    },
  ],
};

export class MockLlm implements LlmClient {
  readonly calls: { agent: AgentName; hasImages: boolean }[] = [];

  /**
   * @param gpu optional coordinator: when given (createLlm in MODE=mock), every call runs inside
   *   gpu.withGpu('llm', ...) like OllamaLlm, so mock runs exercise the same GPU serialisation and nesting rules.
   */
  constructor(private readonly gpu: GpuCoordinator | null = null) {}

  generate<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    return this.gpu ? this.gpu.withGpu('llm', () => this.generateNow(req)) : this.generateNow(req);
  }

  private async generateNow<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.calls.push({ agent: req.agent, hasImages: (req.images?.length ?? 0) > 0 });
    const data = asObj(req.untrustedData);
    for (const candidate of CANDIDATES[req.agent](data, req as LlmRequest<unknown>)) {
      const parsed = req.schema.safeParse(candidate);
      if (parsed.success) {
        const promptChars = req.system.length + req.instructions.length + JSON.stringify(req.untrustedData ?? null).length;
        return {
          output: parsed.data,
          usage: {
            model: 'mock-llm',
            inputTokens: Math.ceil(promptChars / 4),
            outputTokens: Math.ceil(JSON.stringify(candidate).length / 4),
            costUsd: 0,
            durationMs: 0,
          },
        };
      }
    }
    throw new LlmError(`MockLlm has no output for agent ${req.agent} that matches the requested schema`, false);
  }
}
