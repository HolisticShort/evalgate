import type { Assertion } from '../types.js'
import { grounded } from './grounded.js'
import { contextRecall, contextPrecision } from './retrieval.js'
import { rubric } from './rubric.js'
import { semanticSimilarity } from './semantic.js'
import { schema, contains, notContains, regex, length, noPII } from './deterministic.js'

/**
 * Assertions are a registry, not a switch statement. Custom assertions register
 * alongside the built-ins and get the same scoring, caching, and reporting —
 * the interesting assertions are always domain-specific, and a library that
 * can't be extended is a library that gets forked.
 */
const registry = new Map<string, Assertion<any>>()

export function register(a: Assertion<any>, { replace = false } = {}): void {
  if (registry.has(a.type) && !replace) {
    throw new Error(`assertion "${a.type}" already registered — pass { replace: true } to override`)
  }
  registry.set(a.type, a)
}

export function get(type: string): Assertion<any> {
  const a = registry.get(type)
  if (!a) {
    throw new Error(`unknown assertion "${type}" — registered: ${[...registry.keys()].sort().join(', ')}`)
  }
  return a
}

export function registered(): string[] {
  return [...registry.keys()].sort()
}

const RANK = { free: 0, cheap: 1, expensive: 2 } as const

/** Free assertions first, so a case can fail cheaply before spending a token. */
export function byCost<T extends { type: string }>(configs: T[]): T[] {
  return configs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => RANK[get(a.c.type).cost] - RANK[get(b.c.type).cost] || a.i - b.i)
    .map(({ c }) => c)
}

for (const a of [
  schema,
  contains,
  notContains,
  regex,
  length,
  noPII,
  contextRecall,
  contextPrecision,
  semanticSimilarity,
  rubric,
  grounded,
]) {
  register(a as Assertion<any>)
}
