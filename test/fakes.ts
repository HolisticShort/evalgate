import type {
  JudgeProvider,
  EmbeddingProvider,
  SystemUnderTest,
  CaseInput,
  SutOutput,
} from '../src/types.js'

/**
 * A scripted judge. The whole reason providers are injected rather than
 * imported: the grounding pipeline is fully testable offline, with no API key
 * and no non-determinism.
 */
export function fakeJudge(responses: unknown[]): JudgeProvider & { calls: string[] } {
  const queue = [...responses]
  const calls: string[] = []
  return {
    id: 'fake-judge',
    calls,
    async judge<T>(prompt: string): Promise<T> {
      calls.push(prompt)
      if (queue.length === 0) throw new Error('fakeJudge: no scripted response left')
      return queue.shift() as T
    },
  }
}

export function fakeEmbed(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    id: 'fake-embed',
    async embed(texts) {
      return texts.map(t => vectors[t] ?? [0, 0, 0])
    },
  }
}

export function fakeSut(
  outputs: SutOutput[] | ((i: CaseInput, n: number) => SutOutput | Promise<SutOutput>),
  version = 'v1',
): SystemUnderTest & { runs: number } {
  let runs = 0
  const sut = {
    name: 'fake-sut',
    version,
    get runs() {
      return runs
    },
    async run(input: CaseInput) {
      const n = runs++
      if (typeof outputs === 'function') return outputs(input, n)
      return outputs[n % outputs.length] as SutOutput
    },
  }
  return sut as SystemUnderTest & { runs: number }
}
