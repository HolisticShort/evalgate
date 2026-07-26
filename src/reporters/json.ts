import type { Reporter, SuiteResult } from '../types.js'

/** Machine-readable artifact for PR comments and the drift time series. */
export const jsonReporter: Reporter = {
  name: 'json',
  report(result, out) {
    out(JSON.stringify(result, null, 2))
  },
}

/**
 * One record per run, appended to .evalgate/history.jsonl (committed).
 *
 * Deliberately narrower than the full result: the time series has to stay
 * readable and diffable for years, and per-claim detail belongs in the run
 * artifact, not in permanent history.
 */
export function historyRecord(result: SuiteResult, ts: string): string {
  return JSON.stringify({
    ts,
    sut: result.sut,
    suite: result.suite,
    mean: round(result.mean),
    passed: result.passed,
    cases: Object.fromEntries(result.cases.map(c => [c.caseId, round(c.score)])),
    ...(result.judgeAgreement !== undefined ? { judgeAgreement: round(result.judgeAgreement) } : {}),
  })
}

const round = (n: number): number => Math.round(n * 1000) / 1000
