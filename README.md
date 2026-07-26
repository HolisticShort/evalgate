# evalgate

**A pre-merge quality gate for LLM features.** Runs in CI, scores your output against a committed set of
cases, and fails the build when quality moves the wrong way — like a linter, not like a dashboard.

> **Status: v0 implemented.** 61 tests, no network required.
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

## What makes it different

**`grounded`** — an assertion that checks whether output is *entitled to its claims*.

Most eval tooling can tell you whether output looks right. Almost none can tell you whether the model made
something up. `grounded` decomposes output into atomic factual claims, attributes each one against the
source documents the model was given, and scores what survives:

```
score = supported / (supported + unsupported + contradicted)
```

The number isn't the point. The point is a reviewer opening a failed check and seeing exactly which
sentence the model invented, and which source span contradicts it.

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
        config: { contradictionIsCritical: true }
      - type: noPII
      - type: length
        max: 800
```

```bash
npx evalgate run --suite evals/ --sut ./evals/sut.mjs --baseline .evalgate/baseline.json
```

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

Real output from `npm run example`:

```
support-agent   4 cases · 3 samples · 0 cached, 12 executed

  ✗ floor              suite mean 0.5 < floor 0.8
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

## Design principles

1. **Everything lives in the repo.** Suites, thresholds, and baselines are files, reviewed in PRs. Quality
   standards that live in a SaaS dashboard drift from the code silently.
2. **Scores, not booleans.**
3. **The gate must be cheap enough to leave on.** Content-addressed caching, so unchanged cases on an
   unchanged system are free. A gate that costs $40 per PR gets disabled in week three.
4. **Provider-agnostic core.** No SDK imports in `src/`. You bring a function; judge and embedding
   providers are injected at the edge.
5. **Explain every failure.** A red build that says `0.71 < 0.80` is useless.

## Assertions

Ordered cheap → expensive. Prefer the top; a suite made entirely of LLM-judge assertions is slow,
expensive, and circular.

| | |
|---|---|
| **Deterministic** | `schema` · `contains` · `notContains` · `regex` · `length` · `latency` · `cost` · `noPII` |
| **Statistical** | `semanticSimilarity` · `consistency` |
| **Judged** | `rubric` · `grounded` |

Custom assertions register alongside the built-ins and get the same scoring, caching, and reporting.

## Who judges the judge

`rubric` and `grounded` use a model to evaluate a model. That's circular unless the circle is closed
deliberately, and most tools that do it never mention it. So: the judge model is **pinned** at
`temperature: 0`, it has its **own calibration set** of human-scored cases committed to the repo,
calibration must pass before a judge change lands, and **judge–human agreement is published in every
report**. A judge nobody has calibrated is a random number generator with good manners.

## What this is not

- Not production observability — no tracing, no dashboards. It runs in CI and exits with a code.
- Not a prompt playground. No UI.
- Not a benchmark suite. It won't tell you whether one model beats another; it tells you whether *your*
  application got worse than it was last week.
- Not a framework. No chains, no agent runtime.

## Status

v0 scope, open questions, and the reasoning behind every decision above are in [`SPEC.md`](./SPEC.md).
Issues and disagreement welcome — particularly on claim-extraction granularity and baseline storage, which
are the two decisions I'm least sure about.

## License

MIT
