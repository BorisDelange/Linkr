import { describe, expect, it } from 'vitest'
import type { SchemaMapping } from '@/types'
import { normalizeCriteria } from './cohorts.js'
import { convertAtlas, describeFreeze, freezeBlocker, readAtlasInput } from './cohorts-extra.js'

const ATLAS = {
  ConceptSets: [{
    id: 0, name: 'Lactate',
    expression: { items: [{ concept: { CONCEPT_ID: 3047181, CONCEPT_NAME: 'Lactate' }, isExcluded: false, includeDescendants: true, includeMapped: false }] },
  }],
  PrimaryCriteria: { CriteriaList: [{ Measurement: { CodesetId: 0 } }] },
  InclusionRules: [{
    name: 'Adults',
    expression: { Type: 'ALL', CriteriaList: [], Groups: [], DemographicCriteriaList: [{ Age: { Value: 18, Op: 'gte' }, Gender: [{ CONCEPT_ID: 8507 }] }] },
  }],
}

describe('readAtlasInput', () => {
  it('takes the object, a JSON string, a fenced string, or a WebAPI record', () => {
    for (const raw of [ATLAS, JSON.stringify(ATLAS), `\`\`\`json\n${JSON.stringify(ATLAS)}\n\`\`\``]) {
      const read = readAtlasInput(raw)
      expect('definition' in read && read.definition.ConceptSets).toHaveLength(1)
    }
    const record = readAtlasInput({ id: 12, name: 'Hyperlactatemia', expression: JSON.stringify(ATLAS) })
    expect(record).toMatchObject({ name: 'Hyperlactatemia', definition: { PrimaryCriteria: ATLAS.PrimaryCriteria } })
  })

  it('says what is wrong with anything else', () => {
    expect(readAtlasInput('{not json')).toEqual({ error: expect.stringContaining('not valid JSON') })
    expect(readAtlasInput({ criteriaTree: {} })).toEqual({ error: expect.stringContaining('not an ATLAS cohort definition') })
    expect(readAtlasInput([1])).toHaveProperty('error')
  })
})

describe('convertAtlas', () => {
  it('runs the app conversion and counts the criteria kept', () => {
    const read = readAtlasInput(ATLAS)
    if (!('definition' in read)) throw new Error('unreadable')
    const { tree, warnings, criteria } = convertAtlas(read.definition)
    expect(criteria).toBe(3)
    expect(tree.children[0]).toMatchObject({ type: 'concept', config: { eventTableLabel: 'measurement', conceptIds: [3047181] } })
    expect(warnings.join('\n')).toContain('includeDescendants')
  })

  it('checks cleanly against an OMOP mapping, and flags a mapping that differs', () => {
    const read = readAtlasInput(ATLAS)
    if (!('definition' in read)) throw new Error('unreadable')
    const { tree } = convertAtlas(read.definition)
    const omop = {
      patientTable: { table: 'person', idColumn: 'person_id', birthDateColumn: 'birth_datetime' },
      genderValues: { male: '8507', female: '8532' },
      eventTables: { measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id' } },
    } as unknown as SchemaMapping
    expect(normalizeCriteria(tree, omop).errors).toEqual([])
    const mimic = { ...omop, genderValues: { male: 'M', female: 'F' }, eventTables: { labevents: {} } } as unknown as SchemaMapping
    const errors = normalizeCriteria(tree, mimic).errors.join('\n')
    expect(errors).toContain('"measurement" is not an event table')
    expect(errors).toContain('8507 not in genderValues')
  })
})

describe('freeze helpers', () => {
  it('refuses what the app does not offer', () => {
    expect(freezeBlocker({ projectUid: 'p', level: 'visit' })).toBeNull()
    expect(freezeBlocker({ projectUid: 'p', level: 'event' })).toContain('event-level')
    expect(freezeBlocker({ level: 'patient' })).toContain('project')
  })

  it('describes the snapshot, what it replaced, and the custom SQL caveat', () => {
    const mat = { level: 'visit' as const, ids: ['1', '2', '3'], patientIds: ['7', '8'], count: 3, materializedAt: '2026-09-24T12:00:00.000Z' }
    const out = describeFreeze('ICU stays', mat, { ...mat, count: 2, materializedAt: 'earlier' }, true)
    expect(out).toContain('Froze "ICU stays": 3 visit(s) of 2 patient(s)')
    expect(out).toContain('replaces the snapshot of earlier (2)')
    expect(out).toContain('custom SQL')
    expect(describeFreeze('x', { ...mat, level: 'patient' }, null, false)).not.toMatch(/of \d+ patient|replaces|custom/)
  })
})
