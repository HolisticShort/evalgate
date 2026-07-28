# evalgate

**A pre-merge quality gate for LLM features.** Runs in CI, scores your output against a committed set of
cases, and fails the build when quality moves the wrong way — like a linter, not like a dashboard.

> **Status: v0 implemented.** 137 tests, no network required.
> Run `npm run example` to see it catch a fabricated claim end to end — no API key needed.
> [`SPEC.md`](./SPEC.md) is the design doc and explains the reasoning behind every decision below.

---

## Why

Teams ship LLM features and test them by looking at them. That works until a prompt edit, a model version
bump, or a retrieval change moves quality in a direction nobody notices until a user does.

"Just write tests" doesn't transfer, because the standard testing contract assumes determinism. Assert too
strictly and the suite fails constantly on differences nobody cares about, so the team disables it. Assert
too loosely and it passes through real regressions, so the team trusts it wrongly — which is worse than
having nothing.

evalgate's answer: **assertions return scores, not booleans**, and verdicts are computed at the suite level
against thresholds you commit to your repo.

## `grounded`

An assertion that checks whether output is *entitled to its claims*. It decomposes output into atomic
factual claims, attributes each one against the source documents the model was given, and scores what
survives:

```
score = supported / (supported + unsupported + contradicted)
```

**Claim-level faithfulness scoring is not new.** Ragas, DeepEval, TruLens, and Promptfoo all ship a version
of it, and if you only need the metric you should use one of them. What differs here is what happens to the
number:

- **It gates.** The score feeds the same threshold policy as everything else and fails the build pre-merge,
  rather than landing on a dashboard someone reviews later.
- **Contradiction is tracked separately from absence.** An unsupported claim is a gap; a contradicted claim
  is a lie. They're different bugs with different severities, and `contradictionIsCritical` can fail a case
  outright on one contradiction while tolerating ten omissions.
- **The breakdown reaches the reviewer.** The failing claim, the judge's reasoning, and the contradicting
  source span go into the PR comment. The number isn't the point — seeing exactly which sentence the model
  invented is.
- **A dropped verdict counts against the score.** If the judge returns fewer verdicts than there were
  claims, the missing ones are recorded as `unsupported` rather than shrinking the denominator. Otherwise
  an unreliable judge raises the grounding score by answering less.

The rule underneath it: **an unsourced factual claim is a defect, not a stylistic issue.**

## Quick look

```yaml
# evals/support-agent.yaml
name: support-agent
samples: 3

thresholds:
  floor: 0.80
  regression: 0.03        # fail if this PR drops the suite >3 points vs. baseline
  criticalCases:
    ids: [refund-policy, pii-leak]
    minScore: 0.95

cases:
  - id: refund-policy
    input:
      prompt: "Can I get a refund after 40 days?"
      context: [{ id: policy-v3, text: "Refunds are available within 30 days of purchase." }]
    assertions:
      - type: grounded
        contradictionIsCritical: true   # flat, like every assertion's options
      - type: noPII
      - type: length
        max: 800
```

```bash
npx evalgate run --suite evals/ --sut ./evals/sut.mjs --baseline .evalgate/baseline.json
```

`--baseline` takes a path to a result artifact, not a git ref. Create one on your base branch with
`evalgate run --json .evalgate/baseline.json` and commit it. A `--baseline` that can't be read is a config
error (exit 2), not a skipped gate — asking for a regression gate and silently not getting one is worse
than not asking for it.

Your `--sut` module exports the thing being tested, plus the judge and embedding providers. evalgate never
imports a provider SDK — that seam is what keeps the core testable offline and portable across stacks.

```js
export default {
  name: 'support-agent',
  version: process.env.GIT_SHA,      // opaque to evalgate; feeds the cache key
  async run({ prompt, context }) { return myAgent(prompt, context) },
}
export const judge = { id: 'judge-v1', async judge(prompt, schema) { /* ... */ } }
```

## RAG, and why the suite can't declare your sources

If a retriever picks the documents at run time, the context in your suite file is a *guess about the
retriever's behavior*, and grounding a claim against a guess scores the wrong thing in both directions: it
reports a hallucination when the model correctly used a chunk you didn't list, and reports grounded output
when the retriever surfaced the wrong chunk and the model faithfully used it.

So the system under test may report what it actually retrieved, and `grounded` attributes against that:

```js
async run({ prompt }) {
  const retrieved = await myRetriever(prompt)     // [{ id, text }]
  return { output: await myAgent(prompt, retrieved), retrieved }
}
```

The envelope is recognized only when **both** `output` and `retrieved` are present — `output` alone is far
too common a key in ordinary structured output to claim as a reserved word. Precedence is `sources` on the
assertion (an explicit override) → `retrieved` → the suite's `input.context`.

**Fold your index version into `sut.version`.** The cache is keyed on that string, so a re-run at an
unchanged version replays the previous retrieval verbatim. In a RAG system the index is part of the system;
if reindexing can't move the version, a reindex goes ungated.

### Scoring the retriever

`grounded` asks whether the answer was entitled to its claims *given what the model was handed*. It cannot
see a retriever that surfaced the wrong document — the generator will faithfully summarize whatever it got,
and score 1.00 doing it. That failure has no other symptom.

```yaml
  - id: wrong-document
    input:
      prompt: "How do I return a damaged item?"
    expectedDocs: [returns-v2]      # what a correct retrieval must surface
    assertions:
      - type: contextRecall
      - type: contextPrecision
      - type: grounded
```

That case is in `npm run example`, and it is the point of the whole feature:

```
  • wrong-document  0.33
      contextRecall — 0/1 expected documents retrieved — missing returns-v2
      contextPrecision — 0/2 retrieved documents were expected — 2 unlabelled: shipping-v1, hours-v1
```

`grounded` scored that case **1.00** and was right to. Recall is what caught it.

| | |
|---|---|
| `contextRecall` | Fraction of `expectedDocs` the retriever surfaced. The highest-value retrieval check, and free. `k` scores recall@k — a document ranked 48th was retrieved in name only. |
| `contextPrecision` | Fraction of retrieved documents that were expected. Catches widening top-k until recall looks good and paying for the extra chunks on every request forever. |

Both are deterministic, cost nothing, and refuse to run without a `retrieved` set rather than falling back
to the suite's declared context — scoring a retriever against the guess that was written to describe it is
a tautology that reports 1.00 forever. An empty retrieval scores **0** for precision, not a vacuous 1: "no
irrelevant documents were returned" is technically true of a dead retriever.

`expectedDocs` sits on the case, since recall and precision are two views of one labelling; an assertion
may override it. Precision scores against that labelling, so a genuinely useful but *unlabelled* document
counts against you — label a case's relevant set completely rather than listing only the doc you had in mind.

### Sources from files

A retrieval corpus doesn't belong inline in YAML:

```yaml
    context:
      - id: returns-v2
        textFile: ./docs/returns-v2.md
```

Resolved relative to the suite file, so a suite means the same thing wherever `evalgate` runs from. Setting
both `text` and `textFile` is a config error rather than a silent preference, and a YAML anchor shared
across cases reads the file once.

Real output from `npm run example`:

```
support-agent   5 cases · 3 samples · 0 cached, 15 executed

  ✗ floor              suite mean 0.467 < floor 0.8
  ✓ regression         no baseline available — regression gate skipped (not evaluated)
  ✗ criticalCases      pii-leak 0 < 0.95
  ✗ criticalAssertions order-status, pii-leak

  ✗ order-status  0.00  CRITICAL
      grounded — 0/3 claims supported · 2 contradicted · 1 unsupported
        ✗ "Your package will arrive Tuesday."
            no source mentions delivery dates
        ✗ "Shipping is free on orders over $50."
            the policy states $75, not $50
            policy-v3: "Free shipping applies to orders over $75."
        ✗ "A $60 order qualifies for free shipping."
            $60 is below the stated $75 threshold
            policy-v3: "Free shipping applies to orders over $75."
  ✗ pii-leak  0.00  CRITICAL
      noPII — PII detected: email(da************om)
      grounded — skipped — case already failed a critical assertion
  • wrong-document  0.33
      contextRecall — 0/1 expected documents retrieved — missing returns-v2
      contextPrecision — 0/2 retrieved documents were expected — 2 unlabelled: shipping-v1, hours-v1

  FAIL
```

Note what the last line of that run is doing: `pii-leak` already failed a critical assertion, so the
expensive grounding pass was **skipped rather than paid for**. That's the difference between a gate teams
leave on and one they disable.

## Drift

The gate above answers "did this PR make it worse?" It cannot answer "has this been getting worse the
whole time?" — a case that slides 0.04 per week for six weeks passes every individual regression gate by
construction. Every run appends a record to `.evalgate/history.jsonl`, which is **committed**, because the
time series can't be reconstructed after the fact.

```bash
npx evalgate drift --window 20 --threshold 0.05
```

```
support-agent   6 runs · 2026-06-01 → 2026-07-06

  ↓ suite mean             0.91 → 0.81   −0.10  −0.020/run
  ↓ refund-policy          0.95 → 0.75   −0.20  −0.040/run
  · order-status           0.88 → 0.88   +0.00  +0.000/run
  · pii-leak               1.00 → 1.00   +0.00  +0.000/run

  DRIFT   declined ≥ 0.05 over the window
```

Delta gates, slope diagnoses. A case missing from a run is treated as absent rather than zero, and a case
with fewer than three runs is reported as having no trend yet instead of being flagged — both are ways a
drift report can manufacture a regression that didn't happen. Reporting is the default; `--gate` makes it
exit 1.

## The PR comment

```bash
npx evalgate comment --json .evalgate/result.json --baseline base.json --out comment.md
```

What a reviewer sees, without opening an artifact or a CI log:

> ### ❌ evalgate — 1 of 1 suite failed
>
> **support-agent** · 4 cases · mean `0.50` (−0.36 vs baseline)
>
> | | gate | result |
> |---|---|---|
> | ❌ | `floor` | suite mean 0.5 < floor 0.8 |
> | ❌ | `criticalCases` | pii-leak 0 < 0.95 |
>
> | case | baseline | this PR | Δ |
> |---|---|---|---|
> | `deleted-case` | `0.20` | — | **removed** |
> | `order-status` 🔴 | `0.88` | `0.00` | **−0.88** |
> | `refund-policy` | `1.00` | `1.00` | — |
>
> <details><summary><code>order-status</code> — 0.00 · <b>critical</b></summary>
>
> 🔴 **contradicted** — “Shipping is free on orders over $50.”
> the policy states $75, not $50
> > `policy-v3`: “Free shipping applies to orders over $75.”
>
> </details>

The comment carries a stable marker so CI updates one comment in place instead of stacking a new one on
every push. When a body would exceed GitHub's 65,536-character limit, detail blocks are dropped
worst-kept-first and **the comment says how many it dropped and where to find them** — a body silently cut
at the limit reads as though nothing else was wrong. On a suite large enough that the delta table alone
would blow the limit, the table keeps its worst-movement rows and announces the rest: an over-limit body is
rejected by GitHub outright, and no comment is worse than a shortened one.

Two entries in that table are doing specific work. A case **deleted** in the PR is listed as `removed`,
because deleting a failing case is a way to make a gate pass and it should cost a line in review. A case
**added** in the PR reads `new` rather than `+0.40`, because that comparison was never made.

## Design principles

1. **Everything lives in the repo.** Suites, thresholds, and baselines are files, reviewed in PRs. Quality
   standards that live in a SaaS dashboard drift from the code silently.
2. **Scores, not booleans.**
3. **The gate must be cheap enough to leave on.** Content-addressed caching covers both the system's output
   and every judged assertion result, so a re-run on an unchanged system makes zero model calls. Cases run
   concurrently (`--concurrency`, default 4). A gate that costs $40 per PR gets disabled in week three, and
   one that takes an hour gets disabled in week one.
4. **Provider-agnostic core.** No SDK imports in `src/`. You bring a function; judge and embedding
   providers are injected at the edge.
5. **Explain every failure.** A red build that says `0.71 < 0.80` is useless.

## Assertions

Ordered cheap → expensive. Prefer the top; a suite made entirely of LLM-judge assertions is slow,
expensive, and circular.

| | |
|---|---|
| **Deterministic** | `schema` · `contains` · `notContains` · `regex` · `length` · `latency` · `cost` · `noPII` · `contextRecall` · `contextPrecision` |
| **Statistical** | `semanticSimilarity` · `consistency` |
| **Judged** | `rubric` · `grounded` |

Custom assertions register alongside the built-ins and get the same scoring, caching, and reporting.

## Who judges the judge

`rubric` and `grounded` use a model to evaluate a model. That's circular unless the circle is closed
deliberately. Plenty of tools acknowledge the problem; few ship a way to measure it. Here the judge gets
its own test suite:

```bash
npx evalgate calibrate --set evals/calibration.yaml --judge ./evals/sut.mjs
```

```
judge-v1-calibration   judge scripted-demo-judge · 6 human-scored cases

  ✓ agreement    judge–human agreement 0.917 ≥ minimum 0.85
  ✓ bias         judge scores 0.083 low on average (allowed ±0.1)
  · correlation  0.92 — does the judge rank cases the way humans do

  largest disagreements
    ✗ half-supported         human 1.00  judge 0.50   0.50 too harsh
        the window is supported; nothing in the sources says who pays return shipping

  CALIBRATED   agreement 0.92 — published with every judged score
```

A calibration case is an eval case plus a human score and a **committed output** — calibration holds the
output constant and varies the judge, which is the only way a score change is attributable to the judge
rather than to your application.

`bias` is split out from `agreement` because they're different bugs: a judge that's uniformly 0.2 generous
can be fixed by moving a threshold; a judge that's 0.2 off in random directions can't be fixed at all.
Averaged together, they hide each other.

Two things the harness refuses to do:

- **Calibrate against a set with no spread.** If every case should score 1.0, a judge that returns 1.0
  unconditionally scores perfectly. The set must contain at least one case the judge should fail.
- **Publish one judge's agreement under another judge's name.** The stamp is bound to a judge id; a
  mismatch warns and publishes nothing, rather than letting a judge swap inherit the old judge's credibility.

The judge model is pinned at `temperature: 0`, calibration must pass before a judge change lands, and
agreement rides along with every judged score in the run report and the history record. A judge nobody has
calibrated is a random number generator with good manners.

## What this is not

- Not production observability — no tracing, no dashboards. It runs in CI and exits with a code.
- Not a prompt playground. No UI.
- Not a benchmark suite. It won't tell you whether one model beats another; it tells you whether *your*
  application got worse than it was last week.
- Not a framework. No chains, no agent runtime.

## Prior art, and when to use something else

This is a crowded space and evalgate is not the first thing in it. Use one of these instead if it fits you
better:

| | |
|---|---|
| **Promptfoo** | The closest neighbor — open source, YAML suites, CI-oriented, a much larger assertion library, plus red-teaming. If you want breadth and maturity today, start there. |
| **DeepEval · Ragas** | Python-native metric libraries with faithfulness/hallucination scoring. If your tests already live in pytest, these fit your stack better than a Node CLI. |
| **Braintrust · LangSmith · Langfuse · Phoenix** | Hosted platforms with tracing, datasets, and production monitoring. If you need to watch what's happening in production, evalgate is explicitly not that. |

What evalgate is opinionated about, and where it differs:

- **The output is an exit code, not a dashboard.** Thresholds, suites, and baselines are files reviewed in
  PRs. The whole thing is designed to fail a build before merge and to be cheap enough that nobody turns
  it off.
- **The judge is measured, not assumed.** `evalgate calibrate` scores an LLM judge against human-scored
  cases, gates a judge change on agreement and bias, and publishes the number alongside every judged score.
  Plenty of tools name the judge-judging-a-judge problem; few ship a way to quantify it.
- **It tries hard not to lie to you.** A missing baseline isn't a pass. A case absent from a run isn't a
  zero. A dropped judge verdict isn't a smaller denominator. A truncated PR comment says it truncated. A
  config error exits 2, never 1. Every one of those is a way an eval tool can report green on a regression,
  and each is a deliberate decision documented in [`SPEC.md`](./SPEC.md).

If you only need a faithfulness score, take it from one of the libraries above. This exists for the case
where you want that score to stop a merge, and want to be able to defend the number afterward.

## Getting started

```bash
npm install --save-dev @holisticconsulting/evalgate
```

The package is scoped; the CLI it installs is called `evalgate`. Inside a project that has it as a
dependency, `npx evalgate` resolves to the local binary. **Outside one it does not** — an unrelated
`evalgate` package exists on the registry, and `npx` would fetch that instead. Run it from the project
root, or use `npx @holisticconsulting/evalgate` if you want the name to be unambiguous.

Then three files, in this order:

1. **`evals/<suite>.yaml`** — cases and thresholds, in the shape shown under [Quick look](#quick-look).
2. **`evals/sut.mjs`** — your system under test, plus a `judge` export if you use `rubric` or `grounded`.
   evalgate imports no provider SDK; this module is the only thing that talks to a model, so **the API
   key is yours and never leaves your project**.
3. **A CI workflow** — copy from [`templates/github-actions/`](./templates/github-actions/), which
   includes the baseline resolution and PR-comment steps and a README explaining what you have to supply.

```bash
npx evalgate run --suite evals/ --sut ./evals/sut.mjs
```

Exit codes: **0 pass · 1 gate failed · 2 config/runtime error.** Wire CI to treat 1 and 2 differently —
a malformed suite reported as a quality regression is how teams learn to ignore the check.

Then, in rough order of payoff:

```bash
npx evalgate calibrate --set evals/calibration.yaml --judge ./evals/sut.mjs   # if you use a judge
npx evalgate run --suite evals/ --sut ./evals/sut.mjs --json .evalgate/baseline.json   # enables the regression gate
npx evalgate drift --gate                                                     # after ~3 runs of history
```

Commit `.evalgate/history.jsonl`, `.evalgate/calibration.json`, and `.evalgate/baseline.json`. Ignore
`.evalgate/cache/` and `.evalgate/result.json` — those are machine-local.

## Status

v0 scope, open questions, and the reasoning behind every decision above are in [`SPEC.md`](./SPEC.md).
Issues and disagreement welcome — particularly on claim-extraction granularity and baseline storage, which
are the two decisions I'm least sure about.

## License

MIT
