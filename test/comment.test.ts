import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prComment, COMMENT_MARKER, GITHUB_COMMENT_LIMIT } from '../src/reporters/comment.js'
import type { SuiteResult, CaseResult, GroundedMeta } from '../src/types.js'

const kase = (over: Partial<CaseResult> = {}): CaseResult => ({
  caseId: 'c',
  score: 1,
  samples: [1],
  variance: 0,
  unstable: false,
  critical: false,
  assertions: [],
  cached: false,
  ...over,
})

const result = (over: Partial<SuiteResult> = {}): SuiteResult => ({
  suite: 'support-agent',
  sut: 'v1',
  mean: 1,
  cases: [],
  gates: [],
  passed: true,
  cost: { cached: 0, executed: 1 },
  ...over,
})

test('leads with the verdict', () => {
  assert.match(prComment([result()]), /✅ evalgate — 1 suite passed/)
  assert.match(prComment([result({ passed: false }), result()]), /❌ evalgate — 1 of 2 suites failed/)
})

test('carries a stable marker so CI updates one comment instead of stacking them', () => {
  // Six stale evalgate comments teach a reviewer to scroll past the seventh.
  assert.ok(prComment([result()]).startsWith(COMMENT_MARKER))
})

test('a case added in this PR is new, not an improvement from zero', () => {
  const base = result({ cases: [kase({ caseId: 'old', score: 0.9 })] })
  const now = result({ cases: [kase({ caseId: 'old', score: 0.9 }), kase({ caseId: 'fresh', score: 0.4 })] })

  const body = prComment([now], { baseline: [base] })
  assert.match(body, /`fresh`.*\*\*new\*\*/)
  // Rendering it as +0.40 would claim a comparison that was never made.
  assert.doesNotMatch(body, /\+0\.40/)
})

test('a case deleted in this PR is called out as removed', () => {
  // Deleting a failing case is a way to make a gate pass. It should cost a line
  // in the review rather than vanishing from the score diff.
  const base = result({ cases: [kase({ caseId: 'inconvenient', score: 0.1 })] })
  const now = result({ cases: [] })

  const body = prComment([now], { baseline: [base] })
  assert.match(body, /`inconvenient`.*\*\*removed\*\*/)
})

test('drops are ranked above improvements', () => {
  const base = result({ cases: [kase({ caseId: 'up', score: 0.5 }), kase({ caseId: 'down', score: 0.9 })] })
  const now = result({ cases: [kase({ caseId: 'up', score: 0.9 }), kase({ caseId: 'down', score: 0.5 })] })

  const body = prComment([now], { baseline: [base] })
  assert.ok(body.indexOf('`down`') < body.indexOf('`up`'))
  assert.match(body, /\*\*−0\.40\*\*/)
  assert.match(body, /\+0\.40/)
})

test('without a baseline the delta columns are omitted, not filled with dashes', () => {
  const body = prComment([result({ cases: [kase({ caseId: 'a', score: 0.5 })] })])
  assert.match(body, /\| case \| score \|/)
  assert.doesNotMatch(body, /\| baseline \|/)
  assert.match(body, /\(no baseline\)/)
})

test('the invented sentence and its contradicting source make it into the comment', () => {
  const meta: GroundedMeta = {
    supported: 0,
    unsupported: 0,
    contradicted: 1,
    claims: [
      {
        claim: { text: 'Shipping is free on orders over $50.', type: 'numeric', hedged: false },
        status: 'contradicted',
        evidence: [{ docId: 'policy-v3', span: 'Free shipping applies to orders over $75.' }],
        reasoning: 'the policy states $75, not $50',
      },
    ],
  }
  const body = prComment([
    result({
      passed: false,
      cases: [
        kase({
          caseId: 'order-status',
          score: 0,
          critical: true,
          assertions: [{ type: 'grounded', score: 0, explanation: '0/1 claims supported', meta }],
        }),
      ],
    }),
  ])

  assert.match(body, /Shipping is free on orders over \$50\./)
  assert.match(body, /the policy states \$75, not \$50/)
  assert.match(body, /Free shipping applies to orders over \$75\./)
})

test('passing cases do not get a detail block', () => {
  const body = prComment([result({ cases: [kase({ caseId: 'fine', score: 1 })] })])
  assert.doesNotMatch(body, /<details>/)
})

test('judge agreement rides along with the scores', () => {
  const body = prComment([result({ judgeAgreement: 0.88 })])
  assert.match(body, /judge–human agreement `0\.88`/)
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

const failing = (n: number): CaseResult[] =>
  Array.from({ length: n }, (_, i) =>
    kase({
      caseId: `case-${i}`,
      score: i / 100,
      assertions: [{ type: 'rubric', score: 0, explanation: 'x'.repeat(400) }],
    }),
  )

test('truncation says what it dropped instead of silently cutting off', () => {
  // A body cut at the byte limit reads as though nothing else was wrong, which
  // is the one thing this comment must never imply.
  const body = prComment([result({ passed: false, cases: failing(20) })], { limit: 3000, artifact: 'evalgate-result' })

  assert.ok(body.length <= 3000)
  assert.match(body, /more failing cases not shown/)
  assert.match(body, /`evalgate-result` artifact/)
})

test('truncation keeps the worst detail blocks and drops the mildest', () => {
  // Every case stays in the delta table; it's the expensive detail that gets
  // dropped, worst-kept-first.
  const body = prComment([result({ passed: false, cases: failing(20) })], { limit: 3000 })
  assert.match(body, /<code>case-0<\/code>/)
  assert.doesNotMatch(body, /<code>case-19<\/code>/)
})

test('gates and the delta table survive truncation', () => {
  // The verdict is the part a reviewer reads in five seconds; detail is what
  // gets dropped, never the summary.
  const body = prComment(
    [
      result({
        passed: false,
        cases: failing(20),
        gates: [{ gate: 'floor', passed: false, actual: 0.1, expected: 0.8, detail: 'suite mean 0.1 < floor 0.8' }],
      }),
    ],
    { limit: 3000 },
  )
  assert.match(body, /suite mean 0\.1 < floor 0\.8/)
  assert.match(body, /case-19/) // still in the table, just not as a detail block
})

test('a comment that fits is not annotated as truncated', () => {
  const body = prComment([result({ passed: false, cases: failing(2) })])
  assert.ok(body.length < GITHUB_COMMENT_LIMIT)
  assert.doesNotMatch(body, /not shown/)
})

test('pipes in case ids and claims cannot break out of a table cell', () => {
  const body = prComment([result({ cases: [kase({ caseId: 'a|b', score: 0.5 })] })])
  assert.match(body, /a\\\|b/)
})
