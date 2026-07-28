import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grounded } from '../src/assertions/grounded.js'
import { schema, contains, notContains, length, noPII } from '../src/assertions/deterministic.js'
import { semanticSimilarity } from '../src/assertions/semantic.js'
import { contextRecall, contextPrecision } from '../src/assertions/retrieval.js'
import { byCost, registered } from '../src/assertions/index.js'
import { validate } from '../src/schema.js'
import { fakeJudge, fakeEmbed } from './fakes.js'
import type { EvalCase, GroundedMeta } from '../src/types.js'

const evalCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: 'c',
  input: { prompt: 'p' },
  assertions: [],
  ...over,
})

// --- deterministic ---------------------------------------------------------

test('contains gives partial credit', async () => {
  const r = await contains.evaluate(
    { terms: ['alpha', 'beta', 'gamma', 'delta'] },
    { case: evalCase(), output: 'alpha and beta only' },
  )
  assert.equal(r.score, 0.5)
  assert.match(r.explanation, /missing: gamma, delta/)
})

test('notContains scores the fraction absent', async () => {
  const r = await notContains.evaluate(
    { terms: ['secret', 'password'] },
    { case: evalCase(), output: 'the password is hidden' },
  )
  assert.equal(r.score, 0.5)
})

test('length falls off linearly rather than off a cliff', async () => {
  const near = await length.evaluate({ max: 100 }, { case: evalCase(), output: 'x'.repeat(110) })
  const far = await length.evaluate({ max: 100 }, { case: evalCase(), output: 'x'.repeat(400) })
  // 810 chars against an 800 limit is not the same defect as 4,000.
  assert.ok(near.score > 0.7, `expected near-miss to score high, got ${near.score}`)
  assert.equal(far.score, 0)
  assert.equal((await length.evaluate({ max: 100 }, { case: evalCase(), output: 'x'.repeat(50) })).score, 1)
})

test('noPII is critical and redacts what it reports', async () => {
  const r = await noPII.evaluate({}, { case: evalCase(), output: 'reach me at chris@example.com' })
  assert.equal(r.score, 0)
  assert.equal(r.critical, true)
  // The report says what leaked; it does not leak it again.
  assert.ok(!r.explanation.includes('chris@example.com'))
  assert.match(r.explanation, /email/)
})

test('noPII passes clean output', async () => {
  const r = await noPII.evaluate({}, { case: evalCase(), output: 'no identifiers here' })
  assert.equal(r.score, 1)
})

test('schema reports the specific violation', async () => {
  const r = await schema.evaluate(
    { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    { case: evalCase(), output: '{"id": 42}' },
  )
  assert.equal(r.score, 0)
  assert.match(r.explanation, /expected string, got number/)
})

test('schema fails unparseable output distinctly', async () => {
  const r = await schema.evaluate({ schema: { type: 'object' } }, { case: evalCase(), output: 'not json' })
  assert.match(r.explanation, /not valid JSON/)
})

test('schema validator ignores unsupported keywords rather than rejecting', () => {
  // An eval suite should not fail because the author pasted a keyword we skip.
  assert.deepEqual(validate({ a: 1 }, { type: 'object', $comment: 'x', allOf: [] }), [])
})

test('schema validator enforces the documented subset', () => {
  assert.equal(validate('abc', { type: 'string', minLength: 5 }).length, 1)
  assert.equal(validate(3, { type: 'number', maximum: 2 }).length, 1)
  assert.equal(validate([1, 2, 3], { type: 'array', maxItems: 2 }).length, 1)
  assert.equal(validate({ a: 1, b: 2 }, { type: 'object', properties: { a: {} }, additionalProperties: false }).length, 1)
  assert.equal(validate('x', { type: ['string', 'null'] }).length, 0)
  assert.equal(validate(null, { type: ['string', 'null'] }).length, 0)
})

// --- semantic --------------------------------------------------------------

test('semanticSimilarity rescales through the floor', async () => {
  // Raw cosine of unrelated text routinely lands near 0.6; mapping that to a
  // passing score is the trap this rescaling exists to avoid.
  const embed = fakeEmbed({ out: [1, 0], ref: [0, 1] })
  const r = await semanticSimilarity.evaluate(
    { reference: 'ref', floor: 0.6 },
    { case: evalCase(), output: 'out', embed },
  )
  assert.equal(r.score, 0)
})

test('semanticSimilarity throws when no reference exists', async () => {
  const embed = fakeEmbed({})
  await assert.rejects(
    () => semanticSimilarity.evaluate({}, { case: evalCase(), output: 'out', embed }),
    /no reference/,
  )
})

// --- ordering --------------------------------------------------------------

test('assertions execute cheapest first', () => {
  const ordered = byCost([{ type: 'grounded' }, { type: 'noPII' }, { type: 'semanticSimilarity' }])
  assert.deepEqual(ordered.map(a => a.type), ['noPII', 'semanticSimilarity', 'grounded'])
})

test('all v0 assertions are registered', () => {
  assert.deepEqual(registered(), [
    'contains', 'contextPrecision', 'contextRecall', 'grounded', 'length',
    'noPII', 'notContains', 'regex', 'rubric', 'schema', 'semanticSimilarity',
  ])
})

// --- grounded --------------------------------------------------------------

const sources = [{ id: 'policy', text: 'Refunds are available within 30 days.' }]

test('grounded catches a fabricated claim end to end', async () => {
  const judge = fakeJudge([
    {
      claims: [
        { text: 'Refunds are available within 30 days.', type: 'factual', hedged: false },
        { text: 'Your package will arrive Tuesday.', type: 'temporal', hedged: false },
      ],
    },
    {
      verdicts: [
        { claimIndex: 0, status: 'supported', evidence: [{ docId: 'policy', span: 'within 30 days' }], reasoning: 'stated' },
        { claimIndex: 1, status: 'unsupported', evidence: [], reasoning: 'no source mentions delivery dates' },
      ],
    },
  ])

  const r = await grounded.evaluate(
    {},
    { case: evalCase({ input: { prompt: 'p', context: sources } }), output: 'text', judge },
  )

  assert.equal(r.score, 0.5)
  const meta = r.meta as GroundedMeta
  assert.equal(meta.unsupported, 1)
  // The point is the sentence, not the number — a reviewer must see it.
  assert.equal(meta.claims[1]?.claim.text, 'Your package will arrive Tuesday.')
})

test('grounded excludes hedged claims by default', async () => {
  const judge = fakeJudge([
    { claims: [{ text: 'It may take a while.', type: 'factual', hedged: true }] },
  ])
  const r = await grounded.evaluate(
    {},
    { case: evalCase({ input: { prompt: 'p', context: sources } }), output: 'o', judge },
  )
  // No attribution call should have been needed at all.
  assert.equal(judge.calls.length, 1)
  assert.equal(r.score, 1)
})

test('grounded counts a claim the judge dropped as unsupported', async () => {
  // Otherwise an unreliable judge inflates the score by answering less.
  const judge = fakeJudge([
    {
      claims: [
        { text: 'A', type: 'factual', hedged: false },
        { text: 'B', type: 'factual', hedged: false },
      ],
    },
    { verdicts: [{ claimIndex: 0, status: 'supported', evidence: [], reasoning: 'ok' }] },
  ])
  const r = await grounded.evaluate(
    {},
    { case: evalCase({ input: { prompt: 'p', context: sources } }), output: 'o', judge },
  )
  assert.equal(r.score, 0.5)
  assert.match((r.meta as GroundedMeta).claims[1]?.reasoning ?? '', /no verdict/)
})

test('grounded reads its options flat off the assertion config', async () => {
  // Regression: options were once nested under a `config` key, which read as
  // undefined for every option — a suite asking for contradictionIsCritical
  // silently got a passing case.
  const judge = fakeJudge([
    { claims: [{ text: 'Refunds take 90 days.', type: 'factual', hedged: false }] },
    {
      verdicts: [
        { claimIndex: 0, status: 'contradicted', evidence: [{ docId: 'policy', span: '30 days' }], reasoning: 'policy says 30' },
      ],
    },
  ])
  const r = await grounded.evaluate(
    { contradictionIsCritical: true },
    { case: evalCase({ input: { prompt: 'p', context: sources } }), output: 'o', judge },
  )
  assert.equal(r.critical, true)
})

test('noPII does not swallow sentence punctuation into an email match', async () => {
  const r = await noPII.evaluate({}, { case: evalCase(), output: 'write to dana@example.com.' })
  const hits = (r.meta as { hits: { kind: string; value: string }[] }).hits
  // Redacted form preserves the real last two characters — "om", not "m."
  assert.ok(hits[0]?.value.endsWith('om'), `got ${hits[0]?.value}`)
})

test('grounded refuses to run without a judge or without sources', async () => {
  // Degrading to a keyword heuristic would be worse than failing — people
  // believe a number once it exists.
  await assert.rejects(
    () => grounded.evaluate({}, { case: evalCase(), output: 'o' }),
    /requires a judge/,
  )
  await assert.rejects(
    () => grounded.evaluate({}, { case: evalCase(), output: 'o', judge: fakeJudge([]) }),
    /no source documents/,
  )
})

// --- retrieval -------------------------------------------------------------

const docs = (...ids: string[]) => ids.map(id => ({ id, text: `body of ${id}` }))

const retrievalCtx = (retrieved: string[], expectedDocs?: string[]) => ({
  case: { ...evalCase(), ...(expectedDocs ? { expectedDocs } : {}) },
  output: 'answer',
  retrieved: docs(...retrieved),
})

test('contextRecall scores the expected documents that were surfaced', async () => {
  const r = await contextRecall.evaluate({ expectedDocs: ['a', 'b'] }, retrievalCtx(['a', 'z']))
  assert.equal(r.score, 0.5)
  assert.match(r.explanation, /missing b/)
})

test('contextRecall names every missing document, not just the count', async () => {
  const r = await contextRecall.evaluate({ expectedDocs: ['a', 'b', 'c'] }, retrievalCtx(['c']))
  assert.match(r.explanation, /missing a, b/)
})

test('contextRecall@k ignores documents ranked past k', async () => {
  // Retrieved 48th is retrieved in name only — the generator never reads that far.
  const ctx = retrievalCtx(['x', 'y', 'a'])
  assert.equal((await contextRecall.evaluate({ expectedDocs: ['a'] }, ctx)).score, 1)
  assert.equal((await contextRecall.evaluate({ expectedDocs: ['a'], k: 2 }, ctx)).score, 0)
})

test('contextPrecision penalises retrieving more than was wanted', async () => {
  const r = await contextPrecision.evaluate({ expectedDocs: ['a'] }, retrievalCtx(['a', 'x', 'y', 'z']))
  assert.equal(r.score, 0.25)
  assert.match(r.explanation, /3 unlabelled/)
})

test('contextPrecision scores an empty retrieval 0, not a vacuous 1', async () => {
  // "No irrelevant documents were returned" is technically true of a dead
  // retriever, and reporting it as perfect precision is exactly the green this
  // tool must never show.
  const r = await contextPrecision.evaluate({ expectedDocs: ['a'] }, retrievalCtx([]))
  assert.equal(r.score, 0)
  assert.match(r.explanation, /nothing was retrieved/)
})

test('retrieval assertions read expectedDocs off the case when the assertion omits it', async () => {
  const r = await contextRecall.evaluate({}, retrievalCtx(['a'], ['a']))
  assert.equal(r.score, 1)
})

test('an assertion-level expectedDocs overrides the case', async () => {
  const r = await contextRecall.evaluate({ expectedDocs: ['b'] }, retrievalCtx(['a'], ['a']))
  assert.equal(r.score, 0)
})

test('retrieval assertions refuse to score without a retrieved set', async () => {
  // Falling back to the case's declared context would score the suite's guess
  // about the retriever against itself and report 1.00 forever.
  await assert.rejects(
    () =>
      contextRecall.evaluate(
        { expectedDocs: ['a'] },
        { case: evalCase(), output: 'answer' },
      ),
    /must return \{ output, retrieved \}/,
  )
})

test('retrieval assertions refuse to score without expectedDocs', async () => {
  await assert.rejects(
    () => contextPrecision.evaluate({}, retrievalCtx(['a'])),
    /needs expectedDocs/,
  )
})

test('retrieval assertions reject a nonsense k rather than silently ignoring it', async () => {
  await assert.rejects(
    () => contextRecall.evaluate({ expectedDocs: ['a'], k: 0 }, retrievalCtx(['a'])),
    /k must be an integer/,
  )
})

test('retrieval assertions are free — a RAG suite must afford them on every case', () => {
  assert.equal(contextRecall.cost, 'free')
  assert.equal(contextPrecision.cost, 'free')
})
