/**
 * Core contracts for evalgate.
 *
 * Nothing in src/ may import a model-provider SDK. Providers are injected as
 * adapters at the edge — that is what keeps the core testable offline and
 * portable across stacks. See SPEC.md § Architecture.
 */

// ---------------------------------------------------------------------------
// System under test
// ---------------------------------------------------------------------------

/**
 * The thing being evaluated. Callers supply this; evalgate never calls a model
 * provider on behalf of the system under test.
 *
 * `version` is opaque to evalgate but load-bearing for the cache key. A missing
 * version disables caching with a warning rather than guessing — silently
 * serving stale results is the worst failure this tool can have.
 */
export interface SystemUnderTest {
  name: string
  version?: string
  run(input: CaseInput): Promise<string | Record<string, unknown>>
}

export interface CaseInput {
  prompt: string
  /** Documents the system was given. `grounded` scores claims against these. */
  context?: SourceDocument[]
  vars?: Record<string, unknown>
}

export interface SourceDocument {
  id: string
  text: string
  meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Cases and suites
// ---------------------------------------------------------------------------

export interface EvalCase {
  id: string
  input: CaseInput
  /** Reference answer for similarity-style assertions. Optional by design — most cases don't have one. */
  reference?: string
  assertions: AssertionConfig[]
  /** Per-assertion weights, keyed by assertion index. Defaults to equal weight. */
  weights?: number[]
  tags?: string[]
}

export interface Suite {
  name: string
  cases: EvalCase[]
  /**
   * Samples per case. Case score is the MEDIAN, not the mean — one degenerate
   * sample shouldn't sink a case, but three should. See SPEC.md § Sampling.
   */
  samples?: number
  thresholds: ThresholdPolicy
  judge?: JudgeConfig
}

/**
 * Three independent gates. Any one failing fails the build; they answer
 * different questions and none subsumes the others.
 */
export interface ThresholdPolicy {
  /** Absolute quality floor for the suite mean. */
  floor?: number
  /**
   * Maximum allowed drop against the committed baseline. The gate that earns
   * its keep — absolute floors get tuned until they pass, relative movement
   * is much harder to rationalize away.
   */
  regression?: number
  /** Case IDs that must individually clear `minScore`. */
  criticalCases?: { ids: string[]; minScore: number }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Every assertion returns a SCORE, never a boolean. Booleans force a choice
 * between a suite that fails constantly and a suite that passes through real
 * regressions. See SPEC.md § The determinism problem.
 */
export interface AssertionResult {
  /** [0,1]. */
  score: number
  /** Human-readable reason. A red build that only says "0.71 < 0.80" is useless. */
  explanation: string
  /** Assertion-specific detail — e.g. the claim-level breakdown from `grounded`. */
  meta?: unknown
  /** Forces the case critical regardless of score. Used by noPII and by contradicted claims. */
  critical?: boolean
}

export interface AssertionContext {
  case: EvalCase
  output: string | Record<string, unknown>
  judge?: JudgeProvider
  embed?: EmbeddingProvider
}

export interface Assertion<C = unknown> {
  type: string
  /** Judged assertions cost money and wall-clock. The runner uses this to order and budget work. */
  cost: 'free' | 'cheap' | 'expensive'
  evaluate(config: C, ctx: AssertionContext): Promise<AssertionResult>
}

export type AssertionConfig =
  | { type: 'schema'; schema: object }
  | { type: 'contains'; terms: string[]; caseSensitive?: boolean }
  | { type: 'notContains'; terms: string[]; caseSensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'length'; min?: number; max?: number }
  | { type: 'noPII'; patterns?: string[] }
  | { type: 'semanticSimilarity'; reference?: string; floor?: number }
  | { type: 'consistency' }
  | { type: 'rubric'; rubric: string; scale?: number }
  // Flat, like every other assertion. An earlier draft nested these under a
  // `config` key; that silently read `undefined` for every option, so a suite
  // asking for contradictionIsCritical got a passing case. Consistency here is
  // not cosmetic.
  | ({ type: 'grounded' } & GroundedConfig)
  | { type: string; [k: string]: unknown } // custom, via the registry

// ---------------------------------------------------------------------------
// grounded — the assertion this library exists for
// ---------------------------------------------------------------------------

export interface GroundedConfig {
  /** Defaults to the case's own context documents. */
  sources?: SourceDocument[]
  /** Which claim kinds to hold accountable. Opinions and hedges are excluded by default. */
  claimTypes?: ClaimType[]
  ignoreHedged?: boolean
  /**
   * A contradicted claim is a different bug than an unsupported one — a gap vs.
   * a lie — and usually deserves to fail the case outright.
   */
  contradictionIsCritical?: boolean
}

export type ClaimType = 'factual' | 'causal' | 'numeric' | 'temporal'

export interface Claim {
  text: string
  type: ClaimType
  hedged: boolean
}

export interface ClaimVerdict {
  claim: Claim
  /** `unsupported` = nothing entails it. `contradicted` = a source says otherwise. */
  status: 'supported' | 'unsupported' | 'contradicted'
  /** Source spans the judge relied on. This is what a reviewer actually reads. */
  evidence: { docId: string; span: string }[]
  reasoning: string
}

export interface GroundedMeta {
  claims: ClaimVerdict[]
  supported: number
  unsupported: number
  contradicted: number
}

// ---------------------------------------------------------------------------
// Providers (injected — never imported by core)
// ---------------------------------------------------------------------------

/**
 * The judge is infrastructure, not a place to save money. Pinned version,
 * temperature 0, and it does NOT float when the application model changes.
 * See SPEC.md § Who judges the judge.
 */
export interface JudgeConfig {
  model: string
  temperature: 0
  /** Path to the calibration set. Judge changes require re-calibration to pass. */
  calibrationSet?: string
}

export interface JudgeProvider {
  id: string
  judge<T>(prompt: string, schema: object): Promise<T>
}

export interface EmbeddingProvider {
  id: string
  embed(texts: string[]): Promise<number[][]>
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CaseResult {
  caseId: string
  /** Median across samples. */
  score: number
  /** Score of each sample, in run order. */
  samples: number[]
  /**
   * Spread across samples. A case swinging 0.4 between runs is telling you
   * something real about the feature, not about the test — the reporter
   * surfaces these as `unstable` rather than burying them.
   */
  variance: number
  unstable: boolean
  critical: boolean
  assertions: (AssertionResult & { type: string })[]
  cached: boolean
}

export interface SuiteResult {
  suite: string
  sut: string
  mean: number
  cases: CaseResult[]
  gates: GateResult[]
  passed: boolean
  judgeAgreement?: number
  cost: { cached: number; executed: number }
}

export interface GateResult {
  gate: 'floor' | 'regression' | 'criticalCases' | 'criticalAssertions'
  passed: boolean
  actual: number
  expected: number
  detail: string
}

export interface Reporter {
  name: string
  report(result: SuiteResult, out: (s: string) => void): void
}

// ---------------------------------------------------------------------------
// Drift — the time series
// ---------------------------------------------------------------------------

/**
 * One run, appended to .evalgate/history.jsonl (committed). Deliberately
 * narrower than SuiteResult: this file has to stay readable and diffable for
 * years. See reporters/json.historyRecord.
 */
export interface HistoryRecord {
  ts: string
  sut: string
  suite: string
  mean: number
  passed: boolean
  cases: Record<string, number>
  judgeAgreement?: number
}

/**
 * Movement of a single series over the window.
 *
 * `delta` is what gates; `slope` is what diagnoses. A case can post a small
 * delta because it bounced, or because it slid steadily — the slope tells them
 * apart and the steady slide is the one that matters.
 */
export interface SeriesDrift {
  id: string
  /** Observations found in the window. A case absent from a run is not a zero. */
  points: number
  first: number
  last: number
  /** last − first. Negative is a decline. */
  delta: number
  /** Least-squares change per run. */
  slope: number
  /** Decline over the window met or exceeded the threshold. */
  drifting: boolean
}

export interface DriftReport {
  suite: string
  /** Records considered after windowing. */
  runs: number
  from: string
  to: string
  threshold: number
  mean: SeriesDrift
  cases: SeriesDrift[]
  /**
   * Cases with too little history to have a trend. Reported, never flagged —
   * a new case must not read as a regression.
   */
  insufficient: string[]
  /** True if the suite mean or any case is drifting. */
  drifting: boolean
}

/** 0 pass · 1 gate failed · 2 config/runtime error. Config errors must never
 *  masquerade as quality failures — that's how teams learn to ignore the check. */
export type ExitCode = 0 | 1 | 2
