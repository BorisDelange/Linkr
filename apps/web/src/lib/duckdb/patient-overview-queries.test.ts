import { describe, it, expect } from 'vitest'
import { buildOverviewEventsQuery, buildOverviewInventoryQuery } from './patient-overview-queries'
import type { SchemaMapping } from '@/types/schema-mapping'

/**
 * The failure this guards is silent, which is what made it expensive: a mapping
 * saved before a preset was corrected can name a column the table does not have
 * — `measurement.value_as_string` exists on `observation` only in CDM 5.4 — and
 * the query 422s. The widget swallowed that error and drew a density band, so a
 * broken row was indistinguishable from a deliberately aggregated one, at every
 * zoom level.
 */
const mapping = {
  patientTable: { table: 'person', idColumn: 'person_id' },
  eventTables: {
    Measurement: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      valueColumn: 'value_as_number',
      valueStringColumn: 'value_as_string',
      patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime',
    },
  },
} as unknown as SchemaMapping

const args: [string, null, string, string[], string, string, number, null] = [
  'p1', null, 'Measurement', ['3027018'], '2128-01-01', '2128-12-31', 500, null,
]

describe('buildOverviewEventsQuery — a stale value column cannot kill the row', () => {
  it('selects the mapped text column by default', () => {
    const sql = buildOverviewEventsQuery(mapping, ...args)!
    expect(sql).toContain('e."value_as_string"')
  })

  it('omits it on request, keeping the shape so callers can retry', () => {
    const sql = buildOverviewEventsQuery(mapping, ...args, true)!
    expect(sql).not.toContain('value_as_string')
    // The retry is only worth anything if the figure still gets its data.
    expect(sql).toContain('e."measurement_datetime"')
    expect(sql).toContain('e."value_as_number"')
    expect(sql).toContain('AS value_string')
  })

  it('produces a different query when omitting, or the retry is pointless', () => {
    const full = buildOverviewEventsQuery(mapping, ...args)
    const bare = buildOverviewEventsQuery(mapping, ...args, true)
    expect(bare).not.toBe(full)
  })

  it('is a no-op for a mapping with no text column, so retrying is detectable', () => {
    const noText = {
      ...mapping,
      eventTables: {
        Measurement: { ...mapping.eventTables!.Measurement, valueStringColumn: undefined },
      },
    } as unknown as SchemaMapping
    expect(buildOverviewEventsQuery(noText, ...args, true)).toBe(
      buildOverviewEventsQuery(noText, ...args),
    )
  })
})

/**
 * The unit of measure lives on the event table, not the concept: the same LOINC
 * code arrives as mmHg or kPa depending on the source. `unitColumn` was already
 * taken — on visitDetailTable it means a hospital ward — so reading it off an
 * event table silently produced NULL for every row.
 */
describe('buildOverviewInventoryQuery — values carry their unit', () => {
  it('selects the mapped unit column', () => {
    const withUnit = {
      ...mapping,
      eventTables: {
        Measurement: {
          ...mapping.eventTables!.Measurement,
          valueUnitColumn: 'unit_source_value',
        },
      },
    } as unknown as SchemaMapping
    const sql = buildOverviewInventoryQuery(withUnit, 'p1', null)!
    expect(sql).toContain('unit_source_value')
    expect(sql).toContain('AS unit')
  })

  it('still builds when no unit column is mapped', () => {
    const sql = buildOverviewInventoryQuery(mapping, 'p1', null)!
    expect(sql).toContain('NULL AS unit')
  })
})
