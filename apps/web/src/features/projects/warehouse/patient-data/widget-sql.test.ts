import { describe, it, expect } from 'vitest'
import { buildWidgetQueries, supportsCustomSql } from './widget-sql'
import type { SchemaMapping } from '@/types'

// The SQL tab exists to answer "why does this widget show no data?". A builder
// returning null is the interesting case: it means the mapping or the config is
// incomplete, and `missing` must name which field — a blank editor would tell the
// user nothing.

const fullMapping = {
  patientTable: { table: 'person', idColumn: 'person_id', genderColumn: 'gender_concept_id' },
  visitTable: {
    table: 'visit_occurrence',
    idColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'visit_start_date',
    endDateColumn: 'visit_end_date',
  },
  noteTable: {
    table: 'note',
    idColumn: 'note_id',
    patientIdColumn: 'person_id',
    dateColumn: 'note_datetime',
    textColumn: 'note_text',
  },
  eventTables: {
    measurement: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime',
      valueColumn: 'value_as_number',
    },
  },
} as unknown as SchemaMapping

const TIMELINE = 'linkr-widget-timeline'
const NOTES = 'linkr-widget-notes'
const SUMMARY = 'linkr-widget-patient-summary'

describe('buildWidgetQueries', () => {
  it('builds one query for the timeline when concepts are selected', () => {
    const [q] = buildWidgetQueries({
      pluginId: TIMELINE,
      config: { conceptIds: [3027018] },
      mapping: fullMapping,
      patientId: '123',
      visitId: null,
    })
    expect(q.sql).toBeTruthy()
    expect(q.sql).toContain('measurement')
    expect(q.missing).toBeUndefined()
  })

  it('names conceptIds as missing when the timeline has none', () => {
    const [q] = buildWidgetQueries({
      pluginId: TIMELINE,
      config: { conceptIds: [] },
      mapping: fullMapping,
      patientId: '123',
      visitId: null,
    })
    expect(q.sql).toBeNull()
    expect(q.missing).toBe('conceptIds')
  })

  it('names the event tables when the mapping has none, not the concepts', () => {
    const noEvents = { ...fullMapping, eventTables: undefined } as unknown as SchemaMapping
    const [q] = buildWidgetQueries({
      pluginId: TIMELINE,
      config: { conceptIds: [3027018] },
      mapping: noEvents,
      patientId: '123',
      visitId: null,
    })
    expect(q.sql).toBeNull()
    expect(q.missing).toBe('schemaMapping.eventTables')
  })

  it('names the note table when notes cannot be queried', () => {
    const noNotes = { ...fullMapping, noteTable: undefined } as unknown as SchemaMapping
    const [q] = buildWidgetQueries({
      pluginId: NOTES,
      config: {},
      mapping: noNotes,
      patientId: '123',
      visitId: null,
    })
    expect(q.sql).toBeNull()
    expect(q.missing).toBe('schemaMapping.noteTable')
  })

  it('returns the patient summary as two labelled queries', () => {
    const qs = buildWidgetQueries({
      pluginId: SUMMARY,
      config: {},
      mapping: fullMapping,
      patientId: '123',
      visitId: null,
    })
    expect(qs.map((q) => q.id)).toEqual(['demographics', 'visits'])
    for (const q of qs) expect(q.sql).toBeTruthy()
  })

  it('reports the missing table per query, not for the whole widget', () => {
    const noVisits = { ...fullMapping, visitTable: undefined } as unknown as SchemaMapping
    const qs = buildWidgetQueries({
      pluginId: SUMMARY,
      config: {},
      mapping: noVisits,
      patientId: '123',
      visitId: null,
    })
    // Demographics still works; only the visit query is blocked.
    expect(qs[0].sql).toBeTruthy()
    expect(qs[1].sql).toBeNull()
    expect(qs[1].missing).toBe('schemaMapping.visitTable')
  })

  it('flags the whole widget when no schema is mapped at all', () => {
    const [q] = buildWidgetQueries({
      pluginId: TIMELINE,
      config: { conceptIds: [3027018] },
      mapping: undefined,
      patientId: '123',
      visitId: null,
    })
    expect(q.missing).toBe('schemaMapping')
  })

  it('still shows the query shape when no patient is selected', () => {
    const [q] = buildWidgetQueries({
      pluginId: NOTES,
      config: {},
      mapping: fullMapping,
      patientId: null,
      visitId: null,
    })
    // A placeholder id keeps the SQL readable instead of returning nothing.
    expect(q.sql).toContain('<patient_id>')
  })

  it('returns nothing for a script plugin, which carries its own code', () => {
    expect(
      buildWidgetQueries({
        pluginId: 'linkr-warehouse-custom',
        config: {},
        mapping: fullMapping,
        patientId: '123',
        visitId: null,
      }),
    ).toEqual([])
  })
})

describe('supportsCustomSql', () => {
  it('allows overriding the single-query OMOP widgets', () => {
    expect(supportsCustomSql(TIMELINE)).toBe(true)
    expect(supportsCustomSql(NOTES)).toBe(true)
  })

  it('refuses the patient summary, whose fixed layout reads two queries', () => {
    expect(supportsCustomSql(SUMMARY)).toBe(false)
  })
})
