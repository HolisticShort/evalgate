#!/usr/bin/env node
/**
 * evalgate CLI
 *
 *   evalgate run    --suite evals/ [--baseline <ref>] [--sut ./sut.js] [--no-cache] [--json <path>]
 *   evalgate report --json <artifact>
 *
 * Exit codes: 0 pass · 1 gate failed · 2 config/runtime error.
 * Config errors are distinct from quality failures — a broken suite reported as
 * a quality regression is how teams learn to ignore the check.
 */
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import type { ExitCode, SuiteResult, SystemUnderTest, JudgeProvider, EmbeddingProvider } from './types.js'
import { loadSuites, ConfigError } from './config.js'
import { run } from './runner.js'
import { FileCache } from './cache.js'
import { consoleReporter } from './reporters/console.js'
import { historyRecord } from './reporters/json.js'

const CACHE_DIR = '.evalgate/cache'
const RESULT_PATH = '.evalgate/result.json'
const HISTORY_PATH = '.evalgate/history.jsonl'

interface Args {
  suite: string | undefined
  baseline: string | undefined
  sut: string | undefined
  json: string | undefined
  cache: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cache: true, suite: undefined, baseline: undefined, sut: undefined, json: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-cache') args.cache = false
    else if (a === '--suite') args.suite = argv[++i]
    else if (a === '--baseline') args.baseline = argv[++i]
    else if (a === '--sut') args.sut = argv[++i]
    else if (a === '--json') args.json = argv[++i]
    else if (a?.startsWith('--')) throw new ConfigError(`unknown flag ${a}`)
  }
  return args
}

/**
 * The system under test, judge, and embedding providers are supplied by the
 * project as a module export — the core never imports a provider SDK, so the
 * seam has to be here at the edge.
 */
interface SutModule {
  default?: SystemUnderTest
  sut?: SystemUnderTest
  judge?: JudgeProvider
  embed?: EmbeddingProvider
}

async function loadSut(path: string): Promise<SutModule> {
  const mod = (await import(resolve(path))) as SutModule
  if (!mod.default && !mod.sut) {
    throw new ConfigError(`${path}: must export a SystemUnderTest as \`default\` or \`sut\``)
  }
  return mod
}

async function cmdRun(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv)
  if (!args.suite) throw new ConfigError('--suite is required')
  if (!args.sut) throw new ConfigError('--sut is required (module exporting the system under test)')

  const suites = await loadSuites(args.suite)
  const mod = await loadSut(args.sut)
  const sut = (mod.default ?? mod.sut) as SystemUnderTest

  const baselines = await loadBaselines(args.baseline)
  const cache = args.cache ? new FileCache(CACHE_DIR) : undefined

  const results: SuiteResult[] = []
  for (const suite of suites) {
    results.push(
      await run({
        suite,
        sut,
        ...(mod.judge ? { judge: mod.judge } : {}),
        ...(mod.embed ? { embed: mod.embed } : {}),
        ...(cache ? { cache } : {}),
        ...(baselines.get(suite.name) ? { baseline: baselines.get(suite.name) as SuiteResult } : {}),
      }),
    )
  }

  for (const r of results) consoleReporter.report(r, s => process.stdout.write(`${s}\n`))

  await mkdir('.evalgate', { recursive: true })
  await writeFile(args.json ?? RESULT_PATH, JSON.stringify(results, null, 2), 'utf8')

  // Timestamp is stamped here, at the edge, so the runner stays deterministic
  // and testable.
  const ts = new Date().toISOString()
  for (const r of results) await appendFile(HISTORY_PATH, `${historyRecord(r, ts)}\n`, 'utf8')

  return results.every(r => r.passed) ? 0 : 1
}

/**
 * A missing baseline is not an error — first run on a new suite has nothing to
 * compare against. The regression gate reports itself as skipped rather than
 * quietly passing. See runner.evaluateGates.
 */
async function loadBaselines(path?: string): Promise<Map<string, SuiteResult>> {
  const map = new Map<string, SuiteResult>()
  if (!path) return map
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SuiteResult[] | SuiteResult
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) map.set(r.suite, r)
  } catch {
    process.stderr.write(`warning: could not read baseline at ${path} — regression gate will be skipped\n`)
  }
  return map
}

async function cmdReport(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv)
  if (!args.json) throw new ConfigError('--json <artifact> is required')
  const parsed = JSON.parse(await readFile(args.json, 'utf8')) as SuiteResult[] | SuiteResult
  const results = Array.isArray(parsed) ? parsed : [parsed]
  for (const r of results) consoleReporter.report(r, s => process.stdout.write(`${s}\n`))
  return results.every(r => r.passed) ? 0 : 1
}

async function main(argv: string[]): Promise<ExitCode> {
  const command = argv[2]
  const rest = argv.slice(3)

  switch (command) {
    case 'run':
      return cmdRun(rest)
    case 'report':
      return cmdReport(rest)
    case 'calibrate':
    case 'drift':
      process.stderr.write(`${command} is deferred past v0 — see SPEC.md § Scope for v0\n`)
      return 2
    default:
      process.stderr.write(
        `usage: evalgate <run|report> [options]\n` +
          `  run    --suite <dir> --sut <module> [--baseline <json>] [--no-cache] [--json <path>]\n` +
          `  report --json <artifact>\n`,
      )
      return 2
  }
}

main(process.argv)
  .then(code => process.exit(code))
  .catch(err => {
    // Quality failures exit 1; everything reaching here is a config or runtime
    // problem and must exit 2 so CI can tell them apart.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
