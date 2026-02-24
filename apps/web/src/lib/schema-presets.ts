import type { SchemaMapping, SchemaPresetId, ErdGroup } from '@/types/schema-mapping'
import { ALL_OMOP_TABLES } from '@/lib/duckdb/omop-tables'
import { OMOP_54_DDL } from '@/lib/schema-ddl/omop-5.4-ddl'
import { MIMIC_III_DDL } from '@/lib/schema-ddl/mimic-iii-ddl'
import { MIMIC_IV_DDL } from '@/lib/schema-ddl/mimic-iv-ddl'

// ---------------------------------------------------------------------------
// OMOP CDM 5.4 — ERD Groups
// ---------------------------------------------------------------------------

const OMOP_ERD_GROUPS: ErdGroup[] = [
  {
    id: 'clinical-data',
    label: 'Clinical Data',
    color: 'blue',
    tables: [
      'person', 'observation_period', 'death', 'visit_occurrence', 'visit_detail',
      'condition_occurrence', 'drug_exposure', 'procedure_occurrence', 'device_exposure',
      'measurement', 'observation', 'note', 'note_nlp', 'episode', 'episode_event',
      'specimen', 'fact_relationship',
    ],
  },
  {
    id: 'health-system',
    label: 'Health System',
    color: 'green',
    tables: ['location', 'care_site', 'provider'],
  },
  {
    id: 'vocabularies',
    label: 'Vocabularies',
    color: 'orange',
    tables: [
      'concept', 'vocabulary', 'domain', 'concept_class', 'concept_synonym',
      'concept_relationship', 'relationship', 'concept_ancestor',
      'source_to_concept_map', 'drug_strength',
    ],
  },
  {
    id: 'health-economics',
    label: 'Health Economics',
    color: 'purple',
    tables: ['cost', 'payer_plan_period'],
  },
  {
    id: 'derived-elements',
    label: 'Derived Elements',
    color: 'teal',
    tables: ['condition_era', 'drug_era', 'dose_era'],
  },
  {
    id: 'results',
    label: 'Results Schema',
    color: 'red',
    tables: ['cohort', 'cohort_definition'],
  },
  {
    id: 'metadata',
    label: 'Metadata',
    color: 'slate',
    tables: ['cdm_source', 'metadata'],
  },
]

// ---------------------------------------------------------------------------
// OMOP CDM 5.4
// ---------------------------------------------------------------------------

const omop54: SchemaMapping = {
  presetId: 'omop-5.4',
  presetLabel: 'OMOP CDM 5.4',
  patientTable: {
    table: 'person',
    idColumn: 'person_id',
    birthDateColumn: 'birth_datetime',
    birthYearColumn: 'year_of_birth',
    genderColumn: 'gender_concept_id',
  },
  deathTable: {
    table: 'death',
    patientIdColumn: 'person_id',
    dateColumn: 'death_datetime',
  },
  visitTable: {
    table: 'visit_occurrence',
    idColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'visit_start_datetime',
    endDateColumn: 'visit_end_datetime',
    typeColumn: 'visit_source_value',
    careSiteColumn: 'care_site_id',
    careSiteNameTable: 'care_site',
    careSiteNameIdColumn: 'care_site_id',
    careSiteNameColumn: 'care_site_name',
  },
  noteTable: {
    table: 'note',
    idColumn: 'note_id',
    patientIdColumn: 'person_id',
    visitIdColumn: 'visit_occurrence_id',
    dateColumn: 'note_datetime',
    titleColumn: 'note_title',
    textColumn: 'note_text',
    typeColumn: 'note_source_value',
  },
  visitDetailTable: {
    table: 'visit_detail',
    idColumn: 'visit_detail_id',
    visitIdColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'visit_detail_start_datetime',
    endDateColumn: 'visit_detail_end_datetime',
    unitColumn: 'care_site_id',
    unitNameTable: 'care_site',
    unitNameIdColumn: 'care_site_id',
    unitNameColumn: 'care_site_name',
  },
  conceptTables: [
    {
      key: 'concept',
      table: 'concept',
      idColumn: 'concept_id',
      nameColumn: 'concept_name',
      codeColumn: 'concept_code',
      terminologyIdColumn: 'vocabulary_id',
      categoryColumn: 'domain_id',
      subcategoryColumn: 'concept_class_id',
      extraColumns: {
        standard_concept: 'standard_concept',
      },
    },
  ],
  eventTables: {
    Measurement: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      sourceConceptIdColumn: 'measurement_source_concept_id',
      valueColumn: 'value_as_number',
      valueStringColumn: 'value_as_string',
      patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime',
    },
    Condition: {
      table: 'condition_occurrence',
      conceptIdColumn: 'condition_concept_id',
      sourceConceptIdColumn: 'condition_source_concept_id',
      patientIdColumn: 'person_id',
      dateColumn: 'condition_start_datetime',
    },
    Drug: {
      table: 'drug_exposure',
      conceptIdColumn: 'drug_concept_id',
      sourceConceptIdColumn: 'drug_source_concept_id',
      patientIdColumn: 'person_id',
      dateColumn: 'drug_exposure_start_datetime',
    },
    Procedure: {
      table: 'procedure_occurrence',
      conceptIdColumn: 'procedure_concept_id',
      sourceConceptIdColumn: 'procedure_source_concept_id',
      patientIdColumn: 'person_id',
      dateColumn: 'procedure_datetime',
    },
    Observation: {
      table: 'observation',
      conceptIdColumn: 'observation_concept_id',
      sourceConceptIdColumn: 'observation_source_concept_id',
      valueColumn: 'value_as_number',
      valueStringColumn: 'value_as_string',
      patientIdColumn: 'person_id',
      dateColumn: 'observation_datetime',
    },
  },
  genderValues: {
    male: '8507',
    female: '8532',
    unknown: '0',
  },
  knownTables: [...ALL_OMOP_TABLES],
  ddl: OMOP_54_DDL,
  erdGroups: OMOP_ERD_GROUPS,
}

// ---------------------------------------------------------------------------
// OMOP CDM 5.3 (date columns without _datetime)
// ---------------------------------------------------------------------------

const omop53: SchemaMapping = {
  ...omop54,
  presetId: 'omop-5.3',
  presetLabel: 'OMOP CDM 5.3',
  deathTable: {
    table: 'death',
    patientIdColumn: 'person_id',
    dateColumn: 'death_date',
  },
  noteTable: {
    ...omop54.noteTable!,
    dateColumn: 'note_date',
  },
  patientTable: {
    ...omop54.patientTable!,
    birthDateColumn: undefined,
  },
  visitTable: {
    ...omop54.visitTable!,
    startDateColumn: 'visit_start_date',
    endDateColumn: 'visit_end_date',
  },
  visitDetailTable: {
    ...omop54.visitDetailTable!,
    startDateColumn: 'visit_detail_start_date',
    endDateColumn: 'visit_detail_end_date',
  },
  eventTables: {
    Measurement: {
      ...omop54.eventTables!.Measurement,
      dateColumn: 'measurement_date',
    },
    Condition: {
      ...omop54.eventTables!.Condition,
      dateColumn: 'condition_start_date',
    },
    Drug: {
      ...omop54.eventTables!.Drug,
      dateColumn: 'drug_exposure_start_date',
    },
    Procedure: {
      ...omop54.eventTables!.Procedure,
      dateColumn: 'procedure_date',
    },
    Observation: {
      ...omop54.eventTables!.Observation,
      dateColumn: 'observation_date',
    },
  },
}

// ---------------------------------------------------------------------------
// MIMIC-III
// ---------------------------------------------------------------------------

const MIMIC_III_TABLES = [
  'patients', 'admissions', 'icustays', 'transfers', 'services',
  'chartevents', 'labevents', 'noteevents', 'datetimeevents',
  'diagnoses_icd', 'procedures_icd', 'cptevents',
  'prescriptions', 'inputevents_cv', 'inputevents_mv', 'outputevents',
  'microbiologyevents', 'drgcodes',
  'd_items', 'd_labitems', 'd_icd_diagnoses', 'd_icd_procedures', 'd_cpt',
  'caregivers', 'callout',
]

const mimicIII: SchemaMapping = {
  presetId: 'mimic-iii',
  presetLabel: 'MIMIC-III',
  patientTable: {
    table: 'patients',
    idColumn: 'subject_id',
    birthDateColumn: 'dob',
    genderColumn: 'gender',
    deathDateColumn: 'dod',
  },
  visitTable: {
    table: 'admissions',
    idColumn: 'hadm_id',
    patientIdColumn: 'subject_id',
    startDateColumn: 'admittime',
    endDateColumn: 'dischtime',
    typeColumn: 'admission_type',
  },
  noteTable: {
    table: 'noteevents',
    idColumn: 'row_id',
    patientIdColumn: 'subject_id',
    visitIdColumn: 'hadm_id',
    dateColumn: 'chartdate',
    titleColumn: 'description',
    textColumn: 'text',
    typeColumn: 'category',
  },
  visitDetailTable: {
    table: 'icustays',
    idColumn: 'icustay_id',
    visitIdColumn: 'hadm_id',
    patientIdColumn: 'subject_id',
    startDateColumn: 'intime',
    endDateColumn: 'outtime',
    unitColumn: 'first_careunit',
  },
  conceptTables: [
    {
      key: 'd_items',
      table: 'd_items',
      idColumn: 'itemid',
      nameColumn: 'label',
      terminologyIdColumn: 'dbsource',
      categoryColumn: 'category',
    },
    {
      key: 'd_labitems',
      table: 'd_labitems',
      idColumn: 'itemid',
      nameColumn: 'label',
      categoryColumn: 'category',
    },
  ],
  eventTables: {
    'Chart events': {
      table: 'chartevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'valuenum',
      valueStringColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      conceptDictionaryKey: 'd_items',
    },
    'Lab events': {
      table: 'labevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'valuenum',
      valueStringColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      conceptDictionaryKey: 'd_labitems',
    },
  },
  genderValues: {
    male: 'M',
    female: 'F',
  },
  knownTables: MIMIC_III_TABLES,
  ddl: MIMIC_III_DDL,
}

// ---------------------------------------------------------------------------
// MIMIC-IV — ERD Groups
// ---------------------------------------------------------------------------

const MIMIC_IV_ERD_GROUPS: ErdGroup[] = [
  {
    id: 'hosp',
    label: 'Hospital (hosp)',
    color: 'blue',
    tables: [
      'patients', 'admissions', 'transfers', 'services',
      'diagnoses_icd', 'procedures_icd', 'hcpcsevents', 'drgcodes',
      'labevents', 'microbiologyevents',
      'emar', 'emar_detail', 'pharmacy', 'poe', 'poe_detail',
      'prescriptions', 'omr', 'provider', 'discharge',
    ],
  },
  {
    id: 'icu',
    label: 'ICU (icu)',
    color: 'green',
    tables: [
      'icustays', 'chartevents', 'datetimeevents',
      'inputevents', 'outputevents', 'ingredientevents',
      'procedureevents', 'caregiver',
    ],
  },
  {
    id: 'dictionaries',
    label: 'Dictionaries',
    color: 'orange',
    tables: ['d_items', 'd_labitems', 'd_hcpcs', 'd_icd_diagnoses', 'd_icd_procedures'],
  },
]

// MIMIC-IV
// ---------------------------------------------------------------------------

const MIMIC_IV_TABLES = [
  'patients', 'admissions', 'icustays', 'transfers', 'services',
  'chartevents', 'labevents', 'datetimeevents',
  'diagnoses_icd', 'procedures_icd', 'hcpcsevents',
  'prescriptions', 'inputevents', 'outputevents', 'ingredientevents',
  'procedureevents', 'microbiologyevents',
  'emar', 'emar_detail', 'pharmacy', 'poe', 'poe_detail',
  'drgcodes', 'omr', 'provider', 'caregiver',
  'd_items', 'd_labitems', 'd_hcpcs', 'd_icd_diagnoses', 'd_icd_procedures',
  'discharge', 'demo_subject_id',
]

const mimicIV: SchemaMapping = {
  presetId: 'mimic-iv',
  presetLabel: 'MIMIC-IV',
  patientTable: {
    table: 'patients',
    idColumn: 'subject_id',
    genderColumn: 'gender',
    deathDateColumn: 'dod',
  },
  visitTable: {
    table: 'admissions',
    idColumn: 'hadm_id',
    patientIdColumn: 'subject_id',
    startDateColumn: 'admittime',
    endDateColumn: 'dischtime',
    typeColumn: 'admission_type',
  },
  noteTable: {
    table: 'discharge',
    idColumn: 'note_id',
    patientIdColumn: 'subject_id',
    visitIdColumn: 'hadm_id',
    dateColumn: 'charttime',
    titleColumn: 'note_type',
    textColumn: 'text',
    typeColumn: 'note_type',
  },
  visitDetailTable: {
    table: 'transfers',
    idColumn: 'transfer_id',
    visitIdColumn: 'hadm_id',
    patientIdColumn: 'subject_id',
    startDateColumn: 'intime',
    endDateColumn: 'outtime',
    unitColumn: 'careunit',
  },
  conceptTables: [
    {
      key: 'd_items',
      table: 'd_items',
      idColumn: 'itemid',
      nameColumn: 'label',
      categoryColumn: 'category',
    },
    {
      key: 'd_labitems',
      table: 'd_labitems',
      idColumn: 'itemid',
      nameColumn: 'label',
      categoryColumn: 'category',
    },
    // Note: d_hcpcs, d_icd_diagnoses, d_icd_procedures are in knownTables (ERD, stats)
    // but NOT in conceptTables — ICD/HCPCS codes map to OMOP via ATHENA vocabularies
    // directly in ETL scripts, not through the STCM/mapping editor.
  ],
  eventTables: {
    'Chart events': {
      table: 'chartevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'valuenum',
      valueStringColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      conceptDictionaryKey: 'd_items',
    },
    'Lab events': {
      table: 'labevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'valuenum',
      valueStringColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      conceptDictionaryKey: 'd_labitems',
    },
    'Input events': {
      table: 'inputevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'amount',
      patientIdColumn: 'subject_id',
      dateColumn: 'starttime',
      conceptDictionaryKey: 'd_items',
    },
    'Output events': {
      table: 'outputevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'charttime',
      conceptDictionaryKey: 'd_items',
    },
    'Procedure events': {
      table: 'procedureevents',
      conceptIdColumn: 'itemid',
      valueColumn: 'value',
      patientIdColumn: 'subject_id',
      dateColumn: 'starttime',
      conceptDictionaryKey: 'd_items',
    },
  },
  genderValues: {
    male: 'M',
    female: 'F',
  },
  knownTables: MIMIC_IV_TABLES,
  ddl: MIMIC_IV_DDL,
  erdGroups: MIMIC_IV_ERD_GROUPS,
}

// ---------------------------------------------------------------------------
// Built-in presets registry
// ---------------------------------------------------------------------------

/** Built-in preset IDs in display order. */
export const BUILTIN_PRESET_IDS: SchemaPresetId[] = ['omop-5.4', 'omop-5.3', 'mimic-iv', 'mimic-iii']

/** Built-in presets keyed by ID. */
export const SCHEMA_PRESETS: Record<string, SchemaMapping> = {
  'omop-5.4': omop54,
  'omop-5.3': omop53,
  'mimic-iv': mimicIV,
  'mimic-iii': mimicIII,
}

/** Get a built-in preset by ID. Returns undefined if not found. */
export function getSchemaPreset(presetId: SchemaPresetId): SchemaMapping | undefined {
  return SCHEMA_PRESETS[presetId]
}
