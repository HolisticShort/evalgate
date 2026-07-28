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
  run(input: CaseInput): Promise<SutOutput>
}

/**
 * What a system under test may return.
 *
 * A bare string or object is the output itself. A `SutEnvelope` additionally
 * reports the documents the system actually retrieved at run time — the case
 * that RAG makes unavoidable, because there the source set is chosen by a
 * retriever rather than declared in the suite. Attributing claims against a
 * corpus the system never saw scores the wrong thing in both directions: it
 * reports a hallucination when the model correctly used a chunk the suite
 * didn't list, and reports grounded output when the retriever surfaced the
 * wrong chunk and the model faithfully used it.
 */
export type SutOutput = string | Record<string, unknown> | SutEnvelope

/**
 * Recognized only when BOTH keys are present. A lone `output` key is far too
 * common in ordinary structured output to claim as a reserved word, so the
 * envelope is opt-in by virtue of carrying `retrieved`.
 */
export interface SutEnvelope {
  output: string | Record<string, unknown>
  retrieved: SourceDocument[]
}

export function isSutEnvelope(v: unknown): v is SutEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    'output' in v &&
    Array.isArray((v as { retrieved?: unknown }).retrieved)
  )
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
  /**
   * Ids of the documents a correct retrieval must surface. Lives on the case
   * rather than only on the assertion because recall and precision are two
   * views of one labelling, and duplicating the list is how the two drift apart.
   * An assertion may still override it.
   */
  expectedDocs?: string[]
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
  /**
   * The assertion never ran — the case had already failed a critical assertion
   * and an expensive pass couldn't change the outcome. Distinct from scoring 0,
   * and calibration rejects sets where a judged assertion was skipped: a score
   * the judge never produced tells you nothing about the judge.
   */
  skipped?: boolean
}

export interface AssertionContext {
  case: EvalCase
  output: string | Record<string, unknown>
  /**
   * Documents the system reported retrieving for this input, when it reported
   * any. Takes precedence over the suite's declared context — see `SutEnvelope`.
   */
  retrieved?: SourceDocument[]
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
  | ({ type: 'contextRecall' } & RetrievalConfig)
  | ({ type: 'contextPrecision' } & RetrievalConfig)
  | { type: string; [k: string]: unknown } // custom, via the registry

/**
 * Shared by `contextRecall` and `contextPrecision`.
 */
export interface RetrievalConfig {
  /** Ids a correct retrieval must surface. Falls back to the case's `expectedDocs`. */
  expectedDocs?: string[]
  /**
   * Score only the first `k` retrieved documents — recall@k. A document ranked
   * 48th was retrieved in name only; most generators never read that far.
   */
  k?: number
}

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
  /**
   * `cached`/`executed` count system-under-test runs, so they still equal
   * cases × samples. Judged assertions are counted separately rather than
   * folded in: they are a different unit at a different price, and merging
   * them would quietly break the arithmetic a reader does on that line.
   * Optional so artifacts written before assertion caching still parse.
   */
  cost: { cached: number; executed: number; judged?: { cached: number; executed: number } }
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
// Calibration — who judges the judge
// ---------------------------------------------------------------------------

/**
 * One human-scored case. The output is COMMITTED, not produced by a system
 * under test: calibration holds the output constant and varies the judge, which
 * is the only way to attribute a score change to the judge rather than the app.
 */
export interface CalibrationCase {
  id: string
  input: CaseInput
  output: string | Record<string, unknown>
  assertions: AssertionConfig[]
  weights?: number[]
  /** Human ground truth in [0,1]. The thing the judge is measured against. */
  expected: number
  /** Why the human scored it this way. Read during disagreement triage. */
  note?: string
}

export interface CalibrationSet {
  name: string
  judge?: JudgeConfig
  agreement: {
    /** Floor for 1 − mean absolute error. */
    minimum?: number
    /** Ceiling for |mean signed error|. Bias is correctable; noise is not. */
    maxBias?: number
  }
  cases: CalibrationCase[]
}

export interface CalibrationCaseResult {
  id: string
  human: number
  judged: number
  /** judged − human. Signed, because direction is the diagnosis. */
  error: number
  note?: string
}

export interface CalibrationGate {
  gate: 'agreement' | 'bias'
  passed: boolean
  actual: number
  expected: number
  detail: string
}

export interface CalibrationReport {
  set: string
  /** Provider id. A calibration result belongs to one judge and no other. */
  judge: string
  cases: CalibrationCaseResult[]
  /** 1 − mean absolute error. Published with every judged score. */
  agreement: number
  /** Mean signed error. Systematic offset — different bug than disagreement. */
  bias: number
  /** Pearson against human scores. Null when either series is constant. */
  correlation: number | null
  /** Largest absolute disagreements first. What a human actually reviews. */
  worst: CalibrationCaseResult[]
  gates: CalibrationGate[]
  passed: boolean
}

/** Written by `calibrate`, read by `run` to publish agreement alongside scores. */
export interface CalibrationStamp {
  ts: string
  set: string
  judge: string
  agreement: number
  passed: boolean
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
