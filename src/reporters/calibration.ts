import type { CalibrationReport, CalibrationCaseResult } from '../types.js'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

const plain = Object.fromEntries(Object.keys(c).map(k => [k, (s: string) => s])) as typeof c

/**
 * Leads with the disagreements, not the headline number. A calibration run that
 * reports only "agreement 0.79" tells you the judge is wrong without telling you
 * how — and the how is the whole reason to run it.
 */
export function reportCalibration(report: CalibrationReport, out: (s: string) => void): void {
  const s = process.stdout.isTTY && !process.env['NO_COLOR'] ? c : plain
  const f2 = (n: number) => n.toFixed(2)

  out('')
  out(`${s.bold(report.set)}   judge ${report.judge} · ${report.cases.length} human-scored cases`)
  out('')

  for (const g of report.gates) {
    out(`  ${g.passed ? s.green('✓') : s.red('✗')} ${g.gate.padEnd(12)} ${g.detail}`)
  }

  out(
    `  ${s.dim('·')} ${'correlation'.padEnd(12)} ${
      report.correlation === null
        ? s.dim('undefined — human scores do not vary')
        : `${f2(report.correlation)} ${s.dim('— does the judge rank cases the way humans do')}`
    }`,
  )

  const disagreements = report.worst.filter(w => Math.abs(w.error) > 0)
  if (disagreements.length > 0) {
    out('')
    out(s.dim('  largest disagreements'))
    for (const w of disagreements) renderDisagreement(w, out, s)
  }

  out('')
  out(
    report.passed
      ? s.green(`  CALIBRATED   agreement ${f2(report.agreement)} — published with every judged score`)
      : s.red(`  UNCALIBRATED  agreement ${f2(report.agreement)} — judge change must not land`),
  )
  out('')
}

function renderDisagreement(w: CalibrationCaseResult, out: (s: string) => void, s: typeof c): void {
  const f2 = (n: number) => n.toFixed(2)
  const dir = w.error > 0 ? 'generous' : 'harsh'
  const mark = Math.abs(w.error) >= 0.3 ? s.red('✗') : s.yellow('•')

  out(`    ${mark} ${w.id.padEnd(22)} human ${f2(w.human)}  judge ${f2(w.judged)}   ${s.dim(`${f2(Math.abs(w.error))} too ${dir}`)}`)
  if (w.note) out(`        ${s.dim(w.note)}`)
}
