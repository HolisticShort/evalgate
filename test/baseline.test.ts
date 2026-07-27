import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBaselines } from '../src/baseline.js'
import { ConfigError } from '../src/config.js'

const tmp = async (name: string, contents: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'evalgate-'))
  const path = join(dir, name)
  await writeFile(path, contents, 'utf8')
  return path
}

const artifact = [{ suite: 'support-agent', sut: 'v1', mean: 0.86, cases: [], gates: [], passed: true }]

test('no --baseline is a choice, not an error', async () => {
  // The regression gate reports itself as skipped; the caller opted out.
  assert.equal((await loadBaselines(undefined)).size, 0)
})

test('a baseline that cannot be read is a config error, not a silent skip', async () => {
  // This is the bug the shipped CI template had: --baseline pointed at a git
  // ref, readFile failed, and the regression gate reported ✓ skipped. Asking
  // for the gate and silently not getting it is the failure this tool exists
  // to prevent.
  await assert.rejects(() => loadBaselines('/nonexistent/baseline.json'), ConfigError)
  await assert.rejects(() => loadBaselines('origin/main'), /could not read baseline/)
})

test('the error explains how to produce a baseline', async () => {
  await assert.rejects(() => loadBaselines('origin/main'), /evalgate run .*--json origin\/main/s)
})

test('a baseline that is not a result artifact is rejected', async () => {
  const garbage = await tmp('b.json', 'not json')
  const wrongShape = await tmp('b.json', '{"hello":"world"}')
  const missingMean = await tmp('b.json', '[{"suite":"a"}]')

  await assert.rejects(() => loadBaselines(garbage), /not valid JSON/)
  await assert.rejects(() => loadBaselines(wrongShape), /not a result artifact/)
  await assert.rejects(() => loadBaselines(missingMean), /not a result artifact/)
})

test('baselines are keyed by suite name so a multi-suite repo compares like with like', async () => {
  const two = [...artifact, { ...artifact[0], suite: 'other', mean: 0.5 }]
  const map = await loadBaselines(await tmp('b.json', JSON.stringify(two)))
  assert.equal(map.size, 2)
  assert.equal(map.get('support-agent')?.mean, 0.86)
  assert.equal(map.get('other')?.mean, 0.5)
})

test('a single-suite artifact is accepted unwrapped', async () => {
  const map = await loadBaselines(await tmp('b.json', JSON.stringify(artifact[0])))
  assert.equal(map.get('support-agent')?.mean, 0.86)
})
