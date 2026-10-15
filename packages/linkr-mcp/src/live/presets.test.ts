import { describe, expect, it } from 'vitest'
import type { SchemaMapping } from '@/types/schema-mapping'
import {
  applyPresetParts, buildRelationSpec, parseRelationKey, presetText, putRelation, relationProblems, type RelationKey,
} from './presets.js'

const base: SchemaMapping = {
  formatVersion: 2,
  presetId: 'eav',
  presetLabel: { en: 'EAV' },
  patient: { from: { table: 'patient', alias: 'p' }, fields: { patient_id: 'p.patient_id' } },
  concepts: [{ key: 'concept', from: { table: 'concept', alias: 'd' }, fields: { concept_id: 'd.id', concept_name: 'd.label' } }],
  events: [{
    label: 'Facts',
    from: { table: 'facts', alias: 'e' },
    fields: { patient_id: 'e.patient_id', concept_id: 'e.code', start_datetime: 'e.at', value_number: 'e.nb' },
  }],
  ddl: 'CREATE TABLE "S"."facts" (id INTEGER);\nCREATE TABLE patient (patient_id INTEGER);',
  knownTables: ['facts', 'patient'],
}

const key = (k: string) => parseRelationKey(k) as RelationKey

describe('relation keys', () => {
  it('reads singleton and listed relations, and refuses anything else', () => {
    expect(key('visitDetail')).toEqual({ key: 'visitDetail', cls: 'visit_detail' })
    expect(key(' drugs.Administrations ')).toEqual({ key: 'drugs.Administrations', cls: 'drug', list: 'drugs', name: 'Administrations' })
    expect(key('events.Signal.raw').name).toBe('Signal.raw')
    expect(parseRelationKey('death')).toMatch(/Unknown relation/)
    expect(parseRelationKey('events.')).toMatch(/Unknown relation/)
  })
})

describe('building a relation', () => {
  it('lays the input over the stored spec: given replaces, null removes, absent keeps', () => {
    const current = base.events![0]
    const spec = buildRelationSpec(key('events.Facts'), { where: "e.context NOT LIKE 'MED:%'", fields: undefined }, current)
    expect(spec).toEqual({ ...current, where: "e.context NOT LIKE 'MED:%'" })
    expect(buildRelationSpec(key('events.Facts'), { where: null }, spec)).toEqual(current)
  })

  it('names the relation from its key and drops what its class does not take', () => {
    const spec = buildRelationSpec(key('drugs.Admin'), { custom_sql: 'SELECT 1', drug_kind: 'administration', gender_values: { male: 'M', female: 'F' } }, undefined)
    expect(spec).toEqual({ label: 'Admin', customSql: 'SELECT 1', drugKind: 'administration' })
    expect(buildRelationSpec(key('events.E'), { drug_kind: 'administration' }, undefined)).toEqual({ label: 'E' })
  })

  it('forgets the measured columns with the SQL they were measured on', () => {
    const spec = buildRelationSpec(key('note'), { custom_sql: null }, { customSql: 'SELECT 1', sqlColumns: ['note_id'] })
    expect(spec).toEqual({})
  })
})

describe('putting a relation', () => {
  it('replaces one in place and appends a new one', () => {
    const replaced = putRelation(base, key('events.Facts'), { ...base.events![0], where: 'true' })
    expect(replaced.events).toHaveLength(1)
    expect(replaced.events![0].where).toBe('true')
    const added = putRelation(base, key('drugs.Admin'), { label: 'Admin', drugKind: 'administration', customSql: 'SELECT 1' } as never)
    expect(added.drugs?.map((d) => d.label)).toEqual(['Admin'])
    expect(putRelation(base, key('note'), { customSql: 'SELECT 1' }).note).toEqual({ customSql: 'SELECT 1' })
  })
})

describe('relation problems', () => {
  it('accepts a relation that compiles', () => {
    expect(relationProblems(base, key('events.Facts'))).toEqual([])
  })

  it('refuses a label shared by an event and a drug, a drug without kind, an unknown dictionary', () => {
    const m = putRelation(base, key('drugs.Facts'), { label: 'Facts', customSql: 'SELECT 1', conceptDictionaryKey: 'nope' } as never)
    const problems = relationProblems(m, key('drugs.Facts'))
    expect(problems.join('\n')).toMatch(/unique across both/)
    expect(problems.join('\n')).toMatch(/needs drug_kind/)
    expect(problems.join('\n')).toMatch(/names no concept dictionary/)
  })

  it('refuses a visual relation with no grain table, and custom SQL that is not one SELECT', () => {
    const m = putRelation(base, key('events.Empty'), { label: 'Empty', fields: { patient_id: 'x.y' } } as never)
    expect(relationProblems(m, key('events.Empty')).join('\n')).toMatch(/needs `from`/)
    const bad = putRelation(base, key('note'), { customSql: 'DELETE FROM x' })
    expect(relationProblems(bad, key('note')).join('\n')).toMatch(/single SELECT/)
  })
})

describe('the rest of a preset', () => {
  it('adds and removes known tables without duplicates, and replaces or drops the DDL', () => {
    const m = applyPresetParts(base, { known_tables_add: ['Signal', 'facts'], known_tables_remove: ['patient'] })
    expect(m.knownTables).toEqual(['facts', 'Signal'])
    expect(applyPresetParts(base, { ddl: null }).ddl).toBeUndefined()
    expect(applyPresetParts(base, {})).toEqual(base)
  })

  it('reads the preset as relations then DDL tables', () => {
    const t = presetText(putRelation(base, key('events.Facts'), { ...base.events![0], where: 'e.nb > 0' }))
    expect(t).toContain('events.Facts (event)')
    expect(t).toContain('  where e.nb > 0')
    expect(t).toContain('DDL: 2 table(s) — S.facts, patient')
  })
})
