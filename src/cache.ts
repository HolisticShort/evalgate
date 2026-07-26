import { createHash } from 'node:crypto'
import type { EvalCase, AssertionConfig } from './types.js'

/**
 * Content-addressed cache. Evals cost money and wall-clock, and both scale with
 * contributor count — the naive design gets more expensive exactly as it gets
 * more useful, and then gets turned off. See SPEC.md § Caching.
 */
export interface CacheKeyParts {
  caseInput: EvalCase['input']
  /** Opaque to evalgate. Git SHA, prompt hash, whatever is meaningful to the caller. */
  sutVersion: string
  modelId: string
  modelParams: Record<string, unknown>
  assertion: AssertionConfig
}

export function cacheKey(parts: CacheKeyParts): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}

/**
 * Key stability depends on deterministic serialization — JSON.stringify key
 * order follows insertion order, so an unsorted stringify silently produces
 * cache misses on semantically identical configs.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(',')}}`
}

export interface Cache {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
}

/** In-memory cache. Useful for tests and single-process runs. */
export class MemoryCache implements Cache {
  private store = new Map<string, unknown>()
  async get(key: string): Promise<unknown | undefined> {
    return this.store.get(key)
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
}

/**
 * File-backed cache, one JSON file per key, restored by actions/cache in CI.
 *
 * A read failure is a miss, never an error: a corrupt or partially written
 * cache entry must degrade to re-running the case, not fail the build. The
 * cache is an optimization and is never allowed to become a source of red.
 */
export class FileCache implements Cache {
  constructor(private dir: string) {}

  async get(key: string): Promise<unknown | undefined> {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    try {
      return JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8'))
    } catch {
      return undefined
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const { mkdir, writeFile, rename } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(this.dir, { recursive: true })
    // Write-then-rename: a run interrupted mid-write must not leave a truncated
    // entry that a later run reads as a hit.
    const tmp = join(this.dir, `${key}.json.tmp`)
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    await rename(tmp, join(this.dir, `${key}.json`))
  }
}

/**
 * A missing SUT version disables the cache with a loud warning rather than
 * guessing. Silently serving stale results is the worst failure this tool can
 * have — it reports green on a regression.
 */
export function cacheEnabled(sutVersion: string | undefined, warn: (m: string) => void): boolean {
  if (!sutVersion) {
    warn('cache disabled: system under test has no version — set SystemUnderTest.version to enable')
    return false
  }
  return true
}
