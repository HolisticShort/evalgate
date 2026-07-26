import type {
  Assertion,
  AssertionContext,
  AssertionResult,
  Claim,
  ClaimType,
  ClaimVerdict,
  GroundedConfig,
  GroundedMeta,
  SourceDocument,
} from '../types.js'

/**
 * `grounded` — is the output entitled to its claims?
 *
 * Pipeline: extract atomic claims → attribute each against the source documents
 * → score what survives. See SPEC.md § grounded.
 *
 * Requires a judge provider. Fails loudly rather than degrading to a keyword
 * heuristic — a grounding score produced by string matching is worse than no
 * grounding score, because people will believe it.
 */
export const grounded: Assertion<GroundedConfig> = {
  type: 'grounded',
  cost: 'expensive',

  async evaluate(config, ctx): Promise<AssertionResult> {
    if (!ctx.judge) {
      throw new Error('grounded requires a judge provider — see SPEC.md § Who judges the judge')
    }

    const sources = config?.sources ?? ctx.case.input.context ?? []
    if (sources.length === 0) {
      throw new Error(`grounded: case "${ctx.case.id}" has no source documents to attribute against`)
    }

    const output = typeof ctx.output === 'string' ? ctx.output : JSON.stringify(ctx.output, null, 2)

    const claims = await extractClaims(output, config ?? {}, ctx)
    const kept = filterClaims(claims, config ?? {})
    const verdicts = kept.length === 0 ? [] : await attribute(kept, sources, ctx)

    return score(verdicts, config ?? {})
  },
}

// ---------------------------------------------------------------------------
// Step 1 — extraction
// ---------------------------------------------------------------------------

const DEFAULT_CLAIM_TYPES: ClaimType[] = ['factual', 'numeric', 'causal', 'temporal']

const CLAIMS_SCHEMA = {
  type: 'object',
  required: ['claims'],
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'type', 'hedged'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['factual', 'numeric', 'causal', 'temporal'] },
          hedged: { type: 'boolean' },
        },
      },
    },
  },
}

/**
 * Decompose output into atomic factual claims.
 *
 * The hard part of this whole assertion. Too coarse and grounding scores are
 * meaningless; too fine and every subordinate clause becomes a claim and the
 * score is noise. "Revenue grew 12% because the new market opened" is two
 * claims, and the causal one carries a different evidentiary standard than the
 * numeric one — so they are extracted separately and typed.
 *
 * Opinions, questions, meta-commentary, and text quoted from the user are
 * excluded here rather than filtered later, because a model that says
 * "I don't have that information" must not be penalized for it.
 *
 * OPEN QUESTION (SPEC.md § Open questions #1): the granularity instruction below
 * is unvalidated against real output at scale.
 */
async function extractClaims(
  output: string,
  _config: GroundedConfig,
  ctx: AssertionContext,
): Promise<Claim[]> {
  const prompt = [
    'Decompose the text below into atomic factual claims.',
    '',
    'RULES:',
    '- One claim per assertion. Split compound sentences.',
    '  "Revenue grew 12% because the new market opened" is TWO claims:',
    '  a numeric claim about growth, and a causal claim about the reason.',
    '- Do NOT extract: opinions, questions, greetings, offers to help,',
    '  meta-commentary about the assistant itself, or text quoted from the user.',
    '- A refusal or a statement of not knowing is NOT a claim. Return no claims for it.',
    '- Mark `hedged: true` for anything qualified ("may", "might", "typically",',
    '  "I believe"). Hedged claims are still extracted; the caller decides.',
    '- Type each claim: factual | numeric | causal | temporal.',
    '- Preserve the original wording. Do not paraphrase or repair.',
    '',
    'TEXT:',
    output,
  ].join('\n')

  const result = await ctx.judge!.judge<{ claims: Claim[] }>(prompt, CLAIMS_SCHEMA)
  return result.claims ?? []
}

function filterClaims(claims: Claim[], config: GroundedConfig): Claim[] {
  const allowed = new Set(config.claimTypes ?? DEFAULT_CLAIM_TYPES)
  const ignoreHedged = config.ignoreHedged ?? true
  return claims.filter(c => allowed.has(c.type) && !(ignoreHedged && c.hedged))
}

// ---------------------------------------------------------------------------
// Step 2 — attribution
// ---------------------------------------------------------------------------

const ATTRIBUTION_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claimIndex', 'status', 'evidence', 'reasoning'],
        additionalProperties: false,
        properties: {
          claimIndex: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['supported', 'unsupported', 'contradicted'] },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              required: ['docId', 'span'],
              additionalProperties: false,
              properties: { docId: { type: 'string' }, span: { type: 'string' } },
            },
          },
          reasoning: { type: 'string', minLength: 1 },
        },
      },
    },
  },
}

interface RawVerdict {
  claimIndex: number
  status: ClaimVerdict['status']
  evidence: { docId: string; span: string }[]
  reasoning: string
}

/**
 * Attribute every claim against the sources in a single judge call.
 *
 * One call rather than one-per-claim: attribution decisions are not independent
 * — a source span that supports claim 3 often bears on claim 5 — and per-claim
 * calls multiply cost by claim count on the most expensive assertion in the
 * library. See SPEC.md § Caching for why cost is a design constraint.
 *
 * `unsupported` (nothing entails it) and `contradicted` (a source says
 * otherwise) are separate statuses because they are different bugs: a gap
 * versus a lie.
 */
async function attribute(
  claims: Claim[],
  sources: SourceDocument[],
  ctx: AssertionContext,
): Promise<ClaimVerdict[]> {
  const prompt = [
    'Determine whether each claim is supported by the source documents.',
    '',
    'STATUS:',
    '- supported:    a span in the sources entails the claim.',
    '- unsupported:  nothing in the sources entails it. Plausible is not supported.',
    '- contradicted: a span in the sources states otherwise.',
    '',
    'RULES:',
    '- Use ONLY the sources. Do not use outside knowledge, however obvious.',
    '- Quote the exact span you relied on. Do not paraphrase evidence.',
    '- A claim that is merely consistent with the sources but not stated by them',
    '  is unsupported, not supported.',
    '- Return exactly one verdict per claim, referencing its index.',
    '',
    'SOURCES:',
    ...sources.map(d => `[${d.id}]\n${d.text}`),
    '',
    'CLAIMS:',
    ...claims.map((c, i) => `${i}. (${c.type}) ${c.text}`),
  ].join('\n')

  const result = await ctx.judge!.judge<{ verdicts: RawVerdict[] }>(prompt, ATTRIBUTION_SCHEMA)
  const byIndex = new Map(result.verdicts.map(v => [v.claimIndex, v]))

  // A claim the judge silently dropped must not vanish from the denominator —
  // that would let an unreliable judge inflate the score by answering less.
  return claims.map((claim, i) => {
    const v = byIndex.get(i)
    if (!v) {
      return {
        claim,
        status: 'unsupported' as const,
        evidence: [],
        reasoning: 'judge returned no verdict for this claim',
      }
    }
    return { claim, status: v.status, evidence: v.evidence ?? [], reasoning: v.reasoning }
  })
}

// ---------------------------------------------------------------------------
// Step 3 — scoring
// ---------------------------------------------------------------------------

/**
 *   score = supported / (supported + unsupported + contradicted)
 *
 * With `contradictionIsCritical`, a single contradiction fails the case
 * outright regardless of score. One fabricated fact usually matters more than
 * ten omissions.
 */
export function score(verdicts: ClaimVerdict[], config: GroundedConfig): AssertionResult {
  const supported = verdicts.filter(v => v.status === 'supported').length
  const unsupported = verdicts.filter(v => v.status === 'unsupported').length
  const contradicted = verdicts.filter(v => v.status === 'contradicted').length
  const total = supported + unsupported + contradicted

  // No checkable claims is not a failure. A response that correctly declines to
  // assert anything ("I don't have information on that") is the right behavior,
  // and scoring it 0 would train the suite to punish honest refusals.
  if (total === 0) {
    return { score: 1, explanation: 'no checkable factual claims in output' }
  }

  const meta: GroundedMeta = { claims: verdicts, supported, unsupported, contradicted }
  const critical = Boolean(config.contradictionIsCritical && contradicted > 0)

  return {
    score: supported / total,
    explanation:
      `${supported}/${total} claims supported` +
      (contradicted > 0 ? ` · ${contradicted} contradicted` : '') +
      (unsupported > 0 ? ` · ${unsupported} unsupported` : ''),
    meta,
    ...(critical ? { critical: true } : {}),
  }
}
