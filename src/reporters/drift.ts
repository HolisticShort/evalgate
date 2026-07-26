import type { DriftReport, SeriesDrift } from '../types.js'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

const plain = Object.fromEntries(Object.keys(c).map(k => [k, (s: string) => s])) as typeof c

/**
 * The drift report answers a question a passing PR check cannot: has this been
 * getting worse the whole time? So it leads with movement, not with the current
 * score — the score is what every other report already shows.
 */
export function reportDrift(report: DriftReport, out: (s: string) => void): void {
  const s = process.stdout.isTTY && !process.env['NO_COLOR'] ? c : plain

  out('')
  out(`${s.bold(report.suite)}   ${report.runs} runs · ${day(report.from)} → ${day(report.to)}`)
  out('')

  if (report.runs === 0) {
    out(s.dim('  no runs in window'))
    out('')
    return
  }

  renderSeries(report.mean, out, s)
  for (const cs of report.cases) renderSeries(cs, out, s)

  if (report.insufficient.length > 0) {
    out('')
    out(s.dim(`  ${report.insufficient.length} case(s) with fewer than 3 runs — no trend yet: ${report.insufficient.join(', ')}`))
  }

  out('')
  out(
    report.drifting
      ? s.red(`  DRIFT   declined ≥ ${report.threshold} over the window`)
      : s.green(`  STEADY  nothing declined ≥ ${report.threshold} over the window`),
  )
  out('')
}

function renderSeries(d: SeriesDrift, out: (str: string) => void, s: typeof c): void {
  const f2 = (n: number) => n.toFixed(2)
  const mark = d.drifting ? s.red('↓') : d.delta < 0 ? s.yellow('·') : s.green('·')
  const per = `${d.slope >= 0 ? '+' : '−'}${Math.abs(d.slope).toFixed(3)}/run`

  // Pad before colorizing — ANSI escapes count toward String.padEnd and would
  // shift every flagged row out of the column.
  const delta = `${d.delta >= 0 ? '+' : '−'}${f2(Math.abs(d.delta))}`.padEnd(6)

  out(
    `  ${mark} ${d.id.padEnd(22)} ${f2(d.first)} → ${f2(d.last)}   ` +
      `${d.drifting ? s.red(delta) : delta} ${s.dim(per)}`,
  )
}

/** Timestamps are ISO; the date is the part a human reads in a trend report. */
function day(ts: string): string {
  return ts.slice(0, 10) || '?'
}
