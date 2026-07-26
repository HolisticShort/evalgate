import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeDrift, parseHistory, slope, MIN_POINTS } from '../src/drift.js'
import { ConfigError } from '../src/config.js'
import type { HistoryRecord } from '../src/types.js'

const rec = (ts: string, mean: number, cases: Record<string, number>, suite = 'support-agent'): HistoryRecord => ({
  ts,
  sut: ts,
  suite,
  mean,
  passed: true,
  cases,
})

/** Six weeks of a case sliding 0.04 per run while every run passed its gate. */
const slide = [
  rec('2026-06-01T00:00:00Z', 0.91, { 'refund-policy': 0.95, 'pii-leak': 1 }),
  rec('2026-06-08T00:00:00Z', 0.89, { 'refund-policy': 0.91, 'pii-leak': 1 }),
  rec('2026-06-15T00:00:00Z', 0.87, { 'refund-policy': 0.87, 'pii-leak': 1 }),
  rec('2026-06-22T00:00:00Z', 0.85, { 'refund-policy': 0.83, 'pii-leak': 1 }),
  rec('2026-06-29T00:00:00Z', 0.83, { 'refund-policy': 0.79, 'pii-leak': 1 }),
  rec('2026-07-06T00:00:00Z', 0.81, { 'refund-policy': 0.75, 'pii-leak': 1 }),
]

test('catches a slow slide that every per-PR regression gate passed', () => {
  // Each step is 0.04 — under a typical `regression: 0.05` gate, so no single
  // PR ever failed. This is the failure mode drift exists to catch.
  const [r] = analyzeDrift(slide, { threshold: 0.05 })
  assert.ok(r)
  assert.equal(r.drifting, true)

  const refund = r.cases.find(c => c.id === 'refund-policy')
  assert.ok(refund)
  assert.equal(refund.first, 0.95)
  assert.equal(refund.last, 0.75)
  assert.equal(refund.delta, -0.2)
  assert.equal(refund.slope, -0.04)
  assert.equal(refund.drifting, true)
})

test('a steady case is not flagged and the suite mean is its own series', () => {
  const [r] = analyzeDrift(slide, { threshold: 0.05 })
  assert.ok(r)
  const stable = r.cases.find(c => c.id === 'pii-leak')
  assert.ok(stable)
  assert.equal(stable.delta, 0)
  assert.equal(stable.drifting, false)

  assert.equal(r.mean.id, 'suite mean')
  assert.equal(r.mean.delta, -0.1)
  assert.equal(r.mean.drifting, true)
})

test('improvement never reads as drift', () => {
  const rising = slide.map((x, i) => rec(x.ts, 0.5 + i * 0.05, { c: 0.5 + i * 0.05 }))
  const [r] = analyzeDrift(rising)
  assert.ok(r)
  assert.equal(r.drifting, false)
  assert.ok((r.cases[0]?.slope ?? 0) > 0)
})

test('worst decline is reported first', () => {
  const records = [
    rec('2026-06-01T00:00:00Z', 0.9, { mild: 1, severe: 1 }),
    rec('2026-06-02T00:00:00Z', 0.8, { mild: 0.95, severe: 0.6 }),
    rec('2026-06-03T00:00:00Z', 0.7, { mild: 0.9, severe: 0.2 }),
  ]
  const [r] = analyzeDrift(records)
  assert.ok(r)
  assert.equal(r.cases[0]?.id, 'severe')
})

test('a case with too little history has no trend and is never flagged', () => {
  const records = [
    rec('2026-06-01T00:00:00Z', 1, { old: 1 }),
    rec('2026-06-02T00:00:00Z', 1, { old: 1 }),
    // Added late, and low — but two points is noise, not a trend.
    rec('2026-06-03T00:00:00Z', 0.5, { old: 1, fresh: 0.1 }),
    rec('2026-06-04T00:00:00Z', 0.5, { old: 1, fresh: 0.1 }),
  ]
  const [r] = analyzeDrift(records)
  assert.ok(r)
  assert.deepEqual(r.insufficient, ['fresh'])
  assert.equal(
    r.cases.some(c => c.id === 'fresh'),
    false,
  )
  assert.equal(MIN_POINTS, 3)
})

test('a case missing from a run is absent, not zero', () => {
  // A suite edit that skips a case for one run must not manufacture a cliff.
  const records = [
    rec('2026-06-01T00:00:00Z', 0.9, { a: 0.9 }),
    rec('2026-06-02T00:00:00Z', 0.9, {}),
    rec('2026-06-03T00:00:00Z', 0.9, { a: 0.9 }),
    rec('2026-06-04T00:00:00Z', 0.9, { a: 0.9 }),
  ]
  const [r] = analyzeDrift(records)
  assert.ok(r)
  const a = r.cases.find(x => x.id === 'a')
  assert.ok(a)
  assert.equal(a.points, 3)
  assert.equal(a.delta, 0)
  assert.equal(a.drifting, false)
})

test('window keeps only the most recent runs', () => {
  const [r] = analyzeDrift(slide, { window: 2 })
  assert.ok(r)
  assert.equal(r.runs, 2)
  assert.equal(r.from, '2026-06-29T00:00:00Z')
  // Two points is below MIN_POINTS, so a window that short reports no trend
  // rather than a confident one.
  assert.deepEqual(r.insufficient, ['pii-leak', 'refund-policy'])
})

test('suites are reported separately and can be selected', () => {
  const mixed = [
    rec('2026-06-01T00:00:00Z', 0.9, { a: 0.9 }, 'one'),
    rec('2026-06-01T00:00:00Z', 0.5, { b: 0.5 }, 'two'),
    rec('2026-06-02T00:00:00Z', 0.8, { a: 0.8 }, 'one'),
  ]
  assert.equal(analyzeDrift(mixed).length, 2)

  const only = analyzeDrift(mixed, { suite: 'two' })
  assert.equal(only.length, 1)
  assert.equal(only[0]?.suite, 'two')

  assert.throws(() => analyzeDrift(mixed, { suite: 'nope' }), ConfigError)
})

test('the threshold boundary flags rather than passes', () => {
  const records = [
    rec('2026-06-01T00:00:00Z', 1, { a: 1 }),
    rec('2026-06-02T00:00:00Z', 0.97, { a: 0.97 }),
    rec('2026-06-03T00:00:00Z', 0.95, { a: 0.95 }),
  ]
  // Exactly 0.05 of decline. A gate that lets its own boundary through gets
  // tuned to the boundary.
  assert.equal(analyzeDrift(records, { threshold: 0.05 })[0]?.cases[0]?.drifting, true)
  assert.equal(analyzeDrift(records, { threshold: 0.06 })[0]?.cases[0]?.drifting, false)
})

test('slope is zero when it cannot be computed', () => {
  assert.equal(slope([]), 0)
  assert.equal(slope([0.5]), 0)
  assert.equal(slope([0.5, 0.5, 0.5]), 0)
})

// ---------------------------------------------------------------------------

test('parseHistory tolerates blank lines and preserves append order', () => {
  const text = `${JSON.stringify(rec('2026-06-02T00:00:00Z', 0.8, { a: 0.8 }))}\n\n${JSON.stringify(
    rec('2026-06-01T00:00:00Z', 0.9, { a: 0.9 }),
  )}\n`
  const parsed = parseHistory(text)
  assert.equal(parsed.length, 2)
  // File order is the truth — sorting by ts would let a skewed clock silently
  // reorder the series.
  assert.equal(parsed[0]?.mean, 0.8)
})

test('a corrupt history line fails loudly rather than truncating the series', () => {
  // Drift over a silently shortened series is worse than no drift report.
  assert.throws(() => parseHistory('{"suite":"a","mean":1}\nnot json\n'), ConfigError)
  assert.throws(() => parseHistory('{"suite":"a"}\n'), ConfigError)
  assert.throws(() => parseHistory('[1,2]\n'), ConfigError)
})
