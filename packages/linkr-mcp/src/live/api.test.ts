import { describe, expect, it } from 'vitest'
import { withV2Mapping, type DataSource } from './api'

describe('withV2Mapping', () => {
  it('reads malformed overrides as none, as the app does', () => {
    const base = { knownTables: ['person'] }
    const ds = { id: 'db', schemaMapping: base, schemaOverrides: { relations: { 'events.Lab': null }, removed: [3] } } as unknown as DataSource
    expect(withV2Mapping(ds).schemaMapping).toMatchObject(base)
  })
})
