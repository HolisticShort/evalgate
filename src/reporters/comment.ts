import type { SuiteResult, CaseResult, GroundedMeta } from '../types.js'

/**
 * The PR comment. A reviewer reads this in five seconds, so it leads with the
 * verdict and the movement, not with the scores — the scores are in the console
 * output and the artifact for anyone who wants them.
 *
 * See SPEC.md § CI contract.
 */

/**
 * Stable marker so CI can update one comment in place. Posting a fresh comment
 * every run buries the PR conversation, and a reviewer scrolling past six stale
 * evalgate comments learns to scroll past the seventh.
 */
export const COMMENT_MARKER = '<!-- evalgate:report -->'

/** GitHub rejects comment bodies above this. */
export const GITHUB_COMMENT_LIMIT = 65536

export interface CommentOptions {
  baseline?: SuiteResult[]
  /** Body budget. Defaults to GitHub's hard limit. */
  limit?: number
  /** Named in the truncation notice so dropped detail is still reachable. */
  artifact?: string
}

export function prComment(results: SuiteResult[], opts: CommentOptions = {}): string {
  const limit = opts.limit ?? GITHUB_COMMENT_LIMIT
  const baseline = new Map((opts.baseline ?? []).map(b => [b.suite, b]))

  const head: string[] = [COMMENT_MARKER, headline(results)]
  const details: string[] = []

  for (const r of results) {
    head.push('', suiteHeadline(r, baseline.get(r.suite)), '', gateTable(r))

    const rows = deltaRows(r, baseline.get(r.suite))
    if (rows.length > 0) head.push('', deltaTable(rows, baseline.has(r.suite)))

    // Worst first — the reviewer is looking for what broke, and the detail
    // blocks are what gets dropped first when the body runs out of room.
    for (const c of [...r.cases].sort((a, b) => a.score - b.score)) {
      if (!isFailing(c)) continue
      details.push(caseDetail(c))
    }
  }

  return assemble(head, details, limit, opts.artifact)
}

/**
 * Detail is dropped from the bottom — least severe first — and the comment says
 * what it dropped. A body silently truncated at the byte limit reads as though
 * nothing else was wrong, which is the one thing this comment must never imply.
 */
function assemble(head: string[], details: string[], limit: number, artifact?: string): string {
  const NOTICE_BUDGET = 400
  const kept: string[] = []
  let size = head.join('\n').length

  for (const d of details) {
    if (size + d.length + NOTICE_BUDGET > limit) break
    kept.push(d)
    size += d.length + 1
  }

  const body = [...head]
  if (kept.length > 0) body.push('', '---', '', ...kept)

  const dropped = details.length - kept.length
  if (dropped > 0) {
    body.push(
      '',
      `> ${dropped} more failing case${dropped === 1 ? '' : 's'} not shown — this comment hit GitHub's ${limit.toLocaleString('en-US')}-character limit.` +
        (artifact ? ` Full detail is in the \`${artifact}\` artifact.` : ''),
    )
  }

  return body.join('\n')
}

function headline(results: SuiteResult[]): string {
  const failed = results.filter(r => !r.passed).length
  if (failed === 0) {
    return `### ✅ evalgate — ${results.length} suite${results.length === 1 ? '' : 's'} passed`
  }
  return `### ❌ evalgate — ${failed} of ${results.length} suite${results.length === 1 ? '' : 's'} failed`
}

function suiteHeadline(r: SuiteResult, base?: SuiteResult): string {
  const parts = [
    `**${escape(r.suite)}** · ${r.cases.length} case${r.cases.length === 1 ? '' : 's'} · mean \`${f2(r.mean)}\``,
  ]
  parts.push(base ? `(${signed(r.mean - base.mean)} vs baseline)` : '(no baseline)')
  if (r.cost.cached > 0) parts.push(`· ${r.cost.cached} cached`)
  if (r.judgeAgreement !== undefined) {
    // Every judged score carries the judge's measured uncertainty, so the
    // comment says so where the scores are, not in a footnote nobody reads.
    parts.push(`· judge–human agreement \`${f2(r.judgeAgreement)}\``)
  }
  return parts.join(' ')
}

function gateTable(r: SuiteResult): string {
  if (r.gates.length === 0) return '_no gates configured_'
  return [
    '| | gate | result |',
    '|---|---|---|',
    ...r.gates.map(g => `| ${g.passed ? '✅' : '❌'} | \`${g.gate}\` | ${escape(g.detail)} |`),
  ].join('\n')
}

interface DeltaRow {
  id: string
  before: number | undefined
  after: number | undefined
  unstable: boolean
  critical: boolean
}

/**
 * Cases present in the baseline but gone from this run are listed as `removed`.
 * Deleting a failing case is a way to make a gate pass, and it should cost a
 * line in the review rather than disappearing from the diff of scores.
 */
function deltaRows(r: SuiteResult, base?: SuiteResult): DeltaRow[] {
  const rows: DeltaRow[] = r.cases.map(c => ({
    id: c.caseId,
    before: base?.cases.find(b => b.caseId === c.caseId)?.score,
    after: c.score,
    unstable: c.unstable,
    critical: c.critical,
  }))

  for (const b of base?.cases ?? []) {
    if (!r.cases.some(c => c.caseId === b.caseId)) {
      rows.push({ id: b.caseId, before: b.score, after: undefined, unstable: false, critical: false })
    }
  }

  // Biggest drop first; unchanged and improved cases sink to the bottom.
  return rows.sort((a, b) => movement(a) - movement(b))
}

function movement(row: DeltaRow): number {
  if (row.after === undefined) return -Infinity // removed — always worth seeing
  if (row.before === undefined) return row.after - 1 // new — rank by how bad it is
  return row.after - row.before
}

function deltaTable(rows: DeltaRow[], hasBaseline: boolean): string {
  // Without a baseline there is no delta to show, and two columns of em-dashes
  // read as missing data rather than as a comparison that was never possible.
  const out = hasBaseline
    ? ['| case | baseline | this PR | Δ |', '|---|---|---|---|']
    : ['| case | score |', '|---|---|']

  for (const row of rows) {
    const flags = [row.critical ? ' 🔴' : '', row.unstable ? ' ⚠️' : ''].join('')
    const name = `\`${escape(row.id)}\`${flags}`
    out.push(
      hasBaseline
        ? `| ${name} | ${cell(row.before)} | ${cell(row.after)} | ${delta(row, hasBaseline)} |`
        : `| ${name} | ${cell(row.after)} |`,
    )
  }
  return out.join('\n')
}

function cell(score: number | undefined): string {
  return score === undefined ? '—' : `\`${f2(score)}\``
}

function delta(row: DeltaRow, hasBaseline: boolean): string {
  if (row.after === undefined) return '**removed**'
  if (!hasBaseline) return '—'
  // A case added in this PR has no previous score. Rendering it as +0.00 would
  // claim a comparison that was never made.
  if (row.before === undefined) return '**new**'
  const d = row.after - row.before
  if (d === 0) return '—'
  return d < 0 ? `**${signed(d)}**` : signed(d)
}

function isFailing(c: CaseResult): boolean {
  return c.critical || c.assertions.some(a => a.score < 1)
}

function caseDetail(c: CaseResult): string {
  const failing = c.assertions.filter(a => a.score < 1 || a.critical)
  const summary = `<summary><code>${escape(c.caseId)}</code> — ${f2(c.score)}${c.critical ? ' · <b>critical</b>' : ''}</summary>`

  const body: string[] = []
  for (const a of failing) {
    body.push('', `**${escape(a.type)}** — ${escape(a.explanation)}`)
    if (a.type === 'grounded' && a.meta) body.push(...claimLines(a.meta as GroundedMeta))
  }

  return ['<details>', summary, ...body, '', '</details>'].join('\n')
}

/** The whole point of `grounded`: the sentence the model made up, in the PR. */
function claimLines(meta: GroundedMeta): string[] {
  const out: string[] = ['']
  for (const v of meta.claims) {
    if (v.status === 'supported') continue
    out.push(`- ${v.status === 'contradicted' ? '🔴' : '🟡'} **${v.status}** — “${escape(v.claim.text)}”`)
    out.push(`  ${escape(v.reasoning)}`)
    for (const e of v.evidence) out.push(`  > \`${escape(e.docId)}\`: “${escape(e.span)}”`)
  }
  return out
}

/** Pipes and newlines would break out of a table cell or a list item. */
function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

const f2 = (n: number): string => n.toFixed(2)
const signed = (n: number): string => `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}`
