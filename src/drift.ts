import type { HistoryRecord, DriftReport, SeriesDrift } from './types.js'
import { ConfigError } from './config.js'

/**
 * Drift detection over the committed history.
 *
 * Per-PR gating cannot see slow decline by construction: the useful signal is
 * rarely a cliff, it's a case that has slid 0.04 per week for six weeks while
 * every individual PR passed its regression gate. Only the time series can see
 * that. See SPEC.md § Drift detection.
 */

/**
 * Below this many observations a series has no trend, only noise. Reported as
 * `insufficient` rather than flagged — a case added last week must never read
 * as a regression.
 */
export const MIN_POINTS = 3

/** Decline over the window that flags a series. Deliberately looser than a
 *  per-PR regression gate: this is looking for accumulation, not for cliffs. */
export const DEFAULT_THRESHOLD = 0.05

export interface DriftOptions {
  /** Most recent N runs per suite. Undefined means the whole history. */
  window?: number
  threshold?: number
  /** Restrict to one suite. Undefined reports every suite in the file. */
  suite?: string
}

/**
 * Records are consumed in file order, not sorted by timestamp. The file is an
 * append log and append order is the truth — sorting would let a machine with a
 * skewed clock silently reorder the series.
 */
export function parseHistory(text: string): HistoryRecord[] {
  const out: HistoryRecord[] = []
  const lines = text.split('\n')

  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // History is committed and diffable. A line that won't parse means
      // something upstream is broken, and reporting drift over a silently
      // truncated series is worse than refusing to report at all.
      throw new ConfigError(`history line ${i + 1}: not valid JSON`)
    }
    if (!isRecord(parsed)) throw new ConfigError(`history line ${i + 1}: expected an object`)
    if (typeof parsed['suite'] !== 'string' || typeof parsed['mean'] !== 'number') {
      throw new ConfigError(`history line ${i + 1}: missing suite or mean`)
    }
    out.push(parsed as unknown as HistoryRecord)
  }
  return out
}

export function analyzeDrift(records: HistoryRecord[], opts: DriftOptions = {}): DriftReport[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD

  const bySuite = new Map<string, HistoryRecord[]>()
  for (const r of records) {
    if (opts.suite !== undefined && r.suite !== opts.suite) continue
    const list = bySuite.get(r.suite)
    if (list) list.push(r)
    else bySuite.set(r.suite, [r])
  }

  if (opts.suite !== undefined && !bySuite.has(opts.suite)) {
    throw new ConfigError(`no history for suite "${opts.suite}" — suites present: ${present(records)}`)
  }

  return [...bySuite.entries()].map(([suite, all]) => {
    const runs = opts.window === undefined ? all : all.slice(-opts.window)

    // Every case id that appears anywhere in the window. A case absent from a
    // run is a case that did not run, not a case that scored zero — including
    // it as 0 would manufacture a drop out of a suite edit.
    const ids = [...new Set(runs.flatMap(r => Object.keys(r.cases ?? {})))].sort()

    const cases: SeriesDrift[] = []
    const insufficient: string[] = []
    for (const id of ids) {
      const series = runs.map(r => r.cases?.[id]).filter((v): v is number => typeof v === 'number')
      if (series.length < MIN_POINTS) insufficient.push(id)
      else cases.push(drift(id, series, threshold))
    }

    const mean = drift(
      'suite mean',
      runs.map(r => r.mean),
      threshold,
    )

    return {
      suite,
      runs: runs.length,
      from: runs[0]?.ts ?? '',
      to: runs[runs.length - 1]?.ts ?? '',
      threshold,
      mean,
      // Worst decline first — the report is read top-down and the reader is
      // looking for what to fix.
      cases: cases.sort((a, b) => a.delta - b.delta),
      insufficient,
      drifting: mean.drifting || cases.some(c => c.drifting),
    }
  })
}

function drift(id: string, series: number[], threshold: number): SeriesDrift {
  const first = series[0] ?? 0
  const last = series[series.length - 1] ?? 0
  const delta = last - first
  return {
    id,
    points: series.length,
    first,
    last,
    delta: round(delta),
    slope: round(slope(series)),
    // `<=` so a threshold of exactly the observed decline flags. A gate that
    // lets its own boundary through gets tuned to the boundary.
    drifting: series.length >= MIN_POINTS && delta <= -threshold,
  }
}

/** Least-squares slope against run index. Zero for a series that can't have one. */
export function slope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  const mx = (n - 1) / 2
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * ((ys[i] as number) - my)
    den += (i - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

function present(records: HistoryRecord[]): string {
  const names = [...new Set(records.map(r => r.suite))].sort()
  return names.length > 0 ? names.join(', ') : '(none)'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const round = (n: number): number => Math.round(n * 1000) / 1000
