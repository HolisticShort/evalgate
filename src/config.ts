import { readFile, readdir } from 'node:fs/promises'
import { join, extname, resolve, dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Suite, EvalCase, CalibrationSet, CalibrationCase } from './types.js'

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

  const docs = await Promise.all(
    files.map(async f => ({ file: f, doc: await resolveSourceFiles(await parseFile(f), f) })),
  )
  // Calibration sets live alongside suites — they describe the same cases and
  // belong in the same review. `kind` keeps `run` from trying to gate on them.
  const suites = docs.filter(d => !(isObject(d.doc) && d.doc['kind'] === 'calibration'))
  if (suites.length === 0) throw new ConfigError(`no suite files found under ${path} — only calibration sets`)

  return suites.map(d => validateSuite(d.doc, d.file))
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

/**
 * Replaces `{ id, textFile }` source documents with `{ id, text }`, reading the
 * file relative to the suite that referenced it.
 *
 * Inlining source text works for a policy paragraph and collapses for anything
 * real: a retrieval corpus is megabytes, and pasting it into YAML produces a
 * file nobody can review and a diff nobody can read. Paths are resolved against
 * the suite file rather than the working directory so a suite means the same
 * thing wherever `evalgate` is invoked from.
 *
 * Mutates in place, which is deliberate: YAML anchors (`context: *policy`) parse
 * to a single shared object, so resolving it once resolves every reference and
 * the file is read once no matter how many cases share it.
 */
async function resolveSourceFiles(doc: unknown, suiteFile: string): Promise<unknown> {
  const base = dirname(suiteFile)

  const walk = async (node: unknown): Promise<void> => {
    if (Array.isArray(node)) {
      await Promise.all(node.map(walk))
      return
    }
    if (!isObject(node)) return

    if ('textFile' in node) {
      const ref = node['textFile']
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new ConfigError(`${suiteFile}: textFile must be a non-empty string`)
      }
      // Both keys is ambiguous, and picking one silently means half the readers
      // of the suite are wrong about what it says.
      if ('text' in node) {
        throw new ConfigError(
          `${suiteFile}: source "${String(node['id'] ?? '?')}" sets both text and textFile — use one`,
        )
      }
      const full = resolve(base, ref)
      node['text'] = await readFile(full, 'utf8').catch(() => {
        throw new ConfigError(
          `${suiteFile}: source "${String(node['id'] ?? '?')}" — could not read textFile ${full}`,
        )
      })
      delete node['textFile']
      return
    }

    await Promise.all(Object.values(node).map(walk))
  }

  await walk(doc)
  return doc
}

async function parseFile(file: string): Promise<unknown> {
  const raw = await readFile(file, 'utf8')
  try {
    return extname(file) === '.json' ? JSON.parse(raw) : parseYaml(raw)
  } catch (e) {
    throw new ConfigError(`${file}: could not parse — ${(e as Error).message}`)
  }
}

export function validateSuite(doc: unknown, file = '<inline>'): Suite {
  if (!isObject(doc)) throw new ConfigError(`${file}: suite must be an object`)

  const name = doc['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError(`${file}: suite.name is required`)
  }

  const thresholds = doc['thresholds']
  if (!isObject(thresholds)) {
    // A calibration set landing here is the likely cause, and "thresholds is
    // required" would send someone off to add thresholds to the wrong file.
    if (looksLikeCalibration(doc)) {
      throw new ConfigError(`${file}: this looks like a calibration set — add \`kind: calibration\` so \`run\` skips it`)
    }
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

// ---------------------------------------------------------------------------
// Calibration sets
// ---------------------------------------------------------------------------

export async function loadCalibrationSet(file: string): Promise<CalibrationSet> {
  const raw = await readFile(file, 'utf8').catch(() => {
    throw new ConfigError(`could not read calibration set at ${file}`)
  })
  let doc: unknown
  try {
    doc = extname(file) === '.json' ? JSON.parse(raw) : parseYaml(raw)
  } catch (e) {
    throw new ConfigError(`${file}: could not parse — ${(e as Error).message}`)
  }
  return validateCalibrationSet(await resolveSourceFiles(doc, file), file)
}

export function validateCalibrationSet(doc: unknown, file = '<inline>'): CalibrationSet {
  if (!isObject(doc)) throw new ConfigError(`${file}: calibration set must be an object`)

  const name = doc['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError(`${file}: calibration set needs a name`)
  }

  const rawCases = doc['cases']
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new ConfigError(`${file}: calibration set needs a non-empty cases array`)
  }

  const seen = new Set<string>()
  const cases: CalibrationCase[] = rawCases.map((c, i) => {
    if (!isObject(c)) throw new ConfigError(`${file}: cases[${i}] must be an object`)

    const id = c['id']
    if (typeof id !== 'string' || id.length === 0) throw new ConfigError(`${file}: cases[${i}].id is required`)
    if (seen.has(id)) throw new ConfigError(`${file}: duplicate calibration case id "${id}"`)
    seen.add(id)

    const input = c['input']
    if (!isObject(input) || typeof input['prompt'] !== 'string') {
      throw new ConfigError(`${file}: calibration case "${id}" needs input.prompt`)
    }

    // The output is committed, not produced. Calibration holds it constant so a
    // score change is attributable to the judge and nothing else.
    if (c['output'] === undefined) {
      throw new ConfigError(
        `${file}: calibration case "${id}" needs a committed output — calibration scores a fixed output, not a system under test`,
      )
    }

    const expected = c['expected']
    if (typeof expected !== 'number' || expected < 0 || expected > 1) {
      throw new ConfigError(`${file}: calibration case "${id}" needs a human score in [0,1], got ${String(expected)}`)
    }

    const assertions = c['assertions']
    if (!Array.isArray(assertions) || assertions.length === 0) {
      throw new ConfigError(`${file}: calibration case "${id}" needs at least one assertion`)
    }
    for (const [j, a] of assertions.entries()) {
      if (!isObject(a) || typeof a['type'] !== 'string') {
        throw new ConfigError(`${file}: calibration case "${id}" assertions[${j}] needs a type`)
      }
    }

    return c as unknown as CalibrationCase
  })

  const agreement = doc['agreement']
  if (agreement !== undefined && !isObject(agreement)) {
    throw new ConfigError(`${file}: agreement must be an object with minimum and/or maxBias`)
  }

  // The judge is pinned infrastructure. A calibration set that lets temperature
  // float is calibrating something other than what will run.
  const judge = doc['judge']
  if (isObject(judge) && judge['temperature'] !== undefined && judge['temperature'] !== 0) {
    throw new ConfigError(`${file}: judge.temperature must be 0 — a judge that varies cannot be calibrated`)
  }

  return { ...(doc as object), name, cases, agreement: (agreement ?? {}) as CalibrationSet['agreement'] } as CalibrationSet
}

function looksLikeCalibration(doc: Record<string, unknown>): boolean {
  const cases = doc['cases']
  return (
    doc['agreement'] !== undefined ||
    (Array.isArray(cases) && cases.some(c => isObject(c) && c['expected'] !== undefined))
  )
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
