/**
 * Class contracts: the columns every class relation exposes, whatever the source
 * looks like. A consumer queries `linkr_visit.start_datetime`, never the mapping
 * fields behind it — see docs/planning/schema-classes-plan.md §5.
 *
 * An optional column that the mapping cannot fill is still emitted, as NULL, so a
 * query referencing it always binds; `ClassRelation.mapped` says which ones carry
 * data.
 */

export type ClassName = 'patient' | 'visit' | 'visit_detail' | 'note' | 'concept' | 'event' | 'drug'

export type ColumnKind = 'id' | 'datetime' | 'date' | 'number' | 'text' | 'boolean'

export interface ContractColumn {
  name: string
  required: boolean
  kind: ColumnKind
}

const col = (name: string, kind: ColumnKind, required = false): ContractColumn => ({ name, kind, required })

export const CLASS_CONTRACTS: Record<ClassName, readonly ContractColumn[]> = {
  patient: [
    col('patient_id', 'id', true),
    col('birth_date', 'date'),
    col('birth_year', 'number'),
    col('gender', 'text'),
    col('gender_source_value', 'text'),
    col('death_datetime', 'datetime'),
  ],
  visit: [
    col('visit_id', 'id', true),
    col('patient_id', 'id', true),
    col('start_datetime', 'datetime', true),
    col('end_datetime', 'datetime'),
    col('visit_type', 'text'),
    col('care_site_id', 'id'),
    col('care_site_name', 'text'),
  ],
  visit_detail: [
    col('visit_detail_id', 'id', true),
    col('visit_id', 'id', true),
    col('patient_id', 'id', true),
    col('start_datetime', 'datetime', true),
    col('end_datetime', 'datetime'),
    col('unit_id', 'id'),
    col('unit_name', 'text'),
    col('unit_category', 'text'),
  ],
  note: [
    col('note_id', 'id', true),
    col('patient_id', 'id', true),
    col('visit_id', 'id'),
    col('note_datetime', 'datetime', true),
    col('title', 'text'),
    col('text', 'text', true),
    col('note_type', 'text'),
  ],
  concept: [
    col('concept_id', 'id', true),
    col('concept_terminology', 'text'),
    col('concept_name', 'text', true),
    col('concept_code', 'text'),
    col('terminology_id', 'text'),
    col('terminology_name', 'text'),
    col('category', 'text'),
    col('subcategory', 'text'),
  ],
  event: [
    col('patient_id', 'id', true),
    col('concept_id', 'id', true),
    col('start_datetime', 'datetime', true),
    col('visit_id', 'id'),
    col('visit_detail_id', 'id'),
    col('concept_terminology', 'text'),
    col('concept_code', 'text'),
    col('source_concept_id', 'id'),
    col('concept_name', 'text'),
    col('end_datetime', 'datetime'),
    col('value_number', 'number'),
    col('value_string', 'text'),
    col('unit', 'text'),
    col('unit_concept_id', 'id'),
    col('route', 'text'),
    col('route_concept_id', 'id'),
  ],
  drug: [
    col('patient_id', 'id', true),
    col('concept_id', 'id', true),
    col('start_datetime', 'datetime', true),
    col('drug_kind', 'text', true),
    col('drug_id', 'id'),
    col('visit_id', 'id'),
    col('visit_detail_id', 'id'),
    col('concept_terminology', 'text'),
    col('concept_code', 'text'),
    col('source_concept_id', 'id'),
    col('concept_name', 'text'),
    col('end_datetime', 'datetime'),
    col('quantity', 'number'),
    col('amount_value', 'number'),
    col('amount_unit', 'text'),
    col('rate_value', 'number'),
    col('rate_unit', 'text'),
    col('concentration_value', 'number'),
    col('concentration_unit', 'text'),
    col('duration_value', 'number'),
    col('duration_unit', 'text'),
    col('is_continuous', 'boolean'),
    col('route', 'text'),
    col('route_concept_id', 'id'),
    col('dose_source_value', 'text'),
  ],
}

/** Prefix of every class relation name. Reserved: it keeps a relation from
 *  shadowing a source table (MIMIC has a `patients` table). */
export const RELATION_PREFIX = 'linkr_'
