#!/usr/bin/env node
/**
 * evalgate CLI
 *
 *   evalgate run    --suite evals/ [--baseline <ref>] [--sut ./sut.js] [--no-cache] [--json <path>]
 *   evalgate report --json <artifact>
 *   evalgate drift  [--history <path>] [--suite <name>] [--window <n>] [--threshold <n>] [--gate]
 *   evalgate calibrate --set <path> --judge <module> [--json <path>]
 *
 * Exit codes: 0 pass · 1 gate failed · 2 config/runtime error.
 * Config errors are distinct from quality failures — a broken suite reported as
 * a quality regression is how teams learn to ignore the check.
 */
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import type {
  ExitCode,
  SuiteResult,
  SystemUnderTest,
  JudgeProvider,
  EmbeddingProvider,
  CalibrationStamp,
} from './types.js'
import { loadSuites, loadCalibrationSet, ConfigError } from './config.js'
import { run } from './runner.js'
import { calibrate, validateSpread } from './calibration.js'
import { FileCache } from './cache.js'
import { consoleReporter } from './reporters/console.js'
import { reportCalibration } from './reporters/calibration.js'
import { reportDrift } from './reporters/drift.js'
import { historyRecord } from './reporters/json.js'
import { analyzeDrift, parseHistory, MIN_POINTS } from './drift.js'

const CACHE_DIR = '.evalgate/cache'
const RESULT_PATH = '.evalgate/result.json'
const HISTORY_PATH = '.evalgate/history.jsonl'
const CALIBRATION_PATH = '.evalgate/calibration.json'

interface Args {
  suite: string | undefined
  baseline: string | undefined
  sut: string | undefined
  json: string | undefined
  set: string | undefined
  judge: string | undefined
  history: string | undefined
  window: number | undefined
  threshold: number | undefined
  cache: boolean
  gate: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cache: true,
    gate: false,
    suite: undefined,
    baseline: undefined,
    sut: undefined,
    json: undefined,
    set: undefined,
    judge: undefined,
    history: undefined,
    window: undefined,
    threshold: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-cache') args.cache = false
    else if (a === '--gate') args.gate = true
    else if (a === '--suite') args.suite = argv[++i]
    else if (a === '--baseline') args.baseline = argv[++i]
    else if (a === '--sut') args.sut = argv[++i]
    else if (a === '--json') args.json = argv[++i]
    else if (a === '--set') args.set = argv[++i]
    else if (a === '--judge') args.judge = argv[++i]
    else if (a === '--history') args.history = argv[++i]
    else if (a === '--window') args.window = num(a, argv[++i])
    else if (a === '--threshold') args.threshold = num(a, argv[++i])
    else if (a?.startsWith('--')) throw new ConfigError(`unknown flag ${a}`)
  }
  return args
}

function num(flag: string, raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw === '' || Number.isNaN(n) || n <= 0) {
    throw new ConfigError(`${flag} needs a positive number, got ${raw ?? '(nothing)'}`)
  }
  return n
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

  // Every judged score carries the judge's measured uncertainty, so the report
  // has to say what it is — see SPEC.md § Who judges the judge.
  const agreement = await loadAgreement(mod.judge?.id)
  if (agreement !== undefined) for (const r of results) r.judgeAgreement = agreement

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

/**
 * `calibrate` measures the judge against human-scored cases and writes a stamp
 * that `run` publishes alongside every judged score.
 *
 * It is not a per-PR check. It runs when the judge model or the judge prompt
 * changes, the same way changing a compiler means re-running the test suite.
 */
async function cmdCalibrate(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv)
  if (!args.set) throw new ConfigError('--set <path> is required (the human-scored calibration set)')
  if (!args.judge) throw new ConfigError('--judge <module> is required (a module exporting a `judge` provider)')

  const set = await loadCalibrationSet(args.set)
  validateSpread(set)

  const mod = (await import(resolve(args.judge))) as SutModule
  if (!mod.judge) throw new ConfigError(`${args.judge}: must export a \`judge\` provider`)

  const report = await calibrate(set, {
    judge: mod.judge,
    ...(mod.embed ? { embed: mod.embed } : {}),
  })

  reportCalibration(report, s => process.stdout.write(`${s}\n`))

  await mkdir('.evalgate', { recursive: true })
  if (args.json) await writeFile(args.json, JSON.stringify(report, null, 2), 'utf8')

  // The stamp is written even when calibration fails: `run` needs to know the
  // judge is uncalibrated, and deleting the evidence on failure would let a bad
  // judge look merely unmeasured.
  const stamp: CalibrationStamp = {
    ts: new Date().toISOString(),
    set: report.set,
    judge: report.judge,
    agreement: report.agreement,
    passed: report.passed,
  }
  await writeFile(CALIBRATION_PATH, JSON.stringify(stamp, null, 2), 'utf8')

  return report.passed ? 0 : 1
}

/**
 * Agreement is published with every judged score, or not published at all.
 *
 * A stamp from a different judge is worse than no stamp — it attaches one
 * judge's credibility to another judge's numbers — so a mismatch warns and
 * publishes nothing.
 */
async function loadAgreement(judgeId: string | undefined): Promise<number | undefined> {
  if (!judgeId) return undefined
  let stamp: CalibrationStamp
  try {
    stamp = JSON.parse(await readFile(CALIBRATION_PATH, 'utf8')) as CalibrationStamp
  } catch {
    process.stderr.write(
      `warning: judge "${judgeId}" has no calibration — run \`evalgate calibrate\`. ` +
        `An uncalibrated judge is a random number generator with good manners.\n`,
    )
    return undefined
  }

  if (stamp.judge !== judgeId) {
    process.stderr.write(
      `warning: calibration is for judge "${stamp.judge}" but "${judgeId}" is running — agreement not published\n`,
    )
    return undefined
  }
  if (!stamp.passed) {
    process.stderr.write(`warning: judge "${judgeId}" last failed calibration (agreement ${stamp.agreement})\n`)
  }
  return stamp.agreement
}

/**
 * Per-PR gating cannot see slow decline by construction. `drift` reads the
 * committed time series and reports movement over a window.
 *
 * Reporting is the default; `--gate` makes it fail the build. Drift is a
 * conversation starter more often than a blocker, and a command that starts
 * out red gets muted before anyone reads it.
 */
async function cmdDrift(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv)
  const path = args.history ?? HISTORY_PATH

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new ConfigError(`could not read history at ${path} — run \`evalgate run\` at least ${MIN_POINTS} times first`)
  }

  const reports = analyzeDrift(parseHistory(text), {
    ...(args.window !== undefined ? { window: args.window } : {}),
    ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
    ...(args.suite !== undefined ? { suite: args.suite } : {}),
  })

  for (const r of reports) reportDrift(r, s => process.stdout.write(`${s}\n`))
  if (args.json) await writeFile(args.json, JSON.stringify(reports, null, 2), 'utf8')

  if (!args.gate) return 0
  return reports.some(r => r.drifting) ? 1 : 0
}

async function main(argv: string[]): Promise<ExitCode> {
  const command = argv[2]
  const rest = argv.slice(3)

  switch (command) {
    case 'run':
      return cmdRun(rest)
    case 'report':
      return cmdReport(rest)
    case 'drift':
      return cmdDrift(rest)
    case 'calibrate':
      return cmdCalibrate(rest)
    default:
      process.stderr.write(
        `usage: evalgate <run|report|drift|calibrate> [options]\n` +
          `  run       --suite <dir> --sut <module> [--baseline <json>] [--no-cache] [--json <path>]\n` +
          `  report    --json <artifact>\n` +
          `  drift     [--history <path>] [--suite <name>] [--window <n>] [--threshold <n>] [--gate] [--json <path>]\n` +
          `  calibrate --set <path> --judge <module> [--json <path>]\n`,
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
