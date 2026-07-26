import { test } from 'node:test'
import assert from 'node:assert/strict'
import { median, variance, weightedMean, evaluateGates } from '../src/runner.js'
import { score as groundedScore } from '../src/assertions/grounded.js'
import type { Suite, SuiteResult, CaseResult, ClaimVerdict } from '../src/types.js'

test('median resists a single degenerate sample', () => {
  // The reason case scores are medians, not means: one bad sample out of three
  // should not sink a case that is otherwise healthy.
  assert.equal(median([0.9, 0.9, 0.0]), 0.9)
  assert.equal(weightedMean([0.9, 0.9, 0.0]), 0.6)
})

test('median catches consistent degradation', () => {
  // ...but three bad samples should.
  assert.equal(median([0.1, 0.0, 0.2]), 0.1)
})

test('median handles even sample counts', () => {
  assert.equal(median([0.2, 0.4, 0.6, 0.8]), 0.5)
  assert.equal(median([]), 0)
})

test('variance is zero for a single sample', () => {
  assert.equal(variance([0.5]), 0)
  assert.equal(variance([]), 0)
})

test('weightedMean respects weights and ignores mismatched arrays', () => {
  assert.equal(weightedMean([1, 0], [3, 1]), 0.75)
  // A weights array of the wrong length is a config error caught at load time;
  // at runtime it degrades to equal weighting rather than throwing mid-suite.
  assert.equal(weightedMean([1, 0], [1]), 0.5)
  assert.equal(weightedMean([1, 0], [0, 0]), 0)
})

// ---------------------------------------------------------------------------

const suite = (thresholds: Suite['thresholds']): Suite => ({
  name: 's',
  cases: [],
  thresholds,
})

const result = (mean: number, cases: Partial<CaseResult>[] = []): SuiteResult => ({
  suite: 's',
  sut: 'v1',
  mean,
  cases: cases.map(c => ({
    caseId: 'c',
    score: 1,
    samples: [1],
    variance: 0,
    unstable: false,
    critical: false,
    assertions: [],
    cached: false,
    ...c,
  })),
  gates: [],
  passed: false,
  cost: { cached: 0, executed: 0 },
})

test('floor gate', () => {
  assert.equal(evaluateGates(result(0.85), suite({ floor: 0.8 }))[0]?.passed, true)
  assert.equal(evaluateGates(result(0.79), suite({ floor: 0.8 }))[0]?.passed, false)
})

test('regression gate compares against baseline', () => {
  const gates = evaluateGates(result(0.87), suite({ regression: 0.03 }), result(0.92))
  assert.equal(gates[0]?.passed, false)
  assert.match(gates[0]?.detail ?? '', /0\.87 vs 0\.92/)
})

test('an improvement never trips the regression gate', () => {
  const gates = evaluateGates(result(0.95), suite({ regression: 0.03 }), result(0.9))
  assert.equal(gates[0]?.passed, true)
})

test('missing baseline is reported as skipped, not silently passed', () => {
  // A regression gate that reports green because it had nothing to compare
  // against has silently stopped working.
  const gates = evaluateGates(result(0.5), suite({ regression: 0.03 }))
  assert.equal(gates[0]?.passed, true)
  assert.match(gates[0]?.detail ?? '', /skipped/)
})

test('criticalCases gate fails on a listed case below minScore', () => {
  const r = result(0.9, [{ caseId: 'pii-leak', score: 0.5 }])
  const gates = evaluateGates(r, suite({ criticalCases: { ids: ['pii-leak'], minScore: 0.95 } }))
  assert.equal(gates[0]?.passed, false)
})

test('criticalCases gate fails when a listed case is not in the suite', () => {
  // Silently passing a gate over a case that does not exist is strictly worse
  // than a noisy failure — it's a gate that gates nothing.
  const gates = evaluateGates(result(1), suite({ criticalCases: { ids: ['ghost'], minScore: 0.9 } }))
  assert.equal(gates[0]?.passed, false)
  assert.match(gates[0]?.detail ?? '', /not found/)
})

test('a critical assertion fails the suite regardless of mean', () => {
  const r = result(0.99, [{ caseId: 'leaky', critical: true }])
  const gates = evaluateGates(r, suite({ floor: 0.8 }))
  const critical = gates.find(g => g.gate === 'criticalAssertions')
  assert.equal(critical?.passed, false)
})

test('all gates are evaluated even after one fails', () => {
  const gates = evaluateGates(
    result(0.5, [{ caseId: 'x', score: 0.1 }]),
    suite({ floor: 0.8, regression: 0.01, criticalCases: { ids: ['x'], minScore: 0.9 } }),
    result(0.9),
  )
  assert.equal(gates.length, 3)
  assert.ok(gates.every(g => !g.passed))
})

// ---------------------------------------------------------------------------

const verdict = (status: ClaimVerdict['status']): ClaimVerdict => ({
  claim: { text: 't', type: 'factual', hedged: false },
  status,
  evidence: [],
  reasoning: 'r',
})

test('grounded scores supported over total', () => {
  const r = groundedScore([verdict('supported'), verdict('supported'), verdict('unsupported')], {})
  assert.equal(r.score, 2 / 3)
})

test('grounded treats no checkable claims as a pass', () => {
  // A response that correctly declines to assert anything is right behavior.
  // Scoring it 0 would train the suite to punish honest refusals.
  const r = groundedScore([], {})
  assert.equal(r.score, 1)
  assert.match(r.explanation, /no checkable/)
})

test('grounded marks contradiction critical only when configured', () => {
  const v = [verdict('supported'), verdict('contradicted')]
  assert.equal(groundedScore(v, {}).critical, undefined)
  assert.equal(groundedScore(v, { contradictionIsCritical: true }).critical, true)
})

test('grounded explanation separates contradicted from unsupported', () => {
  // Different bugs: a gap versus a lie.
  const r = groundedScore([verdict('unsupported'), verdict('contradicted')], {})
  assert.match(r.explanation, /1 contradicted/)
  assert.match(r.explanation, /1 unsupported/)
})
