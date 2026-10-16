import type { SchemaMapping } from '@/types/schema-mapping'
import type { PatientScope } from '@/lib/duckdb/patient-scope'
import { eventRelations } from '@/lib/schema-classes/relations'
import {
  buildOverviewDeathQuery,
  buildOverviewDensityQuery,
  buildOverviewEventsQuery,
  buildOverviewInventoryQuery,
  buildOverviewTileDensityQuery,
  buildOverviewUnitStaysQuery,
} from '@/lib/duckdb/patient-overview-queries'

// Values only: whether a query can be computed by the database depends on its
// shape, so one plan serves every patient and every view.
const PATIENT = 'patient'
const FROM = '2000-01-01T00:00:00.000Z'
const TO = '2000-01-02T00:00:00.000Z'

/** One query of each kind the overview sends, over every event table — what is
 *  asked of the server before a record loads (use-slow-queries.ts). */
export function overviewProbeQueries(mapping: SchemaMapping, scope: PatientScope): string[] {
  const tables = eventRelations(mapping).map((e) => e.key ?? e.name)
  const bands = tables.map((table) => ({ key: table, table, conceptIds: ['0'] }))
  return [
    buildOverviewInventoryQuery(mapping, PATIENT, scope),
    buildOverviewUnitStaysQuery(mapping, PATIENT, scope.visitId),
    buildOverviewDeathQuery(mapping, PATIENT),
    buildOverviewDensityQuery(mapping, PATIENT, scope, FROM, TO, 240, bands),
    buildOverviewTileDensityQuery(mapping, PATIENT, scope, bands, 60_000, FROM, TO),
    ...tables.map((table) => buildOverviewEventsQuery(mapping, PATIENT, scope, table, ['0'], FROM, TO, 1)),
  ].filter((sql): sql is string => !!sql)
}
