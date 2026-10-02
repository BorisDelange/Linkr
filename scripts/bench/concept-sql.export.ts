import { it } from 'vitest'
import { writeFileSync } from 'fs'
import path from 'path'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { conceptRelations } from '@/lib/schema-classes/relations'
import { buildSizeQuery, buildPatientBoundsQuery } from '@/lib/duckdb/catalog-queries'
import { planConceptCountUnits } from '@/features/projects/warehouse/concepts/concept-count-plan'
import { buildConceptsAssembleQuery, computeAvailableColumns } from '@/features/projects/warehouse/concepts/concept-queries'

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
  }, null, 2))
})
