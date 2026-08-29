import { describe, it, expect } from 'vitest'
import {
  buildPatientDemographicsQuery,
  buildPatientSummaryQuery,
  buildPatientListQuery,
  buildPatientCountQuery,
  buildTimelineQuery,
} from './patient-data-queries'
import type { SchemaMapping } from '@/types/schema-mapping'

// The age columns are the point of these tests. In OMOP CDM 5.4 `year_of_birth`
// is NOT NULL while `birth_datetime` is nullable and very often empty, so an age
// built from the precise column alone silently resolves to NULL for most real
// datasets — which is exactly how the sidebar's age field came to render "—".
// Both columns must therefore be COALESCEd, and both must reach the GROUP BY.

const patientTable = {
  table: 'person',
  idColumn: 'person_id',
  genderColumn: 'gender_concept_id',
}

const visitTable = {
  table: 'visit_occurrence',
  idColumn: 'visit_occurrence_id',
  patientIdColumn: 'person_id',
  startDateColumn: 'visit_start_date',
  endDateColumn: 'visit_end_date',
}

/** The OMOP preset shape: both birth columns mapped. */
const bothColumns = {
  patientTable: { ...patientTable, birthDateColumn: 'birth_datetime', birthYearColumn: 'year_of_birth' },
  visitTable,
} as unknown as SchemaMapping

const yearOnly = {
  patientTable: { ...patientTable, birthYearColumn: 'year_of_birth' },
  visitTable,
} as unknown as SchemaMapping

const dateOnly = {
  patientTable: { ...patientTable, birthDateColumn: 'birth_datetime' },
  visitTable,
} as unknown as SchemaMapping

const noBirth = {
  patientTable,
  visitTable,
} as unknown as SchemaMapping

describe('patient age expression', () => {
  it('falls back to the year column when the birth datetime is null', () => {
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    // The whole bug: preferring birth_datetime alone yields NULL on OMOP data.
    expect(sql).toContain('COALESCE')
    expect(sql).toContain('birth_datetime')
    expect(sql).toContain('year_of_birth')
  })

  it('groups by every birth column it reads', () => {
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    const groupBy = sql.slice(sql.indexOf('GROUP BY'))
    // Omitting either one is a DuckDB binder error, not a wrong number.
    expect(groupBy).toContain('birth_datetime')
    expect(groupBy).toContain('year_of_birth')
  })

  it('uses the year column directly when it is the only one mapped', () => {
    const sql = buildPatientDemographicsQuery(yearOnly, '123')!
    expect(sql).toContain('year_of_birth')
    expect(sql).not.toContain('COALESCE')
  })

  it('uses the birth date directly when it is the only one mapped', () => {
    const sql = buildPatientDemographicsQuery(dateOnly, '123')!
    expect(sql).toContain('birth_datetime')
    expect(sql).not.toContain('COALESCE')
  })

  it('omits the age column entirely when no birth column is mapped', () => {
    const sql = buildPatientDemographicsQuery(noBirth, '123')!
    expect(sql).not.toContain('AS age')
  })

  it('qualifies both birth columns with the table alias', () => {
    // An unqualified column is ambiguous once the visit table is joined.
    const sql = buildPatientDemographicsQuery(bothColumns, '123')!
    expect(sql).toContain('p."birth_datetime"')
    expect(sql).toContain('p."year_of_birth"')
  })

  it('applies the same fallback to the summary widget query', () => {
    const sql = buildPatientSummaryQuery(bothColumns, '123')!
    // Both age_first_visit and age_last_visit go through the same builder.
    expect(sql).toContain('age_first_visit')
    expect(sql).toContain('COALESCE')
    const groupBy = sql.slice(sql.indexOf('GROUP BY'))
    expect(groupBy).toContain('birth_datetime')
    expect(groupBy).toContain('year_of_birth')
  })

  it('casts the reference date so a bare year subtraction stays valid', () => {
    const sql = buildPatientDemographicsQuery(yearOnly, '123')!
    expect(sql).toContain('::TIMESTAMP')
  })
})

// The sidebar's id search is a LIKE over a cast id. The escaping is the delicate
// part: escSql would double the backslashes escapeLikeTerm just added and the
// ESCAPE clause would silently stop working, so a search for "%" would match
// every patient instead of none.
describe('patient id search', () => {
  const listSql = (search: string) =>
    buildPatientListQuery(bothColumns, null, 50, 0, { patientIdSearch: search })!

  it('filters the list on a substring of the id', () => {
    const sql = listSql('1000')
    expect(sql).toContain('ILIKE')
    expect(sql).toContain("'%1000%'")
  })

  it('applies the same filter to the count, so pagination agrees', () => {
    const sql = buildPatientCountQuery(bothColumns, null, { patientIdSearch: '1000' })!
    expect(sql).toContain("'%1000%'")
  })

  it('casts the id, which is an integer in OMOP', () => {
    expect(listSql('1000')).toContain('CAST(patient_id AS VARCHAR)')
  })

  it('treats a wildcard as a literal rather than matching everything', () => {
    const sql = listSql('%')
    expect(sql).toContain("ESCAPE '\\'")
    // Escaped once — not twice, which is what escSql would have done.
    expect(sql).toContain("'%\\%%'")
  })

  it('escapes the underscore wildcard too', () => {
    expect(listSql('1_0')).toContain("'%1\\_0%'")
  })

  it('escapes a quote so the literal cannot be broken out of', () => {
    expect(listSql("o'brien")).toContain("''")
  })

  it('ignores a blank or whitespace-only search', () => {
    expect(listSql('   ')).not.toContain('ILIKE')
    expect(listSql('')).not.toContain('ILIKE')
  })

  it('combines with the other filters instead of replacing them', () => {
    const sql = buildPatientListQuery(bothColumns, null, 50, 0, {
      patientIdSearch: '1000',
      gender: '8507',
    })!
    expect(sql).toContain('ILIKE')
    expect(sql).toContain("gender = '8507'")
    expect(sql).toContain(' AND ')
  })
})

// A timeline filters event tables by numeric concept ids. A table that names its
// concept inline (`conceptDictionaryKey: 'none'`) holds text there — "Insulin",
// not 220045 — so DuckDB casts the column to compare and throws on the first
// non-numeric row. Every table shares one UNION ALL, so that single error empties
// the whole widget: the branch must not be emitted at all.

const timelineMapping = {
  patientTable: { table: 'patients', idColumn: 'subject_id' },
  conceptTables: [
    { key: 'd_items', table: 'd_items', idColumn: 'itemid', nameColumn: 'label' },
  ],
  eventTables: {
    Measurements: {
      table: 'chartevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'valuenum',
      dateColumn: 'charttime',
      patientIdColumn: 'subject_id',
      conceptDictionaryKey: 'd_items',
    },
    Prescriptions: {
      table: 'prescriptions',
      conceptIdColumn: 'drug',
      valueColumn: 'dose_val_rx',
      dateColumn: 'starttime',
      patientIdColumn: 'subject_id',
      conceptDictionaryKey: 'none',
    },
  },
} as unknown as SchemaMapping

describe('timeline query', () => {
  const sql = () => buildTimelineQuery(timelineMapping, [220045, 220210], '10002495', null)

  it('keeps the tables whose concepts are ids', () => {
    expect(sql()).toContain('"chartevents"')
    expect(sql()).toContain('IN (220045, 220210)')
  })

  it('drops a table that names its concept inline, rather than casting text to int', () => {
    // The bug: this branch made the whole UNION fail, so a patient with 310 rows
    // of heart rate showed "no data".
    expect(sql()).not.toContain('"prescriptions"')
    expect(sql()).not.toContain('drug')
  })

  it('still returns a query when only the id-keyed tables survive', () => {
    expect(sql()).toContain('ORDER BY event_date')
  })

  it('returns null when no table can be filtered by concept id', () => {
    const inlineOnly = {
      ...timelineMapping,
      eventTables: { Prescriptions: timelineMapping.eventTables!.Prescriptions },
    } as SchemaMapping
    // Null is the honest answer: the widget reports a mapping problem instead of
    // rendering an error, which is what `missing` in buildWidgetQueries is for.
    expect(buildTimelineQuery(inlineOnly, [220045], '10002495', null)).toBeNull()
  })

  it('keeps an id-keyed table that simply has no dictionary to join', () => {
    // Only the inline opt-out is dropped. A concept id column with no dictionary
    // is still an id column — OMOP `measurement_concept_id` with no vocabulary
    // loaded filters fine, it just labels the series with the raw id.
    const noDict = {
      patientTable: { table: 'person', idColumn: 'person_id' },
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
    const sql = buildTimelineQuery(noDict, [3027018], '123', null)
    expect(sql).toContain('"measurement"')
    expect(sql).toContain('IN (3027018)')
  })
})
