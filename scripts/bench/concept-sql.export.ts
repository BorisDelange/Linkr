import { it } from 'vitest'
import { writeFileSync } from 'fs'
import path from 'path'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { conceptRelations } from '@/lib/schema-classes/relations'
import { buildSizeQuery, buildPatientBoundsQuery } from '@/lib/duckdb/catalog-queries'
import { planConceptCountUnits } from '@/features/projects/warehouse/concepts/concept-count-plan'
import { buildConceptsAssembleQuery, computeAvailableColumns } from '@/features/projects/warehouse/concepts/concept-queries'
import { buildOverviewEventsQuery, buildOverviewInventoryQuery, buildOverviewTileDensityQuery } from '@/lib/duckdb/patient-overview-queries'
import { NO_SCOPE } from '@/lib/duckdb/patient-scope'
import { bucketMsFor, tileBounds, tilesCovering } from '@/features/projects/warehouse/patient-data/widgets/overview-tiles'

// The synthetic OMOP `bench_concepts.py` generates.
const v1 = {
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender_concept_id' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name', categoryColumn: 'domain_id' }],
  eventTables: {
    Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', sourceConceptIdColumn: 'measurement_source_concept_id', patientIdColumn: 'person_id', dateColumn: 'measurement_datetime' },
    Condition: { table: 'condition_occurrence', conceptIdColumn: 'condition_concept_id', sourceConceptIdColumn: 'condition_source_concept_id', patientIdColumn: 'person_id', dateColumn: 'condition_start_datetime' },
    Drug: { table: 'drug_exposure', conceptIdColumn: 'drug_concept_id', patientIdColumn: 'person_id', dateColumn: 'drug_exposure_start_datetime' },
  },
}

it('exports the concept-count SQL', () => {
  const mapping = mappingV1ToV2(v1 as unknown as SchemaMappingV1)
  const cols = computeAvailableColumns(conceptRelations(mapping))
  // Slice bounds are placeholders ('__B1'…) the bench replaces with real ones.
  const slices = (n: number) => n < 2 ? [{}] : Array.from({ length: n }, (_, i) => ({ ...(i ? { lo: `__B${i}` } : {}), ...(i < n - 1 ? { hi: `__B${i + 1}` } : {}) }))
  const plan = (n: number) => planConceptCountUnits(mapping, slices(n)).map((u) => ({ ...u, sql: withClassRelations(u.sql, mapping) }))
  const assemble = (r: boolean, p: boolean) => withClassRelations(buildConceptsAssembleQuery(mapping, cols, { recordsComplete: r, patientsComplete: p })!, mapping)
  const sizes = [1, 2, 4, 8, 16, 32, 64]
  writeFileSync(path.join(__dirname, 'sql.json'), JSON.stringify({
    size: withClassRelations(buildSizeQuery(mapping)!, mapping),
    bounds: Object.fromEntries(sizes.filter((n) => n > 1).map((n) => [n, withClassRelations(buildPatientBoundsQuery(mapping, n)!, mapping)])),
    plans: Object.fromEntries(sizes.map((n) => [n, plan(n)])),
    assemble: { partial: assemble(true, false), complete: assemble(true, true) },
    overview: overview(mapping),
  }, null, 2))
})

/**
 * The Data overview's queries for patient 1 (the heavy one), at three zoom
 * levels over the generated dates, on a 1000-pixel plot: whole record, a week,
 * a day. Density covers every table; events one day of one table.
 */
function overview(mapping: ReturnType<typeof mappingV1ToV2>) {
  const rows = ['Measurement', 'Condition', 'Drug'].map((table) => ({ key: table, table, conceptIds: [] as string[] }))
  const lo = Date.UTC(2010, 0, 1)
  const views = { record: [lo, lo + 400_000_000_000], week: [lo + 2e11, lo + 2e11 + 7 * 864e5], day: [lo + 2e11, lo + 2e11 + 864e5] }
  const iso = (ms: number) => new Date(ms).toISOString()
  const density = Object.fromEntries(Object.entries(views).map(([name, [a, b]]) => {
    const bw = bucketMsFor(b - a, 1000)
    // One query for every tile of the view, as the widget reads them.
    const tiles = tilesCovering(a, b, bw)
    const from = tileBounds(tiles[0], bw)[0]
    const to = tileBounds(tiles[tiles.length - 1], bw)[1]
    return [name, [withClassRelations(buildOverviewTileDensityQuery(mapping, '1', NO_SCOPE, rows, bw, iso(from), iso(to))!, mapping)]]
  }))
  const ids = Array.from({ length: 50 }, (_, i) => String(i + 1))
  return {
    inventory: withClassRelations(buildOverviewInventoryQuery(mapping, '1', NO_SCOPE)!, mapping),
    density,
    events: withClassRelations(buildOverviewEventsQuery(mapping, '1', NO_SCOPE, 'Measurement', ids, iso(views.day[0]), iso(views.day[1]), 4000)!, mapping),
  }
}
