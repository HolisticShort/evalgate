# CI templates

Copy these into `.github/workflows/` of the project you want to gate. They are templates, not
evalgate's own CI — they reference an `evals/` directory and `npx evalgate`, which only resolve
in a project that has installed evalgate as a dependency.

```bash
mkdir -p .github/workflows
cp node_modules/@holisticconsulting/evalgate/templates/github-actions/evals.yml .github/workflows/
cp node_modules/@holisticconsulting/evalgate/templates/github-actions/calibration.yml .github/workflows/
```

## What you have to supply

| | |
|---|---|
| `evals/` | one or more suite files (`.yaml`, `.yml`, or `.json`) |
| `evals/sut.mjs` | your system under test, plus a `judge` export if you use `rubric` or `grounded` |
| `JUDGE_API_KEY` | a repository secret, read by **your** `sut.mjs` — evalgate never reads it |

The API key belongs to the project being gated. evalgate imports no provider SDK and never touches a
credential; `sut.mjs` is the only thing that talks to a model.

## Enabling the regression gate

`evals.yml` runs without a baseline out of the box and says so in the checks UI. To turn the regression
gate on, commit a result artifact from your base branch:

```bash
npx evalgate run --suite evals/ --sut ./evals/sut.mjs --json .evalgate/baseline.json
git add -f .evalgate/baseline.json && git commit -m "Add evalgate baseline"
```

The workflow resolves it with `git show "origin/$BASE_REF:.evalgate/baseline.json"` and passes the
resulting file to `--baseline`. It passes the flag only when the file exists, because an unresolvable
`--baseline` is a config error (exit 2) — a regression gate that silently does not run is worse than one
that is explicitly absent.

## Files to commit in your project

- `.evalgate/history.jsonl` — the drift time series, which cannot be reconstructed after the fact
- `.evalgate/calibration.json` — the stamp proving the judge was measured; `run` reads it to publish
  agreement without re-running calibration
- `.evalgate/baseline.json` — if you want the regression gate

`.evalgate/cache/` and `.evalgate/result.json` are machine-local and should stay ignored.

`calibration.yml` ends with `git diff --exit-code -- .evalgate/calibration.json`, which only does its job
if that file is tracked. If `.evalgate/` is in your `.gitignore`, add a negation for the three files above
or the check passes vacuously.
