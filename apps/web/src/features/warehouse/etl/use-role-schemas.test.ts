import { describe, it, expect } from 'vitest'
import { computeRoleSchemas, type RoleSchemaInput } from './use-role-schemas'

const SOURCE = 'src-id'
const TARGET = 'tgt-id'
const VOCAB = 'voc-id'

function input(over: Partial<RoleSchemaInput> = {}): RoleSchemaInput {
  return {
    serverMode: true,
    runningOnId: TARGET,
    sourceId: SOURCE,
    targetId: TARGET,
    vocabId: VOCAB,
    knownIds: [SOURCE, TARGET, VOCAB],
    targetIsManaged: true,
    ...over,
  }
}

describe('computeRoleSchemas', () => {
  it('resolves every role to its own name for an ETL run', () => {
    expect(computeRoleSchemas(input())).toEqual({
      source: 'source',
      target: 'target',
      vocab: 'vocab',
    })
  })

  it('keeps resolving target. when the script is aimed at the source', () => {
    // The picker next to Run only chooses where unqualified statements land; it
    // must not change what `target.` means, or `DELETE FROM
    // target.source_to_concept_map` reaches the server unresolved.
    expect(computeRoleSchemas(input({ runningOnId: SOURCE }))).toEqual({
      source: 'source',
      target: 'target',
      vocab: 'vocab',
    })
  })

  it('resolves roles even when the picker points outside the pipeline', () => {
    expect(computeRoleSchemas(input({ runningOnId: 'unrelated' })).target).toBe('target')
  })

  it('without a managed target, only the queried database is reachable', () => {
    const r = computeRoleSchemas(input({ targetIsManaged: false, runningOnId: SOURCE }))
    // '' means "resolve bare against the queried database".
    expect(r.source).toBe('')
    // Unresolved, so the error names the role rather than a schema that cannot exist.
    expect(r.target).toBeUndefined()
    expect(r.vocab).toBeUndefined()
  })

  it('leaves a role unset when the pipeline has no such database', () => {
    expect(computeRoleSchemas(input({ targetId: undefined })).target).toBeUndefined()
  })

  it('leaves a role unset when its data source was deleted', () => {
    const r = computeRoleSchemas(input({
      serverMode: false,
      knownIds: [SOURCE, TARGET],
    }))
    expect(r.vocab).toBeUndefined()
    expect(r.source).toBeTruthy()
  })

  it('front-only maps each role to its own ds_ schema', () => {
    const r = computeRoleSchemas(input({ serverMode: false }))
    expect(r.source).toMatch(/^ds_/)
    expect(r.target).toMatch(/^ds_/)
    expect(r.source).not.toBe(r.target)
  })
})
