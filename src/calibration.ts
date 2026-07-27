import type {
  CalibrationSet,
  CalibrationCase,
  CalibrationCaseResult,
  CalibrationReport,
  CalibrationGate,
  EvalCase,
  AssertionResult,
} from './types.js'
import { ConfigError } from './config.js'
import { evaluateAssertions, weightedMean, type Providers } from './runner.js'

/**
 * Calibration — who judges the judge.
 *
 * `rubric` and `grounded` use a model to evaluate a model. That is circular
 * unless the circle is closed deliberately: the judge gets its own set of
 * human-scored cases, committed to the repo, and a judge change has to clear it
 * the same way a compiler change has to clear the test suite.
 *
 * A judge nobody has calibrated is a random number generator with good manners.
 * See SPEC.md § Who judges the judge.
 */

/** Below this, agreement is an anecdote. */
export const MIN_CASES = 5

/** The score that separates "should pass" from "should fail" for spread checks. */
export const PASS_BAND = 0.5

export const DEFAULT_MINIMUM = 0.85
export const DEFAULT_MAX_BIAS = 0.1

/** How many disagreements the report puts in front of a human. */
const WORST_N = 5

/**
 * A calibration set that only contains cases the judge should pass calibrates
 * nothing — a judge that returns 1.0 unconditionally would score perfectly.
 * This is the calibration equivalent of a test suite with no failing assertions,
 * and it fails loudly at load rather than producing a confident number.
 */
export function validateSpread(set: CalibrationSet): void {
  if (set.cases.length < MIN_CASES) {
    throw new ConfigError(
      `calibration set "${set.name}" has ${set.cases.length} cases — at least ${MIN_CASES} are needed for agreement to mean anything`,
    )
  }

  const expected = set.cases.map(c => c.expected)
  const low = expected.filter(e => e < PASS_BAND).length
  const high = expected.filter(e => e > PASS_BAND).length

  if (low === 0 || high === 0) {
    throw new ConfigError(
      `calibration set "${set.name}" has no spread — ${low === 0 ? 'no case the judge should fail' : 'no case the judge should pass'}. ` +
        `A judge that answers the same way every time would score perfectly against this set.`,
    )
  }
}

export interface CalibrateOptions extends Providers {
  /** Overrides the set's own thresholds. */
  minimum?: number
  maxBias?: number
}

export async function calibrate(set: CalibrationSet, opts: CalibrateOptions): Promise<CalibrationReport> {
  if (!opts.judge) {
    throw new ConfigError('calibrate requires a judge provider — the point of the command is to measure one')
  }

  const cases: CalibrationCaseResult[] = []
  for (const c of set.cases) {
    cases.push(await scoreCase(c, opts))
  }

  const errors = cases.map(c => c.error)
  const agreement = clamp(1 - mean(errors.map(Math.abs)))
  const bias = round(mean(errors))

  const minimum = opts.minimum ?? set.agreement?.minimum ?? DEFAULT_MINIMUM
  const maxBias = opts.maxBias ?? set.agreement?.maxBias ?? DEFAULT_MAX_BIAS

  const gates: CalibrationGate[] = [
    {
      gate: 'agreement',
      passed: agreement >= minimum,
      actual: agreement,
      expected: minimum,
      detail: `judge–human agreement ${agreement} ${agreement >= minimum ? '≥' : '<'} minimum ${minimum}`,
    },
    {
      // Split out from agreement because they are different bugs: a judge that
      // is uniformly 0.2 generous can be corrected by moving a threshold, and a
      // judge that is 0.2 off in random directions cannot be corrected at all.
      gate: 'bias',
      passed: Math.abs(bias) <= maxBias,
      actual: bias,
      expected: maxBias,
      detail: `judge scores ${bias === 0 ? 'neither high nor low' : bias > 0 ? `${bias} high` : `${Math.abs(bias)} low`} on average (allowed ±${maxBias})`,
    },
  ]

  return {
    set: set.name,
    judge: opts.judge.id,
    cases,
    agreement,
    bias,
    correlation: pearson(
      cases.map(c => c.human),
      cases.map(c => c.judged),
    ),
    worst: [...cases].sort((a, b) => Math.abs(b.error) - Math.abs(a.error)).slice(0, WORST_N),
    gates,
    passed: gates.every(g => g.passed),
  }
}

async function scoreCase(c: CalibrationCase, providers: Providers): Promise<CalibrationCaseResult> {
  // A CalibrationCase is an EvalCase plus ground truth, so it scores through
  // exactly the same path a real run does. Calibrating against a parallel
  // scoring implementation would measure the wrong thing.
  const asEval = { id: c.id, input: c.input, assertions: c.assertions, ...(c.weights ? { weights: c.weights } : {}) } as EvalCase

  const results = await evaluateAssertions(asEval, c.output, providers)
  assertNothingSkipped(c, results)

  const judged = round(weightedMean(results.map(r => r.score), c.weights))
  return {
    id: c.id,
    human: c.expected,
    judged,
    error: round(judged - c.expected),
    ...(c.note !== undefined ? { note: c.note } : {}),
  }
}

/**
 * A skipped assertion contributes a 0 the judge never produced. Left alone it
 * would land in the agreement number as though the judge had been measured, so
 * it's a config error in the set, not a quiet data point.
 */
function assertNothingSkipped(c: CalibrationCase, results: (AssertionResult & { type: string })[]): void {
  const skipped = results.filter(r => r.skipped).map(r => r.type)
  if (skipped.length > 0) {
    throw new ConfigError(
      `calibration case "${c.id}": ${skipped.join(', ')} was skipped because a critical assertion failed first — ` +
        `split it into its own case so the judge is actually measured`,
    )
  }
}

/**
 * Pearson correlation. Null rather than 0 when a series is constant: "the judge
 * ranks cases the same way humans do" is unanswerable when nothing varies, and
 * reporting 0 would read as disagreement.
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = (xs[i] as number) - mx
    const b = (ys[i] as number) - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return round(num / Math.sqrt(dx * dy))
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

const round = (n: number): number => Math.round(n * 1000) / 1000
const clamp = (n: number): number => round(Math.max(0, Math.min(1, n)))
