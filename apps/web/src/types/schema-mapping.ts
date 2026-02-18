/**
 * Schema preset identifier.
 * Built-in presets use fixed IDs; custom presets use free-form string IDs (UUID or slug).
 */
export type SchemaPresetId = 'omop-5.4' | 'omop-5.3' | 'mimic-iii' | 'none' | (string & {})

/**
 * Mapping that tells the app how to interpret a database schema.
 * Stored per DataSource. Designed to work across OMOP, MIMIC-III, CoDOC, eHOP,
 * and any other clinical data model.
 */
export interface SchemaMapping {
  presetId: SchemaPresetId
  presetLabel: string

  patientTable?: {
    table: string
    idColumn: string
    birthDateColumn?: string
    birthYearColumn?: string
    genderColumn?: string
  }

  visitTable?: {
    table: string
    idColumn: string
    patientIdColumn: string
    startDateColumn: string
    endDateColumn?: string
  }

  /**
   * Optional note/text table: clinical documents (discharge summaries, progress notes, etc.).
   * OMOP CDM: note. MIMIC-III: noteevents.
   */
  noteTable?: {
    table: string
    idColumn: string
    patientIdColumn: string
    visitIdColumn?: string
    dateColumn: string
    titleColumn?: string
    textColumn: string
    /** Column describing the type/class of note (e.g. note_source_value, category). */
    typeColumn?: string
  }

  /**
   * Optional visit detail table: sub-visits within a hospitalization.
   * OMOP CDM: visit_detail (unit stays within a visit_occurrence).
   * MIMIC-III: icustays / transfers within an admission.
   */
  visitDetailTable?: {
    table: string
    idColumn: string
    visitIdColumn: string
    patientIdColumn: string
    startDateColumn: string
    endDateColumn?: string
    /** Optional care site / unit column (e.g. care_site_id, curr_careunit). */
    unitColumn?: string
  }

  /**
   * Concept dictionaries: table(s) that define the vocabulary/concepts.
   * Single dictionary for most CDMs (OMOP, CoDOC, eHOP),
   * multiple for MIMIC-III (d_items, d_labitems, d_icd_diagnoses...).
   */
  conceptTables?: ConceptDictionary[]

  /**
   * Event tables: clinical data tables referencing the concept dictionary.
   * Key = user-friendly label (e.g. "Measurements", "Lab events", "Clinical data").
   */
  eventTables?: Record<string, EventTable>

  /**
   * Gender value mapping: what values to match in the genderColumn.
   * Works for both concept IDs (OMOP: '8507') and text values (MIMIC: 'M', eHOP: '1').
   * SQL builders always quote these values; DuckDB handles implicit cast for numeric columns.
   */
  genderValues?: {
    male: string
    female: string
    unknown?: string
  }

  /** Known table names for Parquet folder table name extraction. */
  knownTables?: string[]

  /**
   * Optional DDL (CREATE TABLE statements) for this schema.
   * Used to create empty databases from a preset (e.g., empty OMOP target for ETL).
   * The DDL should use DuckDB-compatible SQL syntax.
   */
  ddl?: string
}

/**
 * A concept dictionary: a table that acts as a lookup/reference
 * for clinical concepts (vocabulary, items, thesaurus, etc.)
 */
export interface ConceptDictionary {
  /** Unique key to reference this dictionary from eventTables (e.g. 'concept', 'd_items'). */
  key: string
  /** Table name (concept, d_items, dwh_thesaurus_data, concept). */
  table: string
  /** Primary key column (concept_id, itemid, thesaurus_data_num). */
  idColumn: string
  /** Human-readable name column (concept_name, label, concept_str). */
  nameColumn: string
  /** Optional code column within a vocabulary (concept_code). */
  codeColumn?: string
  /** Optional vocabulary/terminology identifier column (vocabulary_id, dbsource, thesaurus_code, terminology_code). */
  vocabularyColumn?: string
  /**
   * Extra filterable columns specific to this CDM.
   * Key = semantic name, value = actual column name.
   * OMOP: { domain_id: 'domain_id', concept_class_id: 'concept_class_id', standard_concept: 'standard_concept' }
   * MIMIC: { category: 'category' }
   */
  extraColumns?: Record<string, string>
}

/**
 * An event table: a clinical data table containing events/observations
 * that reference a concept dictionary.
 */
export interface EventTable {
  /** Table name (measurement, chartevents, dwh_data, document_data). */
  table: string
  /** Column that references the concept dictionary PK (measurement_concept_id, itemid, thesaurus_data_num). */
  conceptIdColumn: string
  /** Optional second concept ID column for source concepts (OMOP-specific). */
  sourceConceptIdColumn?: string
  /**
   * For composite joins (e.g. eHOP): column in event table matching vocabulary/terminology.
   * Used with conceptCodeColumn for joins like: event.terminology_code = dict.terminology_code AND event.concept_code = dict.concept_code
   */
  conceptVocabularyColumn?: string
  /** For composite joins: column in event table matching concept code. */
  conceptCodeColumn?: string
  /** Numeric value column (value_as_number, valuenum, val_numeric, nb). */
  valueColumn?: string
  /** String/categorical value column (value_as_string, value, val_text). */
  valueStringColumn?: string
  /** Patient FK column. Defaults to patientTable.idColumn name if omitted. */
  patientIdColumn?: string
  /** Event date column (measurement_datetime, charttime, document_date, start_at). */
  dateColumn?: string
  /** Which concept dictionary this event table uses. References ConceptDictionary.key. If omitted, uses the first dictionary. */
  conceptDictionaryKey?: string
}

/**
 * A custom schema preset stored in IndexedDB.
 * Wraps a SchemaMapping with metadata for persistence.
 */
export interface CustomSchemaPreset {
  presetId: string
  mapping: SchemaMapping
  createdAt: string
  updatedAt: string
}
