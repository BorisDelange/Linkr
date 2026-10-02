import { describe, it, expect } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { buildOverviewEventsQuery, buildOverviewInventoryQuery } from './patient-overview-queries'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { NO_SCOPE, type PatientScope } from './patient-scope'

/**
 * The failure this guards is silent, which is what made it expensive: a mapping
 * saved before a preset was corrected can name a column the table does not have
 * — `measurement.value_as_string` exists on `observation` only in CDM 5.4 — and
 * the query 422s. The widget swallowed that error and drew a density band, so a
 * broken row was indistinguishable from a deliberately aggregated one, at every
 * zoom level.
 */
const mapping_V1: SchemaMappingV1 = {
  presetId: 'test',
  presetLabel: { en: 'Test' },
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
}
const mapping = mappingV1ToV2(mapping_V1)

const args: [string, PatientScope, string, string[], string, string, number] = [
  'p1', NO_SCOPE, 'Measurement', ['3027018'], '2128-01-01', '2128-12-31', 500,
]

describe('buildOverviewEventsQuery — a stale value column cannot kill the row', () => {
  it('selects the text column through the relation', () => {
    const sql = buildOverviewEventsQuery(mapping, ...args)!
    expect(sql).toContain('CAST(e.value_string AS VARCHAR) AS value_string')
    expect(withClassRelations(sql, mapping)).toContain('e."value_as_string" AS value_string')
  })

  it('pads the column, so a table lacking it reads NULL instead of failing', () => {
    // The relation's FROM adds an empty UNION BY NAME branch naming every mapped
    // column: where the table has it, nothing changes; where it does not, NULL.
    const sql = withClassRelations(buildOverviewEventsQuery(mapping, ...args)!, mapping)
    expect(sql).toMatch(/UNION ALL BY NAME SELECT [^)]*NULL AS "value_as_string"/)
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
    const withUnit = mappingV1ToV2({
      ...mapping_V1,
      eventTables: {
        Measurement: {
          ...mapping_V1.eventTables!.Measurement,
          valueUnitColumn: 'unit_source_value',
        },
      },
    } as never)
    const sql = withClassRelations(buildOverviewInventoryQuery(withUnit, 'p1', NO_SCOPE)!, withUnit)
    expect(sql).toContain('e."unit_source_value" AS unit')
    expect(sql).toContain('MAX(e.unit) AS unit')
  })

  it('still builds when no unit column is mapped', () => {
    const sql = buildOverviewInventoryQuery(mapping, 'p1', NO_SCOPE)!
    expect(sql).toContain('NULL AS unit')
  })
})

/**
 * MIMIC names the drug inline — `prescriptions.drug` holds "Vancomycin", not an
 * id — so there is no dictionary to join. Omitting the key silently selects the
 * first dictionary, which made DuckDB try to cast 'Vancomycin' to INT64; 'none'
 * says so explicitly.
 */
describe('an event table can declare it has no dictionary', () => {
  const inline = mappingV1ToV2({
    patientTable: { table: 'patients', idColumn: 'subject_id' },
    conceptTables: [
      { key: 'd_items', table: 'd_items', idColumn: 'itemid', nameColumn: 'label' },
    ],
    eventTables: {
      Prescriptions: {
        table: 'prescriptions',
        conceptIdColumn: 'drug',
        valueColumn: 'dose_val_rx',
        valueUnitColumn: 'dose_unit_rx',
        routeColumn: 'route',
        patientIdColumn: 'subject_id',
        dateColumn: 'starttime',
        endDateColumn: 'stoptime',
        conceptDictionaryKey: 'none',
      },
    },
  } as never)

  it('joins no dictionary, so a text concept column cannot break the query', () => {
    const sql = withClassRelations(buildOverviewInventoryQuery(inline, 'p1', NO_SCOPE)!, inline)
    expect(sql).not.toContain('d_items')
    expect(sql).toContain('prescriptions')
  })

  it('still reports the unit and the route, which do not need a dictionary', () => {
    const sql = withClassRelations(buildOverviewInventoryQuery(inline, 'p1', NO_SCOPE)!, inline)
    expect(sql).toContain('e."dose_unit_rx" AS unit')
    const events = buildOverviewEventsQuery(
      inline, 'p1', NO_SCOPE, 'Prescriptions', ['Vancomycin'], '2174-01-01', '2174-12-31', 10,
    )!
    expect(events).toContain('CAST(e.route AS VARCHAR) AS route')
  })
})
