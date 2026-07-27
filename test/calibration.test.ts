import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate, validateSpread, pearson, MIN_CASES } from '../src/calibration.js'
import { validateCalibrationSet, validateSuite, ConfigError } from '../src/config.js'
import { fakeJudge } from './fakes.js'
import type { CalibrationSet, CalibrationCase } from '../src/types.js'

/**
 * Calibration cases here use deterministic assertions so the "judge" score is
 * exactly controllable — these tests are about the agreement math, not about
 * any particular judge. `contains` scores the fraction of terms present.
 */
const kase = (id: string, output: string, expected: number): CalibrationCase => ({
  id,
  input: { prompt: 'p' },
  output,
  assertions: [{ type: 'contains', terms: ['a', 'b'] }],
  expected,
})

const set = (cases: CalibrationCase[], agreement: CalibrationSet['agreement'] = {}): CalibrationSet => ({
  name: 'judge-cal',
  agreement,
  cases,
})

const judge = () => fakeJudge([])

test('agreement is 1 minus mean absolute error', async () => {
  // Judged scores are 1.0, 0.5, 0.0 by construction; humans agree exactly.
  const perfect = await calibrate(set([kase('hit', 'ab', 1), kase('half', 'a', 0.5), kase('miss', 'x', 0)]), {
    judge: judge(),
  })
  assert.equal(perfect.agreement, 1)
  assert.equal(perfect.bias, 0)
  assert.equal(perfect.passed, true)

  // Two cases off by 0.2, one exact: MAE 0.133 → agreement 0.867.
  const off = await calibrate(set([kase('hit', 'ab', 0.8), kase('half', 'a', 0.3), kase('miss', 'x', 0)]), {
    judge: judge(),
  })
  assert.equal(off.agreement, 0.867)
  assert.equal(off.passed, false)
})

test('bias is tracked separately from agreement because it is a different bug', async () => {
  // A uniformly generous judge is correctable by moving a threshold. A judge
  // that is off in random directions is not, and the two must not average away.
  const generous = await calibrate(set([kase('a', 'ab', 0.8), kase('b', 'a', 0.3), kase('c', 'ab', 0.8)]), {
    judge: judge(),
  })
  assert.equal(generous.bias, 0.2)

  const noisy = await calibrate(set([kase('a', 'ab', 0.8), kase('b', 'a', 0.7), kase('c', 'ab', 0.8)]), {
    judge: judge(),
  })
  // Same per-case error magnitude, but one points the other way, so bias mostly
  // cancels while agreement stays just as damaged.
  assert.equal(noisy.bias, 0.067)
  assert.equal(noisy.agreement, generous.agreement)
  assert.ok(noisy.agreement < 1)
})

test('a generous judge fails the bias gate even when agreement passes', async () => {
  const report = await calibrate(
    set([kase('a', 'ab', 0.92), kase('b', 'a', 0.42), kase('c', 'x', 0)], { minimum: 0.9, maxBias: 0.05 }),
    { judge: judge() },
  )
  assert.equal(report.gates.find(g => g.gate === 'agreement')?.passed, true)
  assert.equal(report.gates.find(g => g.gate === 'bias')?.passed, false)
  assert.equal(report.passed, false)
})

test('disagreements are ranked worst-first', async () => {
  const report = await calibrate(set([kase('close', 'ab', 0.95), kase('way-off', 'x', 1), kase('exact', 'a', 0.5)]), {
    judge: judge(),
  })
  assert.equal(report.worst[0]?.id, 'way-off')
  assert.equal(report.worst[0]?.error, -1)
  assert.equal(report.worst.at(-1)?.id, 'exact')
})

test('correlation is null rather than zero when nothing varies', async () => {
  // "Does the judge rank cases the way humans do" is unanswerable when every
  // human score is the same. Reporting 0 would read as disagreement.
  const report = await calibrate(set([kase('a', 'ab', 1), kase('b', 'a', 1), kase('c', 'x', 1)]), { judge: judge() })
  assert.equal(report.correlation, null)

  assert.equal(pearson([0, 0.5, 1], [0, 0.5, 1]), 1)
  assert.equal(pearson([0, 0.5, 1], [1, 0.5, 0]), -1)
  assert.equal(pearson([1], [1]), null)
})

test('calibrate refuses to run without a judge', async () => {
  await assert.rejects(() => calibrate(set([kase('a', 'ab', 1)]), {}), ConfigError)
})

test('a judged assertion that was skipped is a config error, not a zero', async () => {
  // noPII flags critical, so grounded never runs. Scoring it 0 would fold a
  // number the judge never produced into the agreement.
  const withSkip: CalibrationCase = {
    id: 'leaks',
    input: { prompt: 'p', context: [{ id: 'd', text: 'nothing' }] },
    output: 'contact dana@example.com',
    assertions: [{ type: 'noPII' }, { type: 'grounded' }],
    expected: 0,
  }
  await assert.rejects(() => calibrate(set([withSkip]), { judge: judge() }), /skipped/)
})

// ---------------------------------------------------------------------------
// Spread — a set with no failures calibrates nothing
// ---------------------------------------------------------------------------

const spread = (expecteds: number[]): CalibrationSet => set(expecteds.map((e, i) => kase(`c${i}`, 'ab', e)))

test('a set where every case should pass is rejected', () => {
  // A judge returning 1.0 unconditionally would score perfectly against this.
  assert.throws(() => validateSpread(spread([1, 1, 0.9, 1, 0.8])), /no case the judge should fail/)
})

test('a set where every case should fail is rejected', () => {
  assert.throws(() => validateSpread(spread([0, 0, 0.1, 0, 0.2])), /no case the judge should pass/)
})

test('a set too small to mean anything is rejected', () => {
  assert.throws(() => validateSpread(spread([0, 1, 0.5])), new RegExp(`at least ${MIN_CASES}`))
  assert.doesNotThrow(() => validateSpread(spread([0, 0.2, 1, 0.9, 0.4])))
})

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const doc = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'calibration',
  name: 'cal',
  cases: [{ id: 'a', input: { prompt: 'p' }, output: 'o', assertions: [{ type: 'contains', terms: ['x'] }], expected: 1 }],
  ...over,
})

test('a calibration case without a committed output is rejected', () => {
  const cases = [{ id: 'a', input: { prompt: 'p' }, assertions: [{ type: 'contains' }], expected: 1 }]
  assert.throws(() => validateCalibrationSet(doc({ cases })), /needs a committed output/)
})

test('a human score outside [0,1] is rejected', () => {
  const bad = (expected: unknown) =>
    doc({ cases: [{ id: 'a', input: { prompt: 'p' }, output: 'o', assertions: [{ type: 'contains' }], expected }] })
  assert.throws(() => validateCalibrationSet(bad(1.5)), /human score in \[0,1\]/)
  assert.throws(() => validateCalibrationSet(bad('high')), /human score in \[0,1\]/)
  assert.throws(() => validateCalibrationSet(bad(undefined)), /human score in \[0,1\]/)
})

test('a judge that is allowed to vary cannot be calibrated', () => {
  assert.throws(() => validateCalibrationSet(doc({ judge: { model: 'm', temperature: 0.7 } })), /temperature must be 0/)
  assert.doesNotThrow(() => validateCalibrationSet(doc({ judge: { model: 'm', temperature: 0 } })))
})

test('duplicate calibration case ids are rejected', () => {
  const one = { id: 'a', input: { prompt: 'p' }, output: 'o', assertions: [{ type: 'contains' }], expected: 1 }
  assert.throws(() => validateCalibrationSet(doc({ cases: [one, one] })), /duplicate calibration case id/)
})

test('a calibration set mistaken for a suite says so', () => {
  // Otherwise "thresholds is required" sends someone to add thresholds to the
  // wrong file.
  assert.throws(() => validateSuite(doc()), /looks like a calibration set/)
})
