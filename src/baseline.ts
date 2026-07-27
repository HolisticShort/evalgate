import { readFile } from 'node:fs/promises'
import type { SuiteResult } from './types.js'
import { ConfigError } from './config.js'

/**
 * Baselines are keyed by suite name so a multi-suite repo compares like with
 * like.
 *
 * Not passing `--baseline` is a choice, and the regression gate reports itself
 * as skipped. Passing one that cannot be loaded is a config error: asking for a
 * regression gate and silently not getting one is the exact failure this tool
 * exists to prevent, and it used to warn on stderr while the gate reported ✓.
 */
export async function loadBaselines(path?: string): Promise<Map<string, SuiteResult>> {
  const map = new Map<string, SuiteResult>()
  if (!path) return map

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new ConfigError(
      `could not read baseline at ${path}\n` +
        `  A baseline is a result artifact from the base branch. Produce one with\n` +
        `    evalgate run --suite <dir> --sut <module> --json ${path}\n` +
        `  and commit it, or drop --baseline to run without a regression gate.`,
    )
  }

  let parsed: SuiteResult[] | SuiteResult
  try {
    parsed = JSON.parse(raw) as SuiteResult[] | SuiteResult
  } catch {
    throw new ConfigError(`baseline at ${path} is not valid JSON — it must be a result artifact from \`evalgate run\``)
  }

  for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof r?.suite !== 'string' || typeof r?.mean !== 'number') {
      throw new ConfigError(`baseline at ${path} is not a result artifact — expected objects with \`suite\` and \`mean\``)
    }
    map.set(r.suite, r)
  }
  return map
}
