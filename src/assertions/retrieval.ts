import type { Assertion, AssertionContext, AssertionResult, RetrievalConfig } from '../types.js'

/**
 * Retrieval quality — the half of a RAG system `grounded` cannot see.
 *
 * `grounded` asks whether the answer was entitled to its claims *given what the
 * model was handed*. A retriever that surfaces the wrong chunk and a generator
 * that faithfully summarizes it produce a perfectly grounded wrong answer. These
 * two assertions score the retrieval itself, and they do it deterministically:
 * the labelling is `expectedDocs` in the suite, so no judge is involved, nothing
 * is billed, and the result is reproducible.
 *
 * Both refuse to fall back to the case's declared `input.context`. That context
 * is what the suite *guessed* the retriever would return; scoring a retriever
 * against a guess that was written to describe it is a tautology that reports
 * 1.00 forever. See SPEC.md § grounded for the same reasoning applied upstream.
 */

function resolve(
  ctx: AssertionContext,
  config: RetrievalConfig | undefined,
  type: string,
): { expected: string[]; retrieved: string[] } {
  const expected = config?.expectedDocs ?? ctx.case.expectedDocs
  if (!expected || expected.length === 0) {
    throw new Error(
      `${type}: case "${ctx.case.id}" needs expectedDocs — the ids a correct retrieval must surface`,
    )
  }

  if (!ctx.retrieved) {
    throw new Error(
      `${type}: case "${ctx.case.id}" has no retrieved documents — the system under test must ` +
        'return { output, retrieved } for retrieval to be measurable',
    )
  }

  const k = config?.k
  if (k !== undefined && (!Number.isInteger(k) || k < 1)) {
    throw new Error(`${type}: k must be an integer >= 1, got ${k}`)
  }

  const ids = ctx.retrieved.map(d => d.id)
  return { expected: [...new Set(expected)], retrieved: k === undefined ? ids : ids.slice(0, k) }
}

const atK = (k?: number) => (k === undefined ? '' : `@${k}`)

/**
 * Did the retriever surface the documents that hold the answer?
 *
 * The single highest-value retrieval check and it costs nothing to run. A
 * regression here is invisible to every other assertion in the library: the
 * generator will keep producing fluent, well-grounded answers from whatever it
 * was handed.
 */
export const contextRecall: Assertion<RetrievalConfig> = {
  type: 'contextRecall',
  cost: 'free',

  async evaluate(config, ctx): Promise<AssertionResult> {
    const { expected, retrieved } = resolve(ctx, config, 'contextRecall')
    const found = new Set(retrieved)
    const missing = expected.filter(id => !found.has(id))
    const hits = expected.length - missing.length

    return {
      score: hits / expected.length,
      explanation:
        missing.length === 0
          ? `all ${expected.length} expected documents retrieved${atK(config?.k)}`
          : `${hits}/${expected.length} expected documents retrieved${atK(config?.k)} — missing ${missing.join(', ')}`,
      meta: { expected, retrieved, missing },
    }
  },
}

/**
 * What fraction of what came back was actually wanted?
 *
 * Catches the failure that has no symptom until the invoice arrives: widening
 * top-k until recall looks good, and paying for the extra chunks on every
 * request forever. Low precision also degrades the generator — the relevant
 * passage is still in there, buried.
 *
 * Scores against the `expectedDocs` labelling, so a retrieved document that is
 * genuinely useful but unlabelled counts against the score. That is a real
 * limitation and the reason to label a case's relevant set completely rather
 * than listing only the one document you had in mind.
 */
export const contextPrecision: Assertion<RetrievalConfig> = {
  type: 'contextPrecision',
  cost: 'free',

  async evaluate(config, ctx): Promise<AssertionResult> {
    const { expected, retrieved } = resolve(ctx, config, 'contextPrecision')

    // Retrieving nothing is a retrieval failure, not perfect precision. The
    // vacuous-truth reading (no irrelevant documents were returned!) scores a
    // dead retriever 1.00 — exactly the kind of green this tool must never show.
    if (retrieved.length === 0) {
      return {
        score: 0,
        explanation: 'nothing was retrieved',
        meta: { expected, retrieved: [], extra: [] },
      }
    }

    const wanted = new Set(expected)
    const extra = retrieved.filter(id => !wanted.has(id))
    const hits = retrieved.length - extra.length

    return {
      score: hits / retrieved.length,
      explanation:
        extra.length === 0
          ? `all ${retrieved.length} retrieved documents were expected${atK(config?.k)}`
          : `${hits}/${retrieved.length} retrieved documents were expected${atK(config?.k)} — ` +
            `${extra.length} unlabelled: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`,
      meta: { expected, retrieved, extra },
    }
  },
}
