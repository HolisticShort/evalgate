import type {
  Suite,
  SystemUnderTest,
  SuiteResult,
  CaseResult,
  EvalCase,
  GateResult,
  JudgeProvider,
  EmbeddingProvider,
  AssertionResult,
  AssertionConfig,
  SourceDocument,
  SutOutput,
} from './types.js'
import { isSutEnvelope } from './types.js'
import { get as getAssertion, byCost } from './assertions/index.js'
import { cacheKey, cacheEnabled, type Cache } from './cache.js'

export interface RunOptions {
  suite: Suite
  sut: SystemUnderTest
  judge?: JudgeProvider
  embed?: EmbeddingProvider
  baseline?: SuiteResult
  cache?: Cache
  /** Cases evaluated at once. See DEFAULT_CONCURRENCY. */
  concurrency?: number
  warn?: (msg: string) => void
}

/**
 * Conservative on purpose. Every unit of concurrency is a concurrent request
 * against someone's provider account, and a gate that trips a rate limit reads
 * as a quality failure to whoever opened the PR. Raise it deliberately with
 * `--concurrency` once you know your own limits.
 */
export const DEFAULT_CONCURRENCY = 4

/**
 * load → sample → assert → aggregate → gate
 */
export async function run(opts: RunOptions): Promise<SuiteResult> {
  const { suite, sut, judge, embed, baseline, cache } = opts
  const warn = opts.warn ?? (m => process.stderr.write(`warning: ${m}\n`))

  const samples = suite.samples ?? 3
  if (samples < 1) throw new Error('samples must be >= 1')

  const useCache = Boolean(cache) && cacheEnabled(sut.version, warn)
  const cost = { cached: 0, executed: 0, judged: { cached: 0, executed: 0 } }

  const ctx: CaseCtx = { suite, sut, judge, embed, cache: useCache ? cache : undefined, cost }
  const cases = await mapConcurrent(suite.cases, opts.concurrency ?? DEFAULT_CONCURRENCY, c =>
    runCase(c, ctx),
  )

  const mean = cases.length === 0 ? 0 : cases.reduce((s, c) => s + c.score, 0) / cases.length

  const partial: SuiteResult = {
    suite: suite.name,
    sut: sut.version ?? 'unversioned',
    mean,
    cases,
    gates: [],
    passed: false,
    cost,
  }

  partial.gates = evaluateGates(partial, suite, baseline)
  partial.passed = partial.gates.every(g => g.passed)
  return partial
}

interface CaseCtx {
  suite: Suite
  sut: SystemUnderTest
  judge: JudgeProvider | undefined
  embed: EmbeddingProvider | undefined
  cache: Cache | undefined
  cost: CostCounters
}

export interface CostCounters {
  cached: number
  executed: number
  judged: { cached: number; executed: number }
}

/**
 * Bounded-concurrency map that preserves input order.
 *
 * Order matters beyond tidiness: the case list is the user's suite as written,
 * and a report that reshuffles it on every run makes two runs impossible to
 * diff by eye. Completion order is an execution detail and stays one.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`concurrency must be an integer >= 1, got ${limit}`)
  }

  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }

  // A rejection propagates, but only after the in-flight workers settle —
  // otherwise a failure mid-run leaves provider calls orphaned in the
  // background and the process exits while they are still billing.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  const failed = settled.find(s => s.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason

  return results
}

async function runCase(c: EvalCase, ctx: CaseCtx): Promise<CaseResult> {
  const samples = ctx.suite.samples ?? 3
  const sampleScores: number[] = []
  let lastAssertions: (AssertionResult & { type: string })[] = []
  let critical = false
  let anyCached = false

  for (let i = 0; i < samples; i++) {
    const { output: raw, cached } = await produce(c, i, ctx)
    anyCached ||= cached

    // The envelope is unwrapped after the cache, not before, so a cached run
    // still knows what the system retrieved.
    const output = isSutEnvelope(raw) ? raw.output : raw
    const retrieved = isSutEnvelope(raw) ? raw.retrieved : undefined

    const results = await evaluateAssertions(
      c,
      output,
      {
        ...(ctx.judge ? { judge: ctx.judge } : {}),
        ...(ctx.embed ? { embed: ctx.embed } : {}),
        ...(retrieved ? { retrieved } : {}),
      },
      ctx.cache ? { cache: ctx.cache, sutVersion: ctx.sut.version as string, cost: ctx.cost } : undefined,
    )
    const score = weightedMean(results.map(r => r.score), c.weights)

    sampleScores.push(score)
    if (results.some(r => r.critical)) critical = true

    // Report the worst sample's detail — a reviewer needs the failure, not a
    // healthy sibling run that happened to go last.
    if (i === 0 || score <= Math.min(...sampleScores)) lastAssertions = results
  }

  const v = variance(sampleScores)
  return {
    caseId: c.id,
    score: median(sampleScores),
    samples: sampleScores,
    variance: v,
    unstable: v > UNSTABLE_VARIANCE,
    critical,
    assertions: lastAssertions,
    cached: anyCached,
  }
}

/** Above this spread across samples, the case is reported as `unstable`. */
export const UNSTABLE_VARIANCE = 0.05

async function produce(
  c: EvalCase,
  sampleIndex: number,
  ctx: CaseCtx,
): Promise<{ output: SutOutput; cached: boolean }> {
  const key = ctx.cache
    ? cacheKey({
        caseInput: c.input,
        sutVersion: ctx.sut.version as string,
        modelId: ctx.sut.name,
        modelParams: { sampleIndex },
        assertion: { type: '__sut__' } as AssertionConfig,
      })
    : undefined

  if (key && ctx.cache) {
    const hit = await ctx.cache.get(key)
    if (hit !== undefined) {
      ctx.cost.cached++
      return { output: hit as SutOutput, cached: true }
    }
  }

  const output = await ctx.sut.run(c.input)
  ctx.cost.executed++
  if (key && ctx.cache) await ctx.cache.set(key, output)
  return { output, cached: false }
}

/** Providers are optional everywhere; assertions that need one say so loudly. */
export interface Providers {
  judge?: JudgeProvider | undefined
  embed?: EmbeddingProvider | undefined
  retrieved?: SourceDocument[] | undefined
}

/**
 * Everything needed to cache an assertion result. Separate from `Providers`
 * because calibration deliberately runs uncached — it exists to measure the
 * judge, and a judge that answers from cache is not being measured.
 */
export interface AssertionCacheCtx {
  cache: Cache
  sutVersion: string
  cost: CostCounters
}

/**
 * Run every assertion on a fixed output. Exported because calibration scores a
 * committed output rather than one produced by a system under test — same
 * assertions, same scoring, no SUT.
 */
export async function evaluateAssertions(
  c: EvalCase,
  output: string | Record<string, unknown>,
  providers: Providers,
  cacheCtx?: AssertionCacheCtx,
): Promise<(AssertionResult & { type: string })[]> {
  // Results are parked at their declaration index, never matched back by type.
  // Matching by type collapses two assertions of the same type onto one result:
  // the second is dropped and the first is counted twice, which silently changes
  // the case score and can lose a `critical` flag entirely.
  const declared = c.assertions as { type: string }[]
  const ordered = byCost(declared.map((a, index) => ({ ...a, index })))
  const results: (AssertionResult & { type: string })[] = new Array(declared.length)
  let critical = false

  for (const { index, ...rest } of ordered) {
    const config = rest as unknown as AssertionConfig
    // Short-circuit: once a free assertion has flagged the case critical, the
    // expensive ones cannot change the outcome and shouldn't spend a token.
    if (critical && getAssertion(config.type).cost === 'expensive') {
      results[index] = {
        type: config.type,
        score: 0,
        explanation: 'skipped — case already failed a critical assertion',
        skipped: true,
      }
      continue
    }

    const assertion = getAssertion(config.type)

    // Only expensive assertions are cached. A regex costs less to run than to
    // hash and read off disk, and caching it would make the run slower while
    // reporting a higher hit rate.
    const key =
      cacheCtx && assertion.cost === 'expensive'
        ? cacheKey({
            caseInput: c.input,
            sutVersion: cacheCtx.sutVersion,
            modelId: providers.judge?.id ?? 'no-judge',
            // The retrieved set is part of what the assertion scored, and a
            // retriever can change what it returns without the SUT version
            // moving. Leaving it out of the key serves a stale grounding score
            // for a corpus the system no longer sees.
            modelParams: { kind: 'assertion', retrieved: providers.retrieved ?? null },
            assertion: config,
            output,
          })
        : undefined

    if (key && cacheCtx) {
      const hit = await cacheCtx.cache.get(key)
      if (hit !== undefined) {
        const cachedResult = hit as AssertionResult
        cacheCtx.cost.judged.cached++
        if (cachedResult.critical) critical = true
        results[index] = { ...cachedResult, type: config.type }
        continue
      }
    }

    const result = await assertion.evaluate(config, {
      case: c,
      output,
      ...(providers.judge ? { judge: providers.judge } : {}),
      ...(providers.embed ? { embed: providers.embed } : {}),
      ...(providers.retrieved ? { retrieved: providers.retrieved } : {}),
    })
    if (key && cacheCtx) {
      cacheCtx.cost.judged.executed++
      await cacheCtx.cache.set(key, result)
    }
    if (result.critical) critical = true
    results[index] = { ...result, type: config.type }
  }

  // Declaration order, by construction — cost order is an execution detail, and
  // a report that reshuffles the user's suite is confusing.
  return results as (AssertionResult & { type: string })[]
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function weightedMean(scores: number[], weights?: number[]): number {
  if (scores.length === 0) return 0
  if (!weights || weights.length !== scores.length) {
    return scores.reduce((a, b) => a + b, 0) / scores.length
  }
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  return scores.reduce((sum, s, i) => sum + s * (weights[i] as number), 0) / total
}

/**
 * Median, not mean. One degenerate sample shouldn't sink a case; three should.
 * See SPEC.md § Sampling and flake.
 */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

/**
 * Population variance across samples. Surfaced as `unstable` rather than folded
 * into the score — high variance is a fact about the feature, not about the test.
 */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * All gates are evaluated even after one fails — a report that stops at the
 * first failure makes people fix one thing, re-run, and discover the next.
 */
export function evaluateGates(result: SuiteResult, suite: Suite, baseline?: SuiteResult): GateResult[] {
  const gates: GateResult[] = []
  const t = suite.thresholds

  if (t.floor !== undefined) {
    gates.push({
      gate: 'floor',
      passed: result.mean >= t.floor,
      actual: round(result.mean),
      expected: t.floor,
      detail: `suite mean ${round(result.mean)} ${result.mean >= t.floor ? '≥' : '<'} floor ${t.floor}`,
    })
  }

  if (t.regression !== undefined) {
    if (!baseline) {
      // No baseline is not a pass. Reporting green because we had nothing to
      // compare against is how a regression gate silently stops working.
      gates.push({
        gate: 'regression',
        passed: true,
        actual: round(result.mean),
        expected: 0,
        detail: 'no baseline available — regression gate skipped (not evaluated)',
      })
    } else {
      const drop = baseline.mean - result.mean
      gates.push({
        gate: 'regression',
        passed: drop <= t.regression,
        actual: round(drop),
        expected: t.regression,
        detail: `${round(result.mean)} vs ${round(baseline.mean)} baseline (${drop >= 0 ? '−' : '+'}${round(Math.abs(drop))}, allowed −${t.regression})`,
      })
    }
  }

  if (t.criticalCases) {
    const { ids, minScore } = t.criticalCases
    const failing = ids
      .map(id => result.cases.find(c => c.caseId === id))
      .filter((c): c is CaseResult => c !== undefined && c.score < minScore)
    const missing = ids.filter(id => !result.cases.some(c => c.caseId === id))

    gates.push({
      gate: 'criticalCases',
      // A critical case that isn't in the suite is a config error surfacing as
      // a failure — silently passing a gate over a case that doesn't exist is
      // strictly worse than a noisy failure.
      passed: failing.length === 0 && missing.length === 0,
      actual: failing.length,
      expected: 0,
      detail:
        missing.length > 0
          ? `critical case ids not found in suite: ${missing.join(', ')}`
          : failing.length === 0
            ? ids.map(id => `${id} ${round(result.cases.find(c => c.caseId === id)?.score ?? 0)}`).join(' · ')
            : failing.map(c => `${c.caseId} ${round(c.score)} < ${minScore}`).join(' · '),
    })
  }

  const criticals = result.cases.filter(c => c.critical)
  if (criticals.length > 0) {
    gates.push({
      gate: 'criticalAssertions',
      passed: false,
      actual: criticals.length,
      expected: 0,
      detail: criticals.map(c => c.caseId).join(', '),
    })
  }

  return gates
}

const round = (n: number): number => Math.round(n * 1000) / 1000
