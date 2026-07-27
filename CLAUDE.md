# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

evalgate is a pre-merge quality gate for LLM features: a CLI that runs eval suites in CI, scores output against committed cases, and exits non-zero on regression. `SPEC.md` is the design doc and the authority on *why* things are the way they are — read it before changing scoring, gating, caching, or the `grounded` pipeline.

## Commands

```bash
npm run build          # tsc → dist/
npm run dev            # tsc --watch
npm run typecheck      # tsc --noEmit
npm test               # tsc -p tsconfig.test.json → dist-test/, then node --test
npm run example        # end-to-end demo run, no API key needed
npm run example:calibrate   # measure the scripted judge against human scores
```

`evalgate comment` renders the PR comment from a `run` artifact; try it with
`node dist/cli.js comment --json .evalgate/result.json` after `npm run example`.

Tests compile first (`tsconfig.test.json` → `dist-test/`), then run against the compiled JS. To run a single test file:

```bash
tsc -p tsconfig.test.json && node --test dist-test/test/runner.test.js
```

To filter within a file: `node --test --test-name-pattern 'median' dist-test/test/scoring.test.js`

`npm run example` exercises the real runner, gates, and grounding pipeline against a scripted SUT and scripted judge (`examples/support-agent/sut.mjs`). It is expected to FAIL (exit 1) — that's the point. It caught a real config bug the unit tests missed; keep it runnable.

## Architecture

```
CLI (src/cli.ts)         run · report · comment · drift · calibrate
Runner (src/runner.ts)   load → sample → assert → aggregate → gate
Drift (src/drift.ts)     parse history → window → per-series delta + slope
Calibration (src/calibration.ts)  fixed output → judge → agreement / bias / correlation
Assertions (registry) · Cache (content-addressed) · Reporters (console, json, comment, drift, calibration)
Providers                injected at the edge, never imported by core
```

**`src/` must never import a model-provider SDK.** The system under test, judge, and embedding providers are supplied by the caller as exports from a `--sut` module (`default`/`sut`, `judge`, `embed`) and loaded in `cli.ts:loadSut`. This seam is what makes the entire core testable offline; `test/fakes.ts` supplies scripted providers.

Key flow (`src/runner.ts`):
- Each case runs `samples` times (default 3). **Case score is the median**, not the mean. Spread is reported as `variance`/`unstable`, never folded into the score.
- Assertions execute in cost order (`free → cheap → expensive`, via `byCost`), then results are **placed back at their declaration index** before scoring and reporting.
- Once a free assertion flags `critical`, expensive assertions short-circuit with a "skipped" result rather than spending a token.
- Four gates in `evaluateGates`: `floor`, `regression`, `criticalCases`, and an implicit `criticalAssertions`. All are evaluated even after one fails.

## Invariants worth knowing before you edit

These are deliberate and each one has a comment or a SPEC section behind it:

- **Assertions return scores, never booleans** (`AssertionResult { score, explanation, meta?, critical? }`). An explanation-free failure is considered a bug.
- **Assertion config is flat.** Options live directly on the config object (`{ type: 'grounded', contradictionIsCritical: true }`), not nested under `config`. An earlier nested draft silently read `undefined` for every option.
- **A dropped judge verdict counts as `unsupported`**, not omitted — omitting it shrinks the denominator and lets an unreliable judge raise the score by answering less.
- **Missing SUT version disables the cache with a loud warning**, never guesses. Silently serving stale results is the worst failure this tool can have.
- **Cache read failures are misses, never errors.** The cache is an optimization and must never be a source of red.
- **Cache keys use `stableStringify`** (sorted keys) — plain `JSON.stringify` produces spurious misses.
- **`--baseline` is a file path, never a git ref**, and one that fails to load is a config error (exit 2) — see `src/baseline.ts`. Omitting the flag is the only way to legitimately skip the regression gate, and that reports "skipped (not evaluated)" rather than passing. The shipped CI template once passed `origin/$BASE_REF` here, which made the flagship gate inert while reporting ✓; the workflow now resolves the ref into a file with `git show` first.
- **A `criticalCases` id not present in the suite fails the gate** — it's a config error, and passing a gate over a nonexistent case is worse than a noisy failure.
- **`grounded` throws when there's no judge or no sources** rather than degrading to a keyword heuristic — a fake grounding score gets believed.
- **Exit codes: 0 pass · 1 gate failed · 2 config/runtime error.** Config errors (`ConfigError`, thrown from `src/config.ts`) must never surface as quality failures. Keep the two paths distinct in `cli.ts`.
- **New assertions register in `src/assertions/index.ts`**, they are not added to a switch. Set `cost` correctly — the runner uses it for ordering and budgeting.
- **Calibration holds the output constant.** A `CalibrationCase` carries a committed `output`; there is no SUT. It scores through `evaluateAssertions` — the same path `run` uses — because calibrating against a parallel scoring implementation measures the wrong thing. A set with no spread (`validateSpread`) and a skipped judged assertion are both config errors, not low scores.
- **`judgeAgreement` is bound to a judge id.** `run` reads `.evalgate/calibration.json` and publishes agreement only when `stamp.judge === judge.id`; a mismatch warns and publishes nothing. Never loosen this — it exists so a judge swap can't inherit the old judge's credibility.
- **Assertion results are parked by declaration index, never matched back by `type`.** `evaluateAssertions` writes each result into `results[index]`. An earlier version rebuilt declaration order with `results.find(r => r.type === a.type)`, which collapsed two assertions of the same type onto one result — the second was dropped, the first counted twice, and a `critical` flag on the second was lost entirely (two `noPII` assertions where only the second matched reported the case clean and passed the gate). Duplicate types are legal in a suite; `validateSuite` does not reject them.
- **The PR comment announces its own truncation.** `prComment` drops detail blocks worst-kept-first under a byte budget and states the count plus the artifact name; the verdict and gates are never dropped, and the delta table sheds only its least-moved rows (past `DELTA_TABLE_SHARE` of the budget) with a count. `clampToLimit` is the final backstop — an over-limit body is rejected by GitHub outright, so no comment is worse than a shortened one. A silently cut body reads as though nothing else was wrong. It also carries `COMMENT_MARKER` so CI updates one comment in place, renders a deleted case as `removed` (deleting a failing case is a way to pass a gate), and a new case as `new` rather than a delta that was never computed.
- **`comment` exits 0 even when the suite failed.** Rendering a report about a failure is not a failure, and the CI step must succeed for the comment to post. The verdict belongs to `run`. An unreadable artifact or `--baseline` is still exit 2 — that's a broken pipeline, not a quality result, and swallowing it drops the delta column with nothing saying the comparison never happened.
- **Suite discovery skips `kind: calibration` files.** Calibration sets sit alongside suites; `validateSuite` detects a misfiled one and says so by name.
- **Drift: a case absent from a run is absent, not zero** (that manufactures a cliff out of a suite edit), **fewer than `MIN_POINTS` observations is not a trend** (a new case must not read as a regression), and **history is read in file order, never sorted by `ts`** — it's an append log and append order is the truth.

## TypeScript config

`strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. Consequences: index access yields `T | undefined` (casts like `s[mid] as number` are the existing idiom), optional properties must be spread conditionally (`...(ctx.judge ? { judge: ctx.judge } : {})`) rather than assigned `undefined`, and type-only imports need `import type`. ESM throughout — relative imports carry a `.js` extension.

## Files

In a project *using* evalgate, `.evalgate/history.jsonl` and `.evalgate/calibration.json` are **committed** — the drift time series can't be reconstructed after the fact, and the calibration stamp is how CI publishes agreement without re-running the judge. `.evalgate/cache/` and `result.json` are machine-local.

In **this** repo the whole `.evalgate/` directory is gitignored: everything in it is a leftover from `npm run example`, not project data.

`templates/github-actions/` holds the **consumer-facing** workflows — they reference `evals/` and `npx evalgate`, which only resolve in a project that has installed evalgate. They are not this repo's CI and must not be moved back into `.github/workflows/`, where they would fail on every PR (no `evals/` directory here, and npm does not link a package's own bin). `.github/workflows/ci.yml` is evalgate's own CI: typecheck, build, test, then the example run asserted to exit **1** (it ships a fabricated claim and a leaked address on purpose — exit 0 means the gate stopped catching them), plus a job that installs the packed tarball into a clean project the way a new user would.
