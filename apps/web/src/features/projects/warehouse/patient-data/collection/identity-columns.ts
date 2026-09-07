/**
 * The identity columns a collection dataset starts with.
 *
 * Named as the ACTIVE DATABASE names them — `subject_id`/`hadm_id` on MIMIC-IV,
 * `person_id`/`visit_occurrence_id` on a stock OMOP CDM — rather than a generic
 * set. Two reasons: the collection then joins to the warehouse without a rename,
 * and whoever fills it recognises the column names from the data they already work
 * with.
 */
import type { SchemaMapping } from '@/types/schema-mapping'

export interface IdentityColumn {
  name: string
  /** Which of the three roles this column plays. */
  role: 'person' | 'visit' | 'visitDetail'
}

/** OMOP CDM names, used when the mapping does not declare a table. */
const FALLBACK: Record<IdentityColumn['role'], string> = {
  person: 'person_id',
  visit: 'visit_occurrence_id',
  visitDetail: 'visit_detail_id',
}

/**
 * The person / visit / visit-detail columns for a schema mapping, in that order.
 *
 * A table the mapping does not declare is skipped rather than invented: a source
 * with no visit_detail table has no unit stays to collect against, and offering
 * the column would produce a field nothing can ever fill.
 */
export function identityColumnsFromMapping(mapping: SchemaMapping | undefined): IdentityColumn[] {
  const out: IdentityColumn[] = [
    { name: mapping?.patientTable?.idColumn || FALLBACK.person, role: 'person' },
  ]
  if (!mapping || mapping.visitTable) {
    out.push({ name: mapping?.visitTable?.idColumn || FALLBACK.visit, role: 'visit' })
  }
  if (!mapping || mapping.visitDetailTable) {
    out.push({ name: mapping?.visitDetailTable?.idColumn || FALLBACK.visitDetail, role: 'visitDetail' })
  }
  return out
}
