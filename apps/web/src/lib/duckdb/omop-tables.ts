/**
 * OMOP CDM table definitions (5.3 and 5.4).
 * Used for stats computation and future validation.
 * Ported from v1/R/fct_data_model.R.
 */

/** Clinical data tables (contain patient-level records). */
export const OMOP_CLINICAL_TABLES = [
  'person',
  'observation_period',
  'visit_occurrence',
  'visit_detail',
  'condition_occurrence',
  'drug_exposure',
  'procedure_occurrence',
  'device_exposure',
  'measurement',
  'observation',
  'note',
  'specimen',
  'death',
] as const

/** Era tables (derived from clinical tables). */
export const OMOP_ERA_TABLES = [
  'drug_era',
  'condition_era',
  'dose_era',
] as const

/** Vocabulary/reference tables. */
export const OMOP_VOCABULARY_TABLES = [
  'concept',
  'vocabulary',
  'domain',
  'concept_class',
  'concept_relationship',
  'concept_ancestor',
  'concept_synonym',
  'relationship',
  'drug_strength',
] as const

/** Administrative tables. */
export const OMOP_ADMIN_TABLES = [
  'location',
  'care_site',
  'provider',
  'payer_plan_period',
  'cost',
] as const

/** All known OMOP tables. */
export const ALL_OMOP_TABLES = [
  ...OMOP_CLINICAL_TABLES,
  ...OMOP_ERA_TABLES,
  ...OMOP_VOCABULARY_TABLES,
  ...OMOP_ADMIN_TABLES,
] as const

/** Tables used for counting records in stats (main clinical event tables). */
export const OMOP_STATS_TABLES = [
  'condition_occurrence',
  'drug_exposure',
  'measurement',
  'observation',
  'procedure_occurrence',
  'device_exposure',
] as const
