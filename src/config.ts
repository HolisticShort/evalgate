import { readFile, readdir } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Suite, EvalCase } from './types.js'

/**
 * Suites are files in the repo, reviewed in PRs. Quality standards that live in
 * a SaaS dashboard drift from the code silently.
 *
 * Validation is strict and errors are specific, because a malformed suite must
 * exit 2 (config error), never 1 (quality failure). Conflating the two is how
 * teams learn to ignore the check.
 */
export async function loadSuites(path: string): Promise<Suite[]> {
  const files = await collect(resolve(path))
  if (files.length === 0) throw new ConfigError(`no suite files found under ${path}`)
  return Promise.all(files.map(loadSuite))
}

export class ConfigError extends Error {}

async function collect(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (!entries) return ['.yaml', '.yml', '.json'].includes(extname(path)) ? [path] : []

  const out: string[] = []
  for (const e of entries) {
    const full = join(path, e.name)
    if (e.isDirectory()) out.push(...(await collect(full)))
    else if (['.yaml', '.yml', '.json'].includes(extname(e.name))) out.push(full)
  }
  return out.sort()
}

async function loadSuite(file: string): Promise<Suite> {
  const raw = await readFile(file, 'utf8')
  let doc: unknown
  try {
    doc = extname(file) === '.json' ? JSON.parse(raw) : parseYaml(raw)
  } catch (e) {
    throw new ConfigError(`${file}: could not parse — ${(e as Error).message}`)
  }
  return validateSuite(doc, file)
}

export function validateSuite(doc: unknown, file = '<inline>'): Suite {
  if (!isObject(doc)) throw new ConfigError(`${file}: suite must be an object`)

  const name = doc['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError(`${file}: suite.name is required`)
  }

  const thresholds = doc['thresholds']
  if (!isObject(thresholds)) {
    throw new ConfigError(`${file}: suite.thresholds is required — a gate with no thresholds gates nothing`)
  }
  if (
    thresholds['floor'] === undefined &&
    thresholds['regression'] === undefined &&
    thresholds['criticalCases'] === undefined
  ) {
    throw new ConfigError(`${file}: thresholds must set at least one of floor, regression, criticalCases`)
  }

  const rawCases = doc['cases']
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new ConfigError(`${file}: suite.cases must be a non-empty array`)
  }

  const seen = new Set<string>()
  const cases: EvalCase[] = rawCases.map((c, i) => {
    if (!isObject(c)) throw new ConfigError(`${file}: cases[${i}] must be an object`)
    const id = c['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new ConfigError(`${file}: cases[${i}].id is required`)
    }
    // Duplicate ids silently collapse in the baseline map and in criticalCases
    // lookup, so they're rejected rather than deduped.
    if (seen.has(id)) throw new ConfigError(`${file}: duplicate case id "${id}"`)
    seen.add(id)

    const input = c['input']
    if (!isObject(input) || typeof input['prompt'] !== 'string') {
      throw new ConfigError(`${file}: case "${id}" needs input.prompt`)
    }

    const assertions = c['assertions']
    if (!Array.isArray(assertions) || assertions.length === 0) {
      throw new ConfigError(`${file}: case "${id}" needs at least one assertion`)
    }
    for (const [j, a] of assertions.entries()) {
      if (!isObject(a) || typeof a['type'] !== 'string') {
        throw new ConfigError(`${file}: case "${id}" assertions[${j}] needs a type`)
      }
    }

    const weights = c['weights']
    if (weights !== undefined) {
      if (!Array.isArray(weights) || weights.length !== assertions.length) {
        throw new ConfigError(
          `${file}: case "${id}" has ${assertions.length} assertions but ${
            Array.isArray(weights) ? weights.length : 'non-array'
          } weights`,
        )
      }
    }

    return c as unknown as EvalCase
  })

  const samples = doc['samples']
  if (samples !== undefined && (typeof samples !== 'number' || samples < 1)) {
    throw new ConfigError(`${file}: samples must be a number >= 1`)
  }

  return { ...(doc as object), name, cases, thresholds } as Suite
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
