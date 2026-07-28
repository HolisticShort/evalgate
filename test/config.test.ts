import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSuites, ConfigError } from '../src/config.js'
import type { SourceDocument } from '../src/types.js'

async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evalgate-cfg-'))
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
  return dir
}

const suiteYaml = (context: string) => `
name: s
thresholds:
  floor: 0.8
cases:
  - id: c
    input:
      prompt: hi
      context:
${context}
    assertions:
      - type: grounded
`

test('textFile is read and inlined as text', async () => {
  const dir = await scratch({
    'docs/policy.md': 'Refunds within 30 days.',
    'suite.yaml': suiteYaml('        - id: policy\n          textFile: ./docs/policy.md'),
  })

  const [suite] = await loadSuites(join(dir, 'suite.yaml'))
  const ctx = suite?.cases[0]?.input.context as SourceDocument[]
  assert.equal(ctx[0]?.id, 'policy')
  assert.equal(ctx[0]?.text, 'Refunds within 30 days.')
  assert.ok(!('textFile' in (ctx[0] as object)))
})

test('textFile resolves against the suite file, not the working directory', async () => {
  // A suite must mean the same thing wherever evalgate is invoked from.
  const dir = await scratch({
    'evals/docs/policy.md': 'body',
    'evals/suite.yaml': suiteYaml('        - id: policy\n          textFile: ./docs/policy.md'),
  })
  const [suite] = await loadSuites(join(dir, 'evals/suite.yaml'))
  assert.equal((suite?.cases[0]?.input.context as SourceDocument[])[0]?.text, 'body')
})

test('a missing textFile is a config error naming the resolved path', async () => {
  const dir = await scratch({
    'suite.yaml': suiteYaml('        - id: policy\n          textFile: ./nope.md'),
  })
  await assert.rejects(() => loadSuites(join(dir, 'suite.yaml')), (e: Error) => {
    assert.ok(e instanceof ConfigError, 'must be a ConfigError so the CLI exits 2, not 1')
    assert.match(e.message, /could not read textFile .*nope\.md/)
    assert.match(e.message, /policy/)
    return true
  })
})

test('text and textFile together is rejected rather than silently preferring one', async () => {
  const dir = await scratch({
    'docs/policy.md': 'from file',
    'suite.yaml': suiteYaml(
      '        - id: policy\n          text: inline\n          textFile: ./docs/policy.md',
    ),
  })
  await assert.rejects(() => loadSuites(join(dir, 'suite.yaml')), /sets both text and textFile/)
})

test('a YAML anchor shared across cases resolves for every reference', async () => {
  const dir = await scratch({
    'docs/policy.md': 'shared body',
    'suite.yaml': `
name: s
thresholds:
  floor: 0.8
sources: &policy
  - id: policy
    textFile: ./docs/policy.md
cases:
  - id: a
    input: { prompt: hi, context: *policy }
    assertions: [{ type: grounded }]
  - id: b
    input: { prompt: yo, context: *policy }
    assertions: [{ type: grounded }]
`,
  })

  const [suite] = await loadSuites(join(dir, 'suite.yaml'))
  for (const c of suite?.cases ?? []) {
    assert.equal((c.input.context as SourceDocument[])[0]?.text, 'shared body')
  }
})

test('an inline text source is left exactly as written', async () => {
  const dir = await scratch({
    'suite.yaml': suiteYaml('        - id: policy\n          text: inline body'),
  })
  const [suite] = await loadSuites(join(dir, 'suite.yaml'))
  assert.equal((suite?.cases[0]?.input.context as SourceDocument[])[0]?.text, 'inline body')
})

test('textFile works for sources declared on the assertion', async () => {
  const dir = await scratch({
    'docs/policy.md': 'pinned body',
    'suite.yaml': `
name: s
thresholds: { floor: 0.8 }
cases:
  - id: c
    input: { prompt: hi }
    assertions:
      - type: grounded
        sources:
          - id: pinned
            textFile: ./docs/policy.md
`,
  })
  const [suite] = await loadSuites(join(dir, 'suite.yaml'))
  const a = suite?.cases[0]?.assertions[0] as { sources: SourceDocument[] }
  assert.equal(a.sources[0]?.text, 'pinned body')
})

test('an empty textFile is a config error, not an empty document', async () => {
  const dir = await scratch({
    'suite.yaml': suiteYaml('        - id: policy\n          textFile: ""'),
  })
  await assert.rejects(() => loadSuites(join(dir, 'suite.yaml')), /textFile must be a non-empty string/)
})
