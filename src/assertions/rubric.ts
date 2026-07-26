import type { Assertion } from '../types.js'

interface RubricVerdict {
  score: number
  reasoning: string
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['score', 'reasoning'],
  additionalProperties: false,
  properties: {
    score: { type: 'integer' },
    reasoning: { type: 'string', minLength: 1 },
  },
}

/**
 * LLM-as-judge against a written rubric.
 *
 * The judge is asked for an INTEGER on a small scale (default 1–5) rather than
 * a float in [0,1]. Models are measurably better at picking a labelled band
 * than at producing a calibrated continuous score, and a free-floating 0.73
 * carries false precision. The integer is normalized afterward.
 */
export const rubric: Assertion<{ rubric: string; scale?: number }> = {
  type: 'rubric',
  cost: 'expensive',
  async evaluate(config, ctx) {
    if (!ctx.judge) throw new Error('rubric requires a judge provider')

    const scale = config.scale ?? 5
    const output = typeof ctx.output === 'string' ? ctx.output : JSON.stringify(ctx.output, null, 2)

    const prompt = [
      'You are evaluating the output of another system against a rubric.',
      'Score strictly. Reserve the top band for output that fully satisfies the rubric.',
      '',
      `SCALE: integer from 1 (worst) to ${scale} (best).`,
      '',
      'RUBRIC:',
      config.rubric,
      '',
      'PROMPT GIVEN TO THE SYSTEM:',
      ctx.case.input.prompt,
      '',
      'OUTPUT TO EVALUATE:',
      output,
      '',
      'Return the score and a one-sentence reason.',
    ].join('\n')

    const verdict = await ctx.judge.judge<RubricVerdict>(prompt, {
      ...VERDICT_SCHEMA,
      properties: { ...VERDICT_SCHEMA.properties, score: { type: 'integer', minimum: 1, maximum: scale } },
    })

    const clamped = Math.min(scale, Math.max(1, verdict.score))
    return {
      // Normalize so 1 → 0 and `scale` → 1; a floor of 1/scale would mean the
      // worst possible output still scores above zero.
      score: (clamped - 1) / (scale - 1),
      explanation: `${clamped}/${scale} — ${verdict.reasoning}`,
      meta: { raw: verdict.score, scale },
    }
  },
}
