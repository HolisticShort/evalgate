import type { Reporter, SuiteResult, CaseResult, GroundedMeta } from '../types.js'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

const plain = Object.fromEntries(Object.keys(c).map(k => [k, (s: string) => s])) as typeof c

/**
 * A red build that says `0.71 < 0.80` is useless. The console reporter's job is
 * to put the failing claim in front of the reviewer without making them open
 * an artifact.
 */
export const consoleReporter: Reporter = {
  name: 'console',
  report(result, out) {
    const s = process.stdout.isTTY && !process.env['NO_COLOR'] ? c : plain
    const f2 = (n: number) => n.toFixed(2)

    out('')
    out(
      `${s.bold(result.suite)}   ${result.cases.length} cases · ${result.cases[0]?.samples.length ?? 0} samples · ` +
        `${result.cost.cached} cached, ${result.cost.executed} executed` +
        judgedCost(result.cost.judged),
    )
    out('')

    for (const g of result.gates) {
      const mark = g.passed ? s.green('✓') : s.red('✗')
      out(`  ${mark} ${g.gate.padEnd(18)} ${g.detail}`)
    }

    const unstable = result.cases.filter(x => x.unstable)
    if (unstable.length > 0) {
      out('')
      for (const u of unstable) {
        out(`  ${s.yellow('⚠')} ${'unstable'.padEnd(18)} ${u.caseId}  variance ${f2(u.variance)} across samples`)
      }
    }

    const failed = result.cases.filter(x => x.critical || x.assertions.some(a => a.score < 1))
    if (failed.length > 0) {
      out('')
      for (const cs of failed.sort((a, b) => a.score - b.score)) {
        renderCase(cs, out, s)
      }
    }

    if (result.judgeAgreement !== undefined) {
      out('')
      out(s.dim(`  judge–human agreement ${f2(result.judgeAgreement)} — every judged score carries this uncertainty`))
    }

    out('')
    out(result.passed ? s.green('  PASS') : s.red('  FAIL'))
    out('')
  },
}

function renderCase(cs: CaseResult, out: (s: string) => void, s: typeof c): void {
  const mark = cs.critical ? s.red('✗') : cs.score < 1 ? s.yellow('•') : s.green('✓')
  out(`  ${mark} ${cs.caseId}  ${cs.score.toFixed(2)}${cs.critical ? s.red('  CRITICAL') : ''}`)

  for (const a of cs.assertions) {
    if (a.score >= 1 && !a.critical) continue
    out(`      ${a.type} — ${a.explanation}`)
    if (a.type === 'grounded' && a.meta) renderClaims(a.meta as GroundedMeta, out, s)
  }
}

/** The whole point of `grounded`: show the sentence the model made up. */
function renderClaims(meta: GroundedMeta, out: (str: string) => void, s: typeof c): void {
  for (const v of meta.claims) {
    if (v.status === 'supported') continue
    const tag = v.status === 'contradicted' ? s.red('✗') : s.yellow('✗')
    out(`        ${tag} "${truncate(v.claim.text, 60)}"`)
    out(`            ${s.dim(v.reasoning)}`)
    for (const e of v.evidence) {
      out(`            ${s.dim(`${e.docId}: "${truncate(e.span, 70)}"`)}`)
    }
  }
}

function truncate(str: string, n: number): string {
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`
}

/**
 * Judged work is the part that costs real money, so it earns its own segment
 * rather than being added into the run counts. Silent when nothing was judged —
 * a suite of deterministic assertions shouldn't carry a `judge 0/0` on every line.
 */
function judgedCost(judged?: { cached: number; executed: number }): string {
  if (!judged || judged.cached + judged.executed === 0) return ''
  return ` · judge ${judged.cached} cached, ${judged.executed} executed`
}
