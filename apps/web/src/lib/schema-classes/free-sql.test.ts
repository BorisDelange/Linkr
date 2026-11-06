import { describe, expect, it } from 'vitest'
import { effectiveMapping, withoutFreeSql } from './overrides'
import type { SchemaMapping } from '@/types/schema-mapping'

const from = { table: 't', alias: 't' }
const mapping = {
  formatVersion: 2,
  presetId: 'p',
  presetLabel: { en: 'P' },
  patient: { from, fields: { patient_id: 't.id' } },
  visit: { customSql: 'SELECT 1' },
  note: { from, fields: { note_text: { expr: 'upper(t.x)' } } },
  visitDetail: { from, where: '  ' },
  concepts: [{ key: 'a', from, where: 't.x = 1' }, { key: 'b', from }],
  events: [{ label: 'a', from, fields: { value: { value: 'expr' } } }, { label: 'b', customSql: 'SELECT 2' }],
  drugs: [{ label: 'a', drugKind: 'prescription', from, fields: { dose: { expr: '1' } } }],
} as unknown as SchemaMapping

describe('withoutFreeSql', () => {
  it('keeps only the relations no text of SQL reaches', () => {
    const out = withoutFreeSql(mapping)
    expect(out.patient).toBeDefined()
    expect(out.visitDetail).toBeDefined()
    expect(out.visit).toBeUndefined()
    expect(out.note).toBeUndefined()
    expect(out.concepts?.map((c) => c.key)).toEqual(['b'])
    expect(out.events?.map((e) => e.label)).toEqual(['a'])
    expect(out.drugs).toEqual([])
  })

  it('covers a relation an override brought in', () => {
    const out = withoutFreeSql(effectiveMapping(mapping, { relations: { patient: { customSql: 'SELECT 3' } } }))
    expect(out.patient).toBeUndefined()
  })

  it('leaves the mapping it was given alone', () => {
    withoutFreeSql(mapping)
    expect(mapping.visit).toBeDefined()
  })
})
