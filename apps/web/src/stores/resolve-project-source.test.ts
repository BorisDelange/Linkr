import { describe, it, expect } from 'vitest'
import { resolveProjectSource } from './data-source-store'
import type { DataSource } from '@/types'

const ds = (over: Partial<DataSource>): DataSource =>
  ({
    id: 'x',
    alias: 'x',
    name: { en: 'X' },
    description: {},
    sourceType: 'database',
    connectionConfig: { engine: 'duckdb' },
    status: 'connected',
    workspaceId: 'ws-1',
    schemaMapping: { patientTable: { table: 'person' } },
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as DataSource

describe('resolveProjectSource', () => {
  it('returns the database the entity asked for', () => {
    const rows = [ds({ id: 'a' }), ds({ id: 'b' })]
    expect(resolveProjectSource(rows, ['a', 'b'], 'b')?.id).toBe('b')
  })

  it('falls back to the first usable database when none was asked for', () => {
    // A board written before the field existed carries no id at all.
    const rows = [ds({ id: 'a' }), ds({ id: 'b' })]
    expect(resolveProjectSource(rows, ['a', 'b'], undefined)?.id).toBe('a')
  })

  it('falls back when the asked-for database is no longer linked', () => {
    const rows = [ds({ id: 'gone' }), ds({ id: 'still-here' })]
    expect(resolveProjectSource(rows, ['still-here'], 'gone')?.id).toBe('still-here')
  })

  it('falls back when the asked-for database is disconnected', () => {
    const rows = [ds({ id: 'down', status: 'error' }), ds({ id: 'up' })]
    expect(resolveProjectSource(rows, ['down', 'up'], 'down')?.id).toBe('up')
  })

  it('never offers a database the project has not linked', () => {
    const rows = [ds({ id: 'foreign' })]
    expect(resolveProjectSource(rows, [], 'foreign')).toBeUndefined()
    expect(resolveProjectSource(rows, [], undefined)).toBeUndefined()
  })

  it('honours an explicit choice even without a patient table', () => {
    // The fallback needs a mapping to be a safe guess, but an explicit choice is
    // the user's call — overriding it silently is what this change set out to fix.
    const rows = [ds({ id: 'raw', schemaMapping: undefined }), ds({ id: 'mapped' })]
    expect(resolveProjectSource(rows, ['raw', 'mapped'], 'raw')?.id).toBe('raw')
  })

  it('skips unmapped databases when guessing', () => {
    const rows = [ds({ id: 'raw', schemaMapping: undefined }), ds({ id: 'mapped' })]
    expect(resolveProjectSource(rows, ['raw', 'mapped'], undefined)?.id).toBe('mapped')
  })

  it('returns nothing when no linked database is usable', () => {
    const rows = [ds({ id: 'down', status: 'error' })]
    expect(resolveProjectSource(rows, ['down'], undefined)).toBeUndefined()
  })
})
