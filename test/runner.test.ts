import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../src/runner.js'
import { cacheKey, cacheEnabled, MemoryCache } from '../src/cache.js'
import { validateSuite, ConfigError } from '../src/config.js'
import { fakeSut, fakeJudge } from './fakes.js'
import type { Suite, AssertionConfig } from '../src/types.js'

const suite = (over: Partial<Suite> = {}): Suite => ({
  name: 's',
  samples: 3,
  thresholds: { floor: 0.8 },
  cases: [
    {
      id: 'greeting',
      input: { prompt: 'hi' },
      assertions: [{ type: 'contains', terms: ['hello'] }] as AssertionConfig[],
    },
  ],
  ...over,
})

test('runs every sample and takes the median', async () => {
  const sut = fakeSut(['hello', 'hello', 'nope'])
  const r = await run({ suite: suite(), sut })
  assert.equal(sut.runs, 3)
  assert.equal(r.cases[0]?.samples.length, 3)
  assert.equal(r.cases[0]?.score, 1) // median of [1,1,0]
  assert.equal(r.passed, true)
})

test('flags an unstable case without letting variance change the score', async () => {
  const r = await run({ suite: suite(), sut: fakeSut(['hello', 'nope', 'hello']) })
  assert.equal(r.cases[0]?.unstable, true)
  assert.equal(r.cases[0]?.score, 1)
})

test('a critical assertion fails the run even with a passing mean', async () => {
  const s = suite({
    cases: [
      {
        id: 'leak',
        input: { prompt: 'p' },
        assertions: [{ type: 'contains', terms: ['hello'] }, { type: 'noPII' }] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['hello a@b.com']) })
  assert.equal(r.passed, false)
  assert.ok(r.gates.some(g => g.gate === 'criticalAssertions' && !g.passed))
})

test('expensive assertions are skipped once a case is already critical', async () => {
  // The short-circuit that keeps the gate cheap enough to leave on.
  const judge = fakeJudge([])
  const s = suite({
    samples: 1,
    cases: [
      {
        id: 'leak',
        input: { prompt: 'p', context: [{ id: 'd', text: 'x' }] },
        assertions: [{ type: 'noPII' }, { type: 'grounded' }] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['a@b.com']), judge })
  assert.equal(judge.calls.length, 0, 'grounded must not have spent a judge call')
  assert.match(r.cases[0]?.assertions.find(a => a.type === 'grounded')?.explanation ?? '', /skipped/)
})

test('assertions are reported in declaration order, not execution order', async () => {
  const s = suite({
    samples: 1,
    cases: [
      {
        id: 'c',
        input: { prompt: 'p' },
        assertions: [{ type: 'length', max: 5 }, { type: 'contains', terms: ['hello'] }] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['hello']) })
  assert.deepEqual(r.cases[0]?.assertions.map(a => a.type), ['length', 'contains'])
})

test('two assertions of the same type are scored and reported separately', async () => {
  // Results used to be matched back to declaration order by type, which
  // collapsed same-type assertions onto one result: the second was dropped and
  // the first counted twice, silently changing the score.
  const s = suite({
    samples: 1,
    thresholds: { floor: 0.8 },
    cases: [
      {
        id: 'c',
        input: { prompt: 'p' },
        assertions: [
          { type: 'contains', terms: ['hello'] },
          { type: 'contains', terms: ['absent'] },
        ] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['hello world']) })
  assert.deepEqual(r.cases[0]?.assertions.map(a => a.score), [1, 0])
  assert.equal(r.cases[0]?.score, 0.5, 'one hit and one miss is 0.5, not 1')
  assert.equal(r.passed, false)
})

test('a critical flag on the second assertion of a type is not lost', async () => {
  // The worst form of the same bug: a leak reported clean and the gate green.
  const s = suite({
    samples: 1,
    cases: [
      {
        id: 'leak',
        input: { prompt: 'p' },
        assertions: [{ type: 'noPII' }, { type: 'noPII', patterns: ['SECRET-\\d+'] }] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['here is SECRET-42']) })
  assert.equal(r.cases[0]?.critical, true)
  assert.equal(r.passed, false)
  assert.ok(r.gates.some(g => g.gate === 'criticalAssertions' && !g.passed))
})

test('the short-circuit still fires when the critical assertion is a duplicate type', async () => {
  const judge = fakeJudge([])
  const s = suite({
    samples: 1,
    cases: [
      {
        id: 'leak',
        input: { prompt: 'p', context: [{ id: 'd', text: 'x' }] },
        assertions: [
          { type: 'noPII' },
          { type: 'noPII', patterns: ['SECRET-\\d+'] },
          { type: 'grounded' },
        ] as AssertionConfig[],
      },
    ],
  })
  const r = await run({ suite: s, sut: fakeSut(['here is SECRET-42']), judge })
  assert.equal(judge.calls.length, 0, 'grounded must not have spent a judge call')
  assert.match(r.cases[0]?.assertions[2]?.explanation ?? '', /skipped/)
})

test('cache prevents re-running the system under test', async () => {
  const cache = new MemoryCache()
  const s = suite({ samples: 2 })

  const first = fakeSut(['hello', 'hello'])
  await run({ suite: s, sut: first, cache })
  assert.equal(first.runs, 2)

  const second = fakeSut(['hello', 'hello'])
  const r = await run({ suite: s, sut: second, cache })
  assert.equal(second.runs, 0, 'unchanged case on unchanged version must be free')
  assert.equal(r.cost.cached, 2)
})

test('a version bump invalidates the cache', async () => {
  const cache = new MemoryCache()
  await run({ suite: suite({ samples: 1 }), sut: fakeSut(['hello'], 'v1'), cache })
  const next = fakeSut(['hello'], 'v2')
  await run({ suite: suite({ samples: 1 }), sut: next, cache })
  assert.equal(next.runs, 1)
})

test('an unversioned system disables the cache loudly', async () => {
  const warnings: string[] = []
  // Built inline rather than via fakeSut: a default parameter fires on an
  // explicit `undefined`, so the helper would silently hand back version 'v1'
  // and the test would pass for the wrong reason.
  const sut = { name: 'unversioned', async run() { return 'hello' } }
  await run({
    suite: suite({ samples: 1 }),
    sut,
    cache: new MemoryCache(),
    warn: m => warnings.push(m),
  })
  // Silently serving stale results is the worst failure this tool can have.
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /cache disabled/)
})

// --- cache keys ------------------------------------------------------------

test('cache keys are stable across key ordering', () => {
  const base = {
    caseInput: { prompt: 'p' },
    sutVersion: 'v1',
    modelId: 'm',
    assertion: { type: 'contains', terms: ['a'] } as AssertionConfig,
  }
  const a = cacheKey({ ...base, modelParams: { temperature: 0, top_p: 1 } })
  const b = cacheKey({ ...base, modelParams: { top_p: 1, temperature: 0 } })
  assert.equal(a, b, 'unsorted serialization would silently produce cache misses')
})

test('cache keys change when the assertion config changes', () => {
  const base = { caseInput: { prompt: 'p' }, sutVersion: 'v1', modelId: 'm', modelParams: {} }
  const a = cacheKey({ ...base, assertion: { type: 'contains', terms: ['a'] } as AssertionConfig })
  const b = cacheKey({ ...base, assertion: { type: 'contains', terms: ['b'] } as AssertionConfig })
  assert.notEqual(a, b)
})

test('cacheEnabled requires a version', () => {
  assert.equal(cacheEnabled('v1', () => {}), true)
  assert.equal(cacheEnabled(undefined, () => {}), false)
})

// --- config validation -----------------------------------------------------

test('config errors are specific', () => {
  assert.throws(() => validateSuite({ name: 's' }), ConfigError)
  assert.throws(
    () => validateSuite({ name: 's', thresholds: {}, cases: [] }),
    /at least one of floor/,
  )
  assert.throws(
    () =>
      validateSuite({
        name: 's',
        thresholds: { floor: 0.8 },
        cases: [
          { id: 'dup', input: { prompt: 'p' }, assertions: [{ type: 'contains' }] },
          { id: 'dup', input: { prompt: 'p' }, assertions: [{ type: 'contains' }] },
        ],
      }),
    /duplicate case id/,
  )
  assert.throws(
    () =>
      validateSuite({
        name: 's',
        thresholds: { floor: 0.8 },
        cases: [{ id: 'a', input: { prompt: 'p' }, assertions: [{ type: 'contains' }], weights: [1, 2] }],
      }),
    /1 assertions but 2 weights/,
  )
})

test('a valid suite passes validation unchanged', () => {
  const s = validateSuite({
    name: 's',
    thresholds: { floor: 0.8 },
    cases: [{ id: 'a', input: { prompt: 'p' }, assertions: [{ type: 'contains', terms: ['x'] }] }],
  })
  assert.equal(s.name, 's')
  assert.equal(s.cases.length, 1)
})
