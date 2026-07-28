import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run, mapConcurrent } from '../src/runner.js'
import { cacheKey, cacheEnabled, MemoryCache } from '../src/cache.js'
import { validateSuite, ConfigError } from '../src/config.js'
import { fakeSut, fakeJudge } from './fakes.js'
import type { Suite, AssertionConfig, CaseInput } from '../src/types.js'

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

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

const manyCases = (n: number): Suite =>
  suite({
    samples: 1,
    cases: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      input: { prompt: `p${i}` },
      assertions: [{ type: 'contains', terms: ['hello'] }] as AssertionConfig[],
    })),
  })

test('mapConcurrent preserves input order regardless of completion order', async () => {
  const delays = [30, 0, 20, 10]
  const out = await mapConcurrent(delays, 4, async d => {
    await new Promise(r => setTimeout(r, d))
    return d
  })
  assert.deepEqual(out, delays)
})

test('mapConcurrent never exceeds the limit', async () => {
  let inFlight = 0
  let peak = 0
  await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    peak = Math.max(peak, ++inFlight)
    await new Promise(r => setTimeout(r, 1))
    inFlight--
    return null
  })
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit 3`)
})

test('mapConcurrent rejects a non-positive limit rather than hanging', async () => {
  await assert.rejects(() => mapConcurrent([1], 0, async x => x), /concurrency must be an integer/)
})

test('cases run concurrently but land in suite order', async () => {
  const seen: string[] = []
  const sut = fakeSut(async (input: CaseInput) => {
    // Reverse the natural order: the last case finishes first.
    const n = Number(String(input.prompt).slice(1))
    await new Promise(r => setTimeout(r, (8 - n) * 5))
    seen.push(String(input.prompt))
    return 'hello'
  })

  const r = await run({ suite: manyCases(8), sut, concurrency: 8 })

  assert.deepEqual(
    r.cases.map(c => c.caseId),
    Array.from({ length: 8 }, (_, i) => `c${i}`),
  )
  // Completion order really was not declaration order — otherwise this test
  // would pass on a sequential runner and prove nothing.
  assert.notDeepEqual(seen, Array.from({ length: 8 }, (_, i) => `p${i}`))
})

test('a case that throws fails the run rather than being silently dropped', async () => {
  const sut = fakeSut(async (input: CaseInput) => {
    if (input.prompt === 'p2') throw new Error('provider exploded')
    return 'hello'
  })
  await assert.rejects(() => run({ suite: manyCases(5), sut, concurrency: 5 }), /provider exploded/)
})

// ---------------------------------------------------------------------------
// Assertion-result caching
// ---------------------------------------------------------------------------

const groundedSuite = (): Suite =>
  suite({
    samples: 1,
    thresholds: { floor: 0.5 },
    cases: [
      {
        id: 'g',
        input: {
          prompt: 'hi',
          context: [{ id: 'd1', text: 'The sky is blue.' }],
        },
        assertions: [{ type: 'grounded' }] as AssertionConfig[],
      },
    ],
  })

const skyClaims = { claims: [{ text: 'The sky is blue.', type: 'factual', hedged: false }] }
const skyVerdicts = {
  verdicts: [
    { claimIndex: 0, status: 'supported', evidence: [{ docId: 'd1', span: 'The sky is blue.' }], reasoning: 'stated' },
  ],
}

test('a judged assertion is cached across runs, not just the SUT output', async () => {
  const cache = new MemoryCache()

  const j1 = fakeJudge([skyClaims, skyVerdicts])
  const r1 = await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: j1, cache })
  assert.equal(j1.calls.length, 2) // extraction + attribution
  assert.equal(r1.cost.judged?.executed, 1)
  assert.equal(r1.cost.judged?.cached, 0)

  // Same case, same SUT version, same judge — the judge must not be called again.
  const j2 = fakeJudge([])
  const r2 = await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: j2, cache })
  assert.equal(j2.calls.length, 0)
  assert.equal(r2.cost.judged?.cached, 1)
  assert.equal(r2.cases[0]?.score, r1.cases[0]?.score)
})

test('a different judge id invalidates the assertion cache', async () => {
  const cache = new MemoryCache()
  await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: fakeJudge([skyClaims, skyVerdicts]), cache })

  const swapped = fakeJudge([skyClaims, skyVerdicts])
  swapped.id = 'other-judge'
  await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: swapped, cache })

  // A judge swap that reused the old judge's cached verdicts would let the new
  // judge inherit credibility it never earned.
  assert.equal(swapped.calls.length, 2)
})

test('a different output invalidates the assertion cache', async () => {
  const cache = new MemoryCache()
  await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: fakeJudge([skyClaims, skyVerdicts]), cache })

  const second = fakeJudge([skyClaims, skyVerdicts])
  // Same case and version, different text — scoring the old verdicts against
  // new output is exactly the stale-result failure the cache must never cause.
  await run({ suite: groundedSuite(), sut: fakeSut(['The sky is green.'], 'v2'), judge: second, cache })
  assert.equal(second.calls.length, 2)
})

test('deterministic assertions are not cached', async () => {
  const cache = new MemoryCache()
  const r = await run({ suite: suite({ samples: 1 }), sut: fakeSut(['hello']), cache })
  assert.equal(r.cost.judged?.executed, 0)
  assert.equal(r.cost.judged?.cached, 0)
})

test('SUT run counts stay in units of cases x samples', async () => {
  const r = await run({ suite: groundedSuite(), sut: fakeSut(['The sky is blue.']), judge: fakeJudge([skyClaims, skyVerdicts]) })
  assert.equal(r.cost.executed, 1)
  assert.equal(r.cost.cached, 0)
})

// ---------------------------------------------------------------------------
// Retrieved documents (RAG)
// ---------------------------------------------------------------------------

const retrievalSuite = (): Suite =>
  suite({
    samples: 1,
    thresholds: { floor: 0.5 },
    cases: [
      {
        id: 'r',
        // What the suite guessed the retriever would surface.
        input: { prompt: 'hi', context: [{ id: 'declared', text: 'The sky is green.' }] },
        assertions: [{ type: 'grounded' }] as AssertionConfig[],
      },
    ],
  })

test('grounded attributes against what the system retrieved, not what the suite declared', async () => {
  const judge = fakeJudge([skyClaims, skyVerdicts])
  const sut = fakeSut([
    { output: 'The sky is blue.', retrieved: [{ id: 'd1', text: 'The sky is blue.' }] },
  ])

  const r = await run({ suite: retrievalSuite(), sut, judge })

  const attribution = judge.calls[1] as string
  assert.match(attribution, /\[d1\]/)
  assert.doesNotMatch(attribution, /\[declared\]/)
  assert.equal(r.cases[0]?.score, 1)
})

test('the envelope is unwrapped so retrieved docs are not scored as claims', async () => {
  const judge = fakeJudge([skyClaims, skyVerdicts])
  const sut = fakeSut([
    { output: 'The sky is blue.', retrieved: [{ id: 'd1', text: 'The sky is blue.' }] },
  ])
  await run({ suite: retrievalSuite(), sut, judge })

  // Claim extraction must see the answer alone. Handing it the serialized
  // envelope turns every retrieved chunk into a claim about the world.
  const extraction = judge.calls[0] as string
  assert.match(extraction, /The sky is blue\./)
  assert.doesNotMatch(extraction, /retrieved/)
})

test('an object output without `retrieved` is still the output itself', async () => {
  const judge = fakeJudge([{ claims: [] }])
  const sut = fakeSut([{ output: 'not an envelope', answer: 42 }])
  const r = await run({ suite: retrievalSuite(), sut, judge })

  // `output` alone is far too common a key in ordinary structured output to be
  // treated as a reserved envelope marker.
  assert.match(judge.calls[0] as string, /"answer": 42/)
  assert.equal(r.cases[0]?.score, 1)
})

test('an explicit sources on the assertion still overrides retrieved', async () => {
  const judge = fakeJudge([skyClaims, skyVerdicts])
  const s = suite({
    samples: 1,
    thresholds: { floor: 0.5 },
    cases: [
      {
        id: 'r',
        input: { prompt: 'hi' },
        assertions: [
          { type: 'grounded', sources: [{ id: 'pinned', text: 'The sky is blue.' }] },
        ] as AssertionConfig[],
      },
    ],
  })
  const sut = fakeSut([{ output: 'The sky is blue.', retrieved: [{ id: 'd1', text: 'x' }] }])
  await run({ suite: s, sut, judge })

  assert.match(judge.calls[1] as string, /\[pinned\]/)
})

test('the retrieved set is part of the assertion cache key', () => {
  const base = {
    caseInput: { prompt: 'hi' },
    sutVersion: 'v1',
    modelId: 'fake-judge',
    assertion: { type: 'grounded' } as AssertionConfig,
    output: 'The sky is blue.',
  }
  const a = cacheKey({ ...base, modelParams: { kind: 'assertion', retrieved: [{ id: 'd1', text: 'x' }] } })
  const b = cacheKey({ ...base, modelParams: { kind: 'assertion', retrieved: [{ id: 'd2', text: 'x' }] } })

  // A retriever can change what it returns without any code changing. If the
  // retrieved set were outside the key, the gate would serve a grounding score
  // for a corpus the system no longer sees.
  assert.notEqual(a, b)
})

// Worth knowing, and the reason the test above is a key-level test rather than
// a two-run test: the SUT output cache is keyed on the version string alone, so
// a re-run at an unchanged version replays the previous retrieval verbatim. In
// a RAG system the index is part of the system — fold its version into
// `sut.version`, or a reindex goes ungated.
test('an unchanged SUT version replays the cached retrieval', async () => {
  const cache = new MemoryCache()
  const first = fakeJudge([skyClaims, skyVerdicts])
  await run({
    suite: retrievalSuite(),
    sut: fakeSut([{ output: 'The sky is blue.', retrieved: [{ id: 'd1', text: 'The sky is blue.' }] }]),
    judge: first,
    cache,
  })

  const second = fakeJudge([])
  const r = await run({
    suite: retrievalSuite(),
    sut: fakeSut([{ output: 'The sky is blue.', retrieved: [{ id: 'd2', text: 'The sky is blue.' }] }]),
    judge: second,
    cache,
  })
  assert.equal(second.calls.length, 0)
  assert.equal(r.cost.cached, 1)
})

test('grounded with no context and no retrieved names all three ways to supply sources', async () => {
  const s = suite({
    samples: 1,
    cases: [{ id: 'r', input: { prompt: 'hi' }, assertions: [{ type: 'grounded' }] as AssertionConfig[] }],
  })
  await assert.rejects(
    () => run({ suite: s, sut: fakeSut(['x']), judge: fakeJudge([]) }),
    /input\.context.*sources.*retrieved/s,
  )
})
