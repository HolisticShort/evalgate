import type { Assertion } from '../types.js'

/**
 * Cosine similarity against a reference answer.
 *
 * Raw cosine is a bad score: unrelated sentences from the same embedding model
 * routinely land around 0.6–0.7, so a naive mapping makes garbage look like a
 * passing grade. `floor` rescales — everything at or below it maps to 0, and
 * the remaining range is stretched across [0,1].
 */
export const semanticSimilarity: Assertion<{ reference?: string; floor?: number }> = {
  type: 'semanticSimilarity',
  cost: 'cheap',
  async evaluate(config, ctx) {
    if (!ctx.embed) throw new Error('semanticSimilarity requires an embedding provider')

    const reference = config?.reference ?? ctx.case.reference
    if (!reference) {
      throw new Error(`semanticSimilarity: case "${ctx.case.id}" has no reference to compare against`)
    }

    const output = typeof ctx.output === 'string' ? ctx.output : JSON.stringify(ctx.output)
    const [a, b] = await ctx.embed.embed([output, reference])
    if (!a || !b) throw new Error('embedding provider returned fewer vectors than requested')

    const raw = cosine(a, b)
    const floor = config?.floor ?? 0.6
    const score = raw <= floor ? 0 : Math.min(1, (raw - floor) / (1 - floor))

    return {
      score,
      explanation: `cosine ${raw.toFixed(3)} (floor ${floor}) → ${score.toFixed(3)}`,
      meta: { raw, floor },
    }
  },
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('vector length mismatch')
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
