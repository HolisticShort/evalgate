# evalgate — Design Spec

**Status:** v0 design, written before implementation. **v0 now implemented** — see "Scope for v0" at the end
for what shipped and what deferred.
**Author:** Chris Short

---

## The problem

Teams ship LLM features and test them by looking at them. That works until it doesn't — a prompt edit,
a model version bump, a retrieval change, and output quality moves in a direction nobody notices until a
user does.

The obvious fix is "write tests." But the standard testing contract assumes determinism: same input, same
output, assert equality. LLM output breaks that contract on every axis. So teams either skip testing
entirely, or they buy a heavyweight observability SaaS that watches production *after* the regression
shipped.

The gap is a **pre-merge gate**: something that runs in CI, on a pull request, against a known set of
cases, and fails the build when quality moves the wrong way — the same way a linter or a type checker does.

That's evalgate.

## Non-goals

Stating these first, because scope discipline is most of the design.

- **Not production observability.** No tracing, no dashboards, no live monitoring. Those are solved and
  the good tools are expensive for a reason. evalgate runs in CI and exits with a code.
- **Not a prompt IDE or playground.** No UI. Config is files in your repo, versioned with your code.
- **Not a benchmark suite.** It doesn't tell you whether GPT beats Claude. It tells you whether *your*
  application got worse than it was last week.
- **Not a framework.** No orchestration, no chains, no agent runtime. You bring a function that takes
  input and returns output. evalgate never calls a model provider on your behalf in the system under test.

## Design principles

1. **Everything lives in the repo.** Suites, cases, thresholds, and baselines are files, reviewed in PRs.
   If quality standards live in a SaaS dashboard, they drift from the code silently.
2. **Scores, not booleans.** See "The determinism problem" below.
3. **The gate must be cheap enough to leave on.** A gate that costs $40 and eight minutes per PR gets
   disabled in week three. Caching and sampling strategy are load-bearing, not optimizations.
4. **Provider-agnostic core.** No SDK dependency in `src/`. Adapters are optional and live at the edge.
5. **Explain every failure.** A red build that says `score 0.71 < 0.80` is useless. Failures carry the
   case, the output, the assertion, and the reason.

---

## The determinism problem

This is the central design decision, so it gets its own section.

A conventional test is a boolean: it passed or it didn't. Applying that to LLM output produces one of two
failure modes, both fatal:

- **Assert too strictly** (exact match, strict schema on prose) → the suite fails constantly on
  differences nobody cares about. Team disables it.
- **Assert too loosely** (output is non-empty, contains a keyword) → the suite passes through real
  regressions. Team trusts it, wrongly. Worse than nothing.

**Decision: assertions return a score in [0,1] with an explanation. Verdicts are computed at the suite
level against thresholds, not per-case.**

```
Assertion  → { score: 0..1, explanation: string, meta?: unknown }
Case       → weighted mean of its assertion scores
Suite      → aggregate of case scores, compared against a threshold policy
```

This lets a suite say the thing that's actually true: *"92% of cases hold, and the 8% that don't are these
three, here's why."*

### Threshold policy

Three gates, any of which can fail the build. They answer different questions:

| Gate | Question | Typical config |
|---|---|---|
| `floor` | Is absolute quality acceptable? | suite mean ≥ 0.80 |
| `regression` | Did this PR make it worse? | suite mean ≥ baseline − 0.03 |
| `criticalCases` | Did a case we can never fail, fail? | listed case IDs must score ≥ 0.9 |

`regression` is the one that earns its keep. Absolute floors get tuned until they pass; relative movement
against a committed baseline is much harder to rationalize away.

### Sampling and flake

Same input, same model, different output. A single sample per case makes the suite itself noisy, and a
noisy gate is an ignored gate.

**Decision: `samples: n` per suite (default 3). Case score is the median.** Median over mean because a
single degenerate sample shouldn't drag a case under threshold — but three degenerate samples should.

The suite records observed variance per case. High-variance cases are surfaced in the report as
`unstable`, because a case whose score swings 0.4 between runs is telling you something real about the
feature, not about the test.

---

## Assertion types

Ordered from cheap and deterministic to expensive and judgment-based. **Prefer the top of this list.** A
suite made entirely of LLM-judge assertions is expensive, slow, and circular.

### Deterministic (free, instant)

| Assertion | Score model |
|---|---|
| `schema` | JSON Schema validation → 1 or 0, plus the validation errors as explanation |
| `contains` / `notContains` | fraction of required terms present |
| `regex` | match or not |
| `length` | within band → 1; outside → linear falloff, not a cliff |
| `latency` | p50/p95 against budget |
| `cost` | tokens against budget |
| `noPII` | pattern sweep for emails, phones, SSNs, keys — score 0 on any hit, always critical |

### Statistical (cheap, needs an embedding model)

| Assertion | Score model |
|---|---|
| `semanticSimilarity` | cosine against a reference answer, rescaled through a configured floor so that "unrelated" maps to 0 rather than 0.6 |
| `consistency` | pairwise similarity across the n samples — measures whether the feature is stable at all, independent of correctness |

### Judged (expensive, non-deterministic — see "Who judges the judge")

| Assertion | Score model |
|---|---|
| `rubric` | LLM judge scores output against a written rubric, returns a structured verdict |
| `grounded` | **the distinctive one — see below** |

---

## `grounded` — the assertion this library exists for

Most eval tooling can tell you whether output *looks* right. Almost none can tell you whether output is
*entitled to its claims*.

The rule, stated plainly: **an unsourced factual claim is a defect, not a stylistic issue.** If a feature
summarizes documents, answers from a knowledge base, or generates a report from data, then every factual
assertion in its output must trace to something in the provided context. Anything else is the model
filling a gap with plausible text — which is exactly the failure mode that destroys user trust and is
exactly the one keyword matching cannot catch.

**Pipeline:**

```
output ──► [1] claim extraction ──► [2] attribution ──► [3] scoring
                    │                      │
              atomic factual         each claim matched
              claims, one            against source spans
              assertion each         → supported | unsupported | contradicted
```

**Step 1 — extraction.** Decompose output into atomic factual claims. Opinions, hedges, questions, and
direct quotes from the user are excluded and do not count against the score. Getting this decomposition
right is most of the difficulty: "Revenue grew 12% because the new market opened" is two claims, and the
second one is causal, which is a different evidentiary standard than the first.

**Step 2 — attribution.** Each claim is matched against the supplied source documents. Verdicts:
`supported` (a span entails it), `unsupported` (nothing entails it), `contradicted` (a span contradicts
it). Contradiction is tracked separately from absence because they are different bugs with different
severities — an unsupported claim is a gap, a contradicted claim is a lie.

**Step 3 — scoring.**

```
score = supported / (supported + unsupported + contradicted)
```

with `contradicted > 0` optionally forcing the case critical, since a single contradiction usually
matters more than ten omissions.

**Output includes the claim-level breakdown.** The value isn't the number — it's a reviewer opening a
failed PR check and seeing exactly which sentence the model made up.

### Configuration

```yaml
- type: grounded
  sources: ${case.context}        # docs the model was given
  claimTypes: [factual, causal, numeric]   # what to hold accountable
  ignoreHedged: true              # "it may be that..." isn't a claim
  contradictionIsCritical: true
```

---

## Who judges the judge

`rubric` and `grounded` use a model to evaluate a model. That is circular unless the circle is closed
deliberately, and most tools that do this never mention it. So:

1. **The judge model is pinned** — explicit version, explicit params, `temperature: 0`. It is
   infrastructure, not a place to save money. It does not float when the application model changes.
2. **The judge has its own calibration set.** A small suite of cases with human-assigned ground-truth
   scores, committed to the repo. `evalgate calibrate` runs the judge against it and reports agreement.
3. **Calibration runs on judge changes, not on every PR.** Changing the judge model or the judge prompt
   requires re-calibration to pass, the same way changing a compiler requires re-running the test suite.
4. **Agreement is published in the report.** If judge–human agreement is 0.71, every score that judge
   produced carries that uncertainty and the report says so.

A judge nobody has calibrated is a random number generator with good manners.

---

## Caching

Evals cost money and wall-clock time. Both scale with the number of contributors, which means the naive
design gets more expensive exactly as it gets more useful, and then gets turned off.

**Content-addressed cache**, keyed on:

```
sha256(caseInput + systemUnderTestVersion + modelId + modelParams + assertionConfig)
```

Unchanged cases on an unchanged system are free. A PR that edits one prompt re-runs the cases that touch
that prompt. Cache lives in CI cache or a committed lockfile-style artifact, and is invalidated explicitly
by `evalgate run --no-cache`.

**Corollary that shapes the API:** the system under test must be addressable by version. The caller
supplies a version string (git SHA, prompt hash, whatever is meaningful) and evalgate treats it as opaque.
Getting this wrong means silently serving stale results, so a missing version disables the cache with a
loud warning rather than guessing.

---

## Drift detection

The suite writes one newline-delimited JSON record per run to `.evalgate/history.jsonl`, committed.

```
{ "ts": "...", "sut": "a1b2c3d", "suite": "support-agent", "mean": 0.86,
  "cases": { "refund-policy": 0.91, ... }, "judge": { "model": "...", "agreement": 0.88 } }
```

`evalgate drift` reports movement over a window. The useful signal is rarely a cliff — it's a case that
has slid 0.04 per week for six weeks while every individual PR passed its regression gate. Per-PR gating
cannot see that by construction; only the time series can.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│ CLI            run · calibrate · drift · report │
├─────────────────────────────────────────────────┤
│ Runner         load → sample → assert →         │
│                aggregate → gate                 │
├──────────────┬──────────────┬───────────────────┤
│ Assertions   │ Cache        │ Reporters         │
│ (registry)   │ (content-    │ console · json ·  │
│              │  addressed)  │ gh-annotations    │
├──────────────┴──────────────┴───────────────────┤
│ Adapters (optional, edge)                       │
│ judge providers · embedding providers           │
└─────────────────────────────────────────────────┘
```

**Core has no provider dependency.** The system under test is a function the caller supplies. Judge and
embedding providers are injected. This is what makes the library testable without a network and portable
across stacks — and it's the reason `src/` has no SDK import anywhere.

**Assertions are a registry, not a switch statement.** Custom assertions register alongside built-ins and
get the same scoring, caching, and reporting. The interesting assertions are always domain-specific; a
library that can't be extended is a library that gets forked.

---

## CI contract

```yaml
- run: npx evalgate run --suite evals/ --baseline main
```

Exit codes: `0` pass · `1` gate failed · `2` config or runtime error.
Config errors are distinct from quality failures — a broken suite must never be reported as a quality
regression, because that's how teams learn to ignore the check.

Output: console summary, GitHub annotations on the failing case, and a JSON artifact for the PR comment.
The PR comment shows the delta table and the failing claims — the thing a reviewer reads in five seconds.

---

## Open questions

Honest list. These aren't decided.

1. **Claim extraction granularity.** Too coarse and grounding scores are meaningless; too fine and every
   subordinate clause becomes a claim and the score is noise. Likely needs to be configurable with a sane
   default, but "sane" here needs empirical work against real outputs.
2. **Baseline storage.** Committed file is transparent and reviewable but produces merge conflicts on
   every concurrent PR. Storing in CI cache avoids that but makes the baseline invisible. Leaning
   committed-with-conflict-resolution-guidance; may be wrong.
3. **Sample count vs. cost.** Median-of-3 is a guess. The right default is whatever minimizes false gate
   failures per dollar, and that's measurable — it just hasn't been measured yet.
4. **Whether `consistency` belongs at all.** It measures the feature, not the output. Arguably it's a
   different tool.

---

## Scope for v0

**Shipped.** `schema` · `contains` · `notContains` · `regex` · `length` · `noPII` ·
`semanticSimilarity` · `rubric` · `grounded` · median-of-n sampling with variance surfacing ·
all three threshold gates plus an implicit `criticalAssertions` gate · content-addressed cache
(memory + file) · console + JSON reporters · history records · suite loader with strict validation ·
GitHub Action. 49 tests, no network required.

**Deferred.** `drift` CLI · calibration harness · PR-comment reporter · `consistency` assertion ·
`latency`/`cost` assertions · custom-assertion docs.

The point of v0 is that `grounded` works and the gate is cheap enough to leave on. Everything else is
table stakes that has to exist for those two to be usable.

### Two design notes earned during implementation

**Assertion config is flat.** An earlier draft nested `grounded`'s options under a `config` key while every
other assertion read its options directly off the object. The result: every option silently read
`undefined`, so a suite that asked for `contradictionIsCritical: true` got a quietly passing case. The
end-to-end example caught it, not the unit tests — which is an argument for keeping a runnable example in
the repo, not just a test suite. Consistency across an extension point isn't cosmetic; it's the difference
between a config that fails loudly and one that lies.

**A dropped verdict counts against the score.** If the judge returns fewer verdicts than there were claims,
the missing ones are recorded as `unsupported` rather than omitted. Omitting them would shrink the
denominator, which means an unreliable judge could raise the grounding score by answering less. Any metric
computed from a model's output needs this check somewhere, and it's easy to miss.
