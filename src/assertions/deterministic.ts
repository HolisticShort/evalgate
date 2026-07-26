import type { Assertion, AssertionContext, AssertionResult } from '../types.js'
import { validate as validateSchema } from '../schema.js'

const text = (ctx: AssertionContext): string =>
  typeof ctx.output === 'string' ? ctx.output : JSON.stringify(ctx.output)

export const schema: Assertion<{ schema: object }> = {
  type: 'schema',
  cost: 'free',
  async evaluate(config, ctx) {
    const value = typeof ctx.output === 'string' ? tryParse(ctx.output) : ctx.output
    if (value === undefined) {
      return { score: 0, explanation: 'output is not valid JSON' }
    }
    const errors = validateSchema(value, config.schema)
    return errors.length === 0
      ? { score: 1, explanation: 'schema valid' }
      : { score: 0, explanation: `schema invalid: ${errors.join('; ')}`, meta: { errors } }
  },
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Fraction of required terms present — partial credit, because "3 of 4 terms" is real information. */
export const contains: Assertion<{ terms: string[]; caseSensitive?: boolean }> = {
  type: 'contains',
  cost: 'free',
  async evaluate(config, ctx) {
    const { terms, caseSensitive = false } = config
    if (terms.length === 0) return { score: 1, explanation: 'no terms required' }
    const hay = caseSensitive ? text(ctx) : text(ctx).toLowerCase()
    const missing = terms.filter(t => !hay.includes(caseSensitive ? t : t.toLowerCase()))
    const found = terms.length - missing.length
    return {
      score: found / terms.length,
      explanation:
        missing.length === 0
          ? `all ${terms.length} terms present`
          : `${found}/${terms.length} terms present · missing: ${missing.join(', ')}`,
      meta: { missing },
    }
  },
}

export const notContains: Assertion<{ terms: string[]; caseSensitive?: boolean }> = {
  type: 'notContains',
  cost: 'free',
  async evaluate(config, ctx) {
    const { terms, caseSensitive = false } = config
    if (terms.length === 0) return { score: 1, explanation: 'no forbidden terms' }
    const hay = caseSensitive ? text(ctx) : text(ctx).toLowerCase()
    const present = terms.filter(t => hay.includes(caseSensitive ? t : t.toLowerCase()))
    return {
      score: (terms.length - present.length) / terms.length,
      explanation:
        present.length === 0
          ? 'no forbidden terms present'
          : `forbidden terms present: ${present.join(', ')}`,
      meta: { present },
    }
  },
}

export const regex: Assertion<{ pattern: string; flags?: string }> = {
  type: 'regex',
  cost: 'free',
  async evaluate(config, ctx) {
    const re = new RegExp(config.pattern, config.flags)
    const matched = re.test(text(ctx))
    return {
      score: matched ? 1 : 0,
      explanation: matched ? `matched /${config.pattern}/` : `did not match /${config.pattern}/`,
    }
  },
}

/**
 * Linear falloff outside the band rather than a cliff. A 810-character response
 * against an 800 limit is not the same defect as a 4,000-character one, and a
 * scoring model that treats them identically teaches the suite to be ignored.
 */
export const length: Assertion<{ min?: number; max?: number; falloff?: number }> = {
  type: 'length',
  cost: 'free',
  async evaluate(config, ctx) {
    const n = text(ctx).length
    const { min, max, falloff = 0.5 } = config
    const overBy = max !== undefined && n > max ? n - max : 0
    const underBy = min !== undefined && n < min ? min - n : 0

    if (overBy === 0 && underBy === 0) return { score: 1, explanation: `length ${n} within band` }

    // Score reaches 0 when the miss equals `falloff` × the band edge.
    const edge = overBy > 0 ? (max as number) : (min as number)
    const miss = overBy > 0 ? overBy : underBy
    const tolerance = Math.max(1, edge * falloff)
    const score = Math.max(0, 1 - miss / tolerance)

    return {
      score,
      explanation:
        overBy > 0
          ? `length ${n} exceeds max ${max} by ${overBy}`
          : `length ${n} below min ${min} by ${underBy}`,
    }
  },
}

/**
 * Pattern sweep for obvious PII. Always critical on a hit — a leak is not a
 * quality gradient, and no suite mean should be able to average it away.
 *
 * Deliberately conservative: this catches the shapes that show up in generated
 * output, not every possible identifier. It is a backstop, not a compliance control.
 */
const PII_PATTERNS: Record<string, RegExp> = {
  // TLD must end on a word character — an earlier pattern allowed a trailing
  // dot and swallowed sentence punctuation into the match.
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g,
  phone: /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]?){13,16}\b/g,
  apiKey: /\b(?:sk|pk|api[_-]?key)[-_][A-Za-z0-9]{16,}\b/gi,
}

export const noPII: Assertion<{ patterns?: string[]; allow?: string[] }> = {
  type: 'noPII',
  cost: 'free',
  async evaluate(config, ctx) {
    const body = text(ctx)
    const allow = new Set(config?.allow ?? [])
    const hits: { kind: string; value: string }[] = []

    for (const [kind, re] of Object.entries(PII_PATTERNS)) {
      for (const m of body.matchAll(re)) {
        if (m[0] && !allow.has(m[0])) hits.push({ kind, value: redact(m[0]) })
      }
    }
    for (const p of config?.patterns ?? []) {
      for (const m of body.matchAll(new RegExp(p, 'g'))) {
        if (m[0]) hits.push({ kind: 'custom', value: redact(m[0]) })
      }
    }

    return hits.length === 0
      ? { score: 1, explanation: 'no PII detected' }
      : {
          score: 0,
          critical: true,
          explanation: `PII detected: ${hits.map(h => `${h.kind}(${h.value})`).join(', ')}`,
          meta: { hits },
        }
  },
}

/** The report should say what leaked, not leak it again. */
function redact(s: string): string {
  if (s.length <= 4) return '*'.repeat(s.length)
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(1, s.length - 4))}${s.slice(-2)}`
}
