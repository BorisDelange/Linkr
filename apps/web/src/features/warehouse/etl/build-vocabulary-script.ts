/**
 * Build the full vocabulary SQL script from concept mappings.
 * Extracted so it can be used both by EtlVocabularyTab (UI) and the seed loader (startup).
 */
import type { ConceptMapping } from '@/types'
import { escSql as esc } from '@/lib/format-helpers'
import {
  assignSourceConceptIds,
  SOURCE_CONCEPT_ID_BASE,
} from '@/lib/concept-mapping/source-concept-ids'
import { SOURCE_DOMAIN_COLUMN, STCM_COLUMNS } from '@/lib/concept-mapping/stcm-export'
import {
  CONCEPT_COLUMNS,
  CONCEPT_RELATIONSHIP_COLUMNS,
} from '@/lib/concept-mapping/ccr-export'
import {
  mappingExportPath,
  MAPPING_REF_PREFIX,
  STCM_EXPORT,
  CONCEPT_EXPORT,
  CONCEPT_RELATIONSHIP_EXPORT,
} from '@/lib/duckdb/mapping-source'

/**
 * Which vocabulary representation the generated script fills.
 *
 * - `ccr` — CONCEPT + CONCEPT_RELATIONSHIP only, the OMOP v5 way and the target
 *   state. Local codes become 2-billion concepts related by 'Maps to'.
 * - `ccr+stcm` — the same, plus source_to_concept_map DERIVED from those tables,
 *   for pipelines whose own scripts still join it.
 * - `stcm` — the legacy shape, kept byte-identical so existing pipelines
 *   regenerate unchanged.
 *
 * STCM is never built alongside C/CR, always from it: when the table finally goes
 * away, one SQL block and one enum value go with it.
 */
export type VocabularyMode = 'ccr' | 'ccr+stcm' | 'stcm'

/**
 * The generated script addresses the ATHENA reference by ROLE, not by its
 * `ds_<uuid>` schema: that schema is instance-local, so a hard-coded one broke
 * the script as soon as the pipeline was exported and reimported elsewhere.
 * Resolved at run time — see lib/duckdb/role-prefix.
 */
export const VOCAB_ROLE_PREFIX = 'vocab'

/**
 * The OMOP tables the script writes are on the pipeline target. They are
 * qualified too: left bare they would resolve through the Run dropdown's
 * search_path, so pointing it at another database would make a DELETE hit the
 * wrong one — destructive on the ATHENA reference.
 */
const TARGET = 'target'

/**
 * Tables are emptied with TRUNCATE, not DELETE.
 *
 * Every clear here wipes a whole table, and DELETE journals row by row — on
 * concept / concept_relationship, which run to millions of rows, that dominated
 * the script's runtime for no benefit. Verified against DuckDB on an attached
 * database.
 */

/**
 * OMOP columns of the ATHENA tables copied wholesale into the target, in DDL
 * order. Needed because `SELECT *` copies positionally, and ATHENA's CSV-derived
 * parquet often types the date columns as BIGINT (`20100401`) rather than DATE —
 * DuckDB then refuses the implicit BIGINT -> DATE cast on INSERT.
 */
const ATHENA_COLUMNS: Record<string, string[]> = {
  concept: [
    'concept_id', 'concept_name', 'domain_id', 'vocabulary_id', 'concept_class_id',
    'standard_concept', 'concept_code', 'valid_start_date', 'valid_end_date', 'invalid_reason',
  ],
  concept_relationship: [
    'concept_id_1', 'concept_id_2', 'relationship_id',
    'valid_start_date', 'valid_end_date', 'invalid_reason',
  ],
  drug_strength: [
    'drug_concept_id', 'ingredient_concept_id',
    'amount_value', 'amount_unit_concept_id',
    'numerator_value', 'numerator_unit_concept_id',
    'denominator_value', 'denominator_unit_concept_id',
    'box_size', 'valid_start_date', 'valid_end_date', 'invalid_reason',
  ],
}

/** OMOP date columns that ATHENA may deliver as a YYYYMMDD integer. */
const DATE_COLUMNS = new Set(['valid_start_date', 'valid_end_date'])

/**
 * Explicit select list for an ATHENA table, normalising the date columns.
 *
 * `try_strptime` returns NULL instead of raising when the text is not YYYYMMDD,
 * so the COALESCE falls through to a plain cast: a vocabulary exported with real
 * DATE columns works from the same script as one exported with integers.
 */
export function athenaSelectList(table: string, alias: string): string {
  const cols = ATHENA_COLUMNS[table]
  if (!cols) return `${alias}.*`
  const asDate = (c: string) =>
    `COALESCE(try_strptime(CAST(${alias}.${c} AS VARCHAR), '%Y%m%d')::DATE,`
    + ` TRY_CAST(${alias}.${c} AS DATE)) AS ${c}`
  return cols.map((c) => (DATE_COLUMNS.has(c) ? asDate(c) : `${alias}.${c}`)).join(', ')
}

/** Hard-coded concept IDs used across ETL scripts. */
export const ETL_FIXED_CONCEPT_IDS = [
  0,      // No matching concept
  8507,   // Male
  8532,   // Female
  32817,  // EHR (type concept)
  32821,  // EHR billing record
  32828,  // EHR episode record
  32838,  // EHR prescription
  32856,  // Lab (type concept)
  46235654, // Primary insurance
  40766231, // Marital status
  40758030, // Preferred language
  4296248,  // Cost containment (DRG)
]

/**
 * Tables a vocabulary reference always provides: the mapping UI needs them, so
 * a reference that carries nothing else still satisfies these. Anything beyond
 * this set has to be probed for (see ATHENA_KNOWN_TABLES in ConceptSetsTab for
 * what an ATHENA import actually keeps).
 */
export const VOCAB_CORE_TABLES = [
  'concept', 'concept_ancestor', 'concept_relationship', 'concept_synonym',
] as const

/**
 * drug_strength columns pointing at concept, in DDL order. The ingredient and
 * unit columns matter as much as drug_concept_id: every one of them is a
 * foreign key to concept, so a row survives the prune only if all five targets
 * do.
 */
const DRUG_STRENGTH_CONCEPT_COLUMNS = [
  'drug_concept_id', 'ingredient_concept_id', 'amount_unit_concept_id',
  'numerator_unit_concept_id', 'denominator_unit_concept_id',
] as const

/**
 * OMOP vocabulary tables. Excluded when scanning for used concepts: they
 * reference concepts to describe them, so counting those references would keep
 * every concept alive and prune nothing.
 */
const OMOP_VOCAB_TABLES = [
  'concept', 'concept_ancestor', 'concept_class', 'concept_relationship',
  'concept_synonym', 'domain', 'drug_strength', 'relationship', 'vocabulary',
  'source_to_concept_map',
]

/**
 * Build the script that cuts the vocabulary down to what the CDM actually uses.
 *
 * Runs AFTER the CDM tables are populated: it reads them to find out which
 * concepts were written. The vocabulary is copied whole beforehand, because a
 * 'Maps to' can land on any vocabulary and leaving one out writes CDM rows whose
 * concept_id is missing from the concept table. Copy everything, then prune.
 *
 * The used-concept scan reads duckdb_columns() rather than a fixed column list:
 * every `*_concept_id` of every clinical table counts, including the
 * `*_source_concept_id` ones, and the set differs per CDM version. On MIMIC-IV
 * that is 99 columns over 28 tables — a hand-written list had missed half.
 *
 * `(database_name = 'target' OR schema_name = 'target')` covers both modes: the
 * target is an ATTACHed database on the server and a schema in the browser
 * engine.
 *
 * Kept: the used concepts, their ancestors (so hierarchical queries still
 * resolve), and everything they relate to.
 *
 * Aborts when the scan finds no referenced concept: the DELETEs keep what the
 * scan found, so an empty scan would empty the vocabulary rather than prune
 * nothing.
 */
export function buildPruneVocabularyScript(): string {
  const parts: string[] = []
  const T = TARGET
  const vocabList = OMOP_VOCAB_TABLES.map((t) => `'${t}'`).join(', ')

  parts.push('-- Auto-generated by the Vocabulary tab')
  parts.push('--')
  parts.push('-- Reduce the OMOP vocabulary to the concepts the CDM tables reference.')
  parts.push('-- Run after the CDM tables are populated, before any cleanup step.')
  parts.push('--')
  parts.push('-- Disable this script while mappings are still being added: a concept')
  parts.push('-- dropped here has to be reloaded from the reference before it can be')
  parts.push('-- mapped again.')
  parts.push('--')
  parts.push('-- It stops with an error if no CDM table references a concept, rather')
  parts.push('-- than pruning everything.')
  parts.push('')

  // 1. Concepts the CDM actually references.
  parts.push('-- =================================================================')
  parts.push('-- 1. Concepts referenced by the CDM tables')
  parts.push('-- =================================================================')
  parts.push('')
  // The column list is only known at run time, so the scan is built as SQL text
  // and executed with query(). It goes through a session variable because
  // query() rejects a subquery argument ("Table function cannot contain
  // subqueries"). UNNEST turns one row per table into one row per concept id.
  parts.push(`SET VARIABLE linkr_used_concepts_sql = (`)
  parts.push('    SELECT COALESCE(')
  parts.push('        string_agg(')
  parts.push(`            'SELECT UNNEST([' || cols || ']) AS concept_id FROM ${T}."' || table_name || '"',`)
  parts.push("            ' UNION ALL '")
  parts.push('        ),')
  parts.push("        'SELECT NULL::BIGINT AS concept_id WHERE FALSE'")
  parts.push('    )')
  parts.push('    FROM (')
  parts.push(`        SELECT table_name, string_agg('"' || column_name || '"', ', ') AS cols`)
  parts.push('        FROM duckdb_columns()')
  parts.push(`        WHERE (database_name = '${T}' OR schema_name = '${T}')`)
  // SIMILAR TO rather than LIKE ... ESCAPE '\': the pipeline splits a script on
  // top-level semicolons, and its tokenizer reads the backslash in ESCAPE '\'
  // as escaping the closing quote — the string never ends and the whole script
  // runs as one statement.
  parts.push("          AND column_name SIMILAR TO '.*_concept_id'")
  parts.push(`          AND table_name NOT IN (${vocabList})`)
  parts.push("          AND table_name NOT SIMILAR TO 'tmp_.*'")
  parts.push('        GROUP BY table_name')
  parts.push('    )')
  parts.push(');')
  parts.push('')
  parts.push(`CREATE OR REPLACE TABLE ${T}.tmp_used_concepts AS`)
  parts.push(`SELECT DISTINCT concept_id`)
  parts.push(`FROM query(getvariable('linkr_used_concepts_sql'))`)
  // 0 is excluded from the *used* set, not from the kept one: it stands for "no
  // matching concept", so expanding its ancestors and relations in step 2 would
  // pull in a closure that means nothing. Step 2 adds it back as a fixed concept.
  parts.push('WHERE concept_id IS NOT NULL AND concept_id <> 0;')
  parts.push('')
  // Stop rather than delete everything. Every DELETE below is
  // `NOT IN (SELECT ... FROM tmp_keep_concepts)`, so an empty scan does not prune
  // "nothing" — it prunes the WHOLE vocabulary, silently and with no error. That
  // is what an empty scan means in practice: the script ran before the CDM tables
  // were populated (wrong order, or a run that stopped early). Recovering means
  // re-copying the vocabulary from the reference, so fail loudly instead.
  parts.push('-- Refuse to run on an empty scan: see the note on the DELETEs below.')
  parts.push(`SELECT CASE WHEN (SELECT count(*) FROM ${T}.tmp_used_concepts) = 0`)
  parts.push("    THEN error('No concept is referenced by the CDM tables. "
    + "Run this script AFTER the tables are populated: pruning now would delete "
    + "the entire vocabulary.')")
  parts.push('    END;')
  parts.push('')

  // 2. Closure: ancestors + related concepts.
  parts.push('-- =================================================================')
  parts.push('-- 2. Concepts to keep: used, their ancestors, and their relations')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`CREATE OR REPLACE TABLE ${T}.tmp_keep_concepts AS`)
  parts.push('SELECT DISTINCT concept_id FROM (')
  parts.push(`    SELECT concept_id FROM ${T}.tmp_used_concepts`)
  parts.push('    UNION')
  // The concepts the ETL writes as literals. 0 above all: every unmapped row
  // carries concept_id = 0, and no *_concept_id column points at the others'
  // rows either (they sit in gender_concept_id, *_type_concept_id and the like,
  // which the step 1 scan does read - but a CDM with no death row, say, never
  // mentions 32817). Pruning them leaves those columns pointing at a concept
  // that is gone: a broken foreign key on every unmapped fact.
  parts.push('    -- Concepts the ETL scripts reference as literals.')
  parts.push(`    SELECT UNNEST([${ETL_FIXED_CONCEPT_IDS.join(', ')}]) AS concept_id`)
  parts.push('    UNION')
  parts.push('    -- Ancestors, so a query on a parent concept still finds its descendants.')
  parts.push('    SELECT a.ancestor_concept_id')
  parts.push(`    FROM ${T}.concept_ancestor a`)
  parts.push(`    INNER JOIN ${T}.tmp_used_concepts u ON u.concept_id = a.descendant_concept_id`)
  parts.push('    UNION')
  parts.push('    -- Everything a used concept relates to, source mappings included.')
  parts.push('    SELECT cr.concept_id_2')
  parts.push(`    FROM ${T}.concept_relationship cr`)
  parts.push(`    INNER JOIN ${T}.tmp_used_concepts u ON u.concept_id = cr.concept_id_1`)
  // Without this the drugs that survive lose their strength rows: the
  // ingredient and unit concepts drug_strength points at are described by that
  // table, never referenced by a CDM column, so the scan in step 1 never sees
  // them and the DELETE below would drop every row.
  parts.push('    UNION')
  parts.push('    -- Ingredients and units of the drugs in use, so their drug_strength rows survive.')
  parts.push(`    SELECT UNNEST([${DRUG_STRENGTH_CONCEPT_COLUMNS.map((c) => `ds.${c}`).join(', ')}]) AS concept_id`)
  parts.push(`    FROM ${T}.drug_strength ds`)
  parts.push(`    INNER JOIN ${T}.tmp_used_concepts u ON u.concept_id = ds.drug_concept_id`)
  parts.push(')')
  // The unit columns of drug_strength are nullable, and one NULL in this table
  // makes every `NOT IN (SELECT ... FROM tmp_keep_concepts)` below evaluate to
  // NULL: no row is ever deleted and the prune silently does nothing.
  parts.push('WHERE concept_id IS NOT NULL;')
  parts.push('')

  // 3. Prune.
  parts.push('-- =================================================================')
  parts.push('-- 3. Prune the vocabulary tables')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`DELETE FROM ${T}.concept`)
  parts.push(`WHERE concept_id NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts);`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.concept_relationship`)
  parts.push(`WHERE concept_id_1 NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts)`)
  parts.push(`   OR concept_id_2 NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts);`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.concept_ancestor`)
  parts.push(`WHERE ancestor_concept_id NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts)`)
  parts.push(`   OR descendant_concept_id NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts);`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.concept_synonym`)
  parts.push(`WHERE concept_id NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts);`)
  parts.push('')
  // Every concept column has to hold, not just the drug: the others are foreign
  // keys to concept too, so a row kept on drug_concept_id alone would point at
  // an ingredient or unit this same script just deleted. The unit columns are
  // nullable — a NULL breaks no key, hence the IS NOT NULL guard on each.
  parts.push(`DELETE FROM ${T}.drug_strength`)
  parts.push(DRUG_STRENGTH_CONCEPT_COLUMNS.map((col, i) =>
    `${i === 0 ? 'WHERE' : '   OR'} (${col} IS NOT NULL`
    + ` AND ${col} NOT IN (SELECT concept_id FROM ${T}.tmp_keep_concepts))`,
  ).join('\n') + ';')
  parts.push('')

  // 4. Metadata tables follow whatever is left.
  parts.push('-- =================================================================')
  parts.push('-- 4. Metadata tables, realigned on what is left')
  parts.push('-- =================================================================')
  parts.push('')
  // 'None' owns no concept of its own: it is the row that carries the
  // vocabulary bundle release, which cdm_source reads. Pruning on concept
  // ownership alone would delete it and lose that provenance.
  parts.push(`DELETE FROM ${T}.vocabulary`)
  parts.push(`WHERE vocabulary_id NOT IN (SELECT DISTINCT vocabulary_id FROM ${T}.concept)`)
  parts.push(`  AND vocabulary_id <> 'None';`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.domain`)
  parts.push(`WHERE domain_id NOT IN (SELECT DISTINCT domain_id FROM ${T}.concept);`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.concept_class`)
  parts.push(`WHERE concept_class_id NOT IN (SELECT DISTINCT concept_class_id FROM ${T}.concept);`)
  parts.push('')
  parts.push(`DELETE FROM ${T}.relationship`)
  parts.push(`WHERE relationship_id NOT IN (SELECT DISTINCT relationship_id FROM ${T}.concept_relationship);`)
  parts.push('')
  parts.push(`DROP TABLE IF EXISTS ${T}.tmp_used_concepts;`)
  parts.push(`DROP TABLE IF EXISTS ${T}.tmp_keep_concepts;`)
  parts.push('')

  return parts.join('\n')
}

/**
 * Build the full vocabulary SQL script that:
 * 1. Populates source_to_concept_map from mappings
 * 2. Copies ATHENA concepts into local concept table
 * 3. Generates source concepts (concept_id > 2B)
 * 4. Copies concept_relationship, concept_ancestor
 * 5. Copies whichever vocabulary metadata tables are available
 *
 * `availableTables` lists what the vocabulary reference holds. Parts that would
 * read a missing table are skipped with a comment rather than emitted and left
 * to fail at run time — a typical ATHENA import carries only the core tables.
 */
export function buildVocabularyScript(
  mappings: ConceptMapping[],
  vocabSchema = VOCAB_ROLE_PREFIX,
  availableTables?: Iterable<string>,
  mode: VocabularyMode = 'ccr',
): string {
  return buildVocabularyScriptWithIds(mappings, vocabSchema, availableTables, undefined, mode).sql
}

/**
 * Same script, plus the source-concept ids that still have to be written back to
 * the mapping project. The Vocabulary tab uses this form; `buildVocabularyScript`
 * stays available for callers that only need the SQL (the seed loader).
 */
export function buildVocabularyScriptWithIds(
  mappings: ConceptMapping[],
  vocabSchema = VOCAB_ROLE_PREFIX,
  availableTables?: Iterable<string>,
  /**
   * Every mapping of the project, when `mappings` is a filtered subset. Ids are
   * allocated against the whole project so a mapping currently excluded by the
   * status filter cannot later be handed an id that is already in use.
   */
  allProjectMappings?: ConceptMapping[],
  mode: VocabularyMode = 'ccr',
): { sql: string; idsToPersist: Map<string, number> } {
  const vs = vocabSchema
  const parts: string[] = []
  const sourceIds = assignSourceConceptIds(allProjectMappings ?? mappings)
  const available = availableTables
    ? new Set([...availableTables].map((t) => t.toLowerCase()))
    : new Set<string>(VOCAB_CORE_TABLES)
  const has = (table: string) => available.has(table)
  const usesCcr = mode !== 'stcm'

  parts.push('-- Auto-generated by Vocabulary tab')
  parts.push(`-- Vocabulary reference: ${vs}`)
  if (usesCcr) {
    parts.push('--')
    parts.push('-- Mappings are carried as CONCEPT + CONCEPT_RELATIONSHIP (OMOP v5).')
    if (mode === 'ccr+stcm') {
      parts.push('-- source_to_concept_map is then DERIVED from those tables (PART 6).')
    }
  }
  parts.push('')

  // =========================================================================
  // PART 1: source_to_concept_map
  // =========================================================================
  if (!usesCcr) {
    parts.push('-- =================================================================')
    parts.push('-- PART 1: source_to_concept_map')
    parts.push('-- =================================================================')
    parts.push('')
    parts.push(`TRUNCATE ${TARGET}.source_to_concept_map;`)

    if (mappings.length > 0) {
      // The rows are NOT written here. A mapping project is often a private
      // dictionary, and inlining every source code as literal VALUES put it into a
      // versioned file. They live in a gitignored CSV beside the pipeline, which
      // the Vocabulary tab regenerates with this script and the runner supplies at
      // execution time — see lib/duckdb/mapping-source.
      parts.push('')
      parts.push(`-- ${mappings.length} mapping${mappings.length !== 1 ? 's' : ''} from the mapping project, read from`)
      parts.push(`-- ${mappingExportPath(STCM_EXPORT)} (regenerated with this script, not versioned).`)
      parts.push(`INSERT INTO ${TARGET}.source_to_concept_map (${STCM_COLUMNS.join(', ')})`)
      parts.push(`SELECT ${STCM_COLUMNS.join(', ')}`)
      parts.push(`FROM read_csv('${MAPPING_REF_PREFIX}${STCM_EXPORT}', header = true);`)
    }
  }

  // =========================================================================
  // PART 2: concept table
  // =========================================================================
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 2: concept table')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`TRUNCATE ${TARGET}.concept;`)

  // 2a. Target concepts the mappings point at
  parts.push('')
  if (usesCcr) {
    parts.push('-- 2a. Target concepts referenced by the mappings')
    parts.push(`INSERT INTO ${TARGET}.concept`)
    parts.push(`SELECT ${athenaSelectList('concept', 'c')}`)
    parts.push(`FROM ${vs}.concept c`)
    if (mappings.length > 0) {
      parts.push(`WHERE c.concept_id IN (`)
      parts.push(`    SELECT DISTINCT concept_id_2`)
      parts.push(`    FROM read_csv('${MAPPING_REF_PREFIX}${CONCEPT_RELATIONSHIP_EXPORT}', header = true)`)
      parts.push(`    WHERE relationship_id = 'Maps to'`)
      parts.push(`);`)
    } else {
      // No mappings: no targets to pull in. A bare INSERT would copy the whole
      // reference here, which 2b does deliberately a few lines below.
      parts.push(`WHERE FALSE;`)
    }
  } else {
    parts.push('-- 2a. Target concepts referenced by source_to_concept_map')
    parts.push(`INSERT INTO ${TARGET}.concept`)
    parts.push(`SELECT ${athenaSelectList('concept', 'c')}`)
    parts.push(`FROM ${vs}.concept c`)
    parts.push(`WHERE c.concept_id IN (`)
    parts.push(`    SELECT DISTINCT target_concept_id`)
    parts.push(`    FROM ${TARGET}.source_to_concept_map`)
    parts.push(`    WHERE target_concept_id IS NOT NULL AND target_concept_id != 0`)
    parts.push(`);`)
  }

  // 2b. Every concept the reference holds
  parts.push('')
  parts.push('-- 2b. Every concept from the vocabulary reference')
  parts.push('--')
  parts.push('-- Copied without a vocabulary filter on purpose. A \'Maps to\' can leave')
  parts.push('-- whichever vocabularies the ETL reads directly - an ICD code resolving to')
  parts.push('-- OMOP Extension, an NDC to CVX - and any vocabulary left out produces CDM')
  parts.push('-- rows whose concept_id is absent from the concept table: a broken foreign')
  parts.push('-- key rather than a missing row. Prune afterwards, once the CDM tables')
  parts.push('-- show which concepts are actually used.')
  parts.push(`INSERT INTO ${TARGET}.concept`)
  parts.push(`SELECT ${athenaSelectList('concept', 'c')}`)
  parts.push(`FROM ${vs}.concept c`)
  parts.push(`WHERE c.concept_id NOT IN (SELECT concept_id FROM ${TARGET}.concept);`)

  // 2c. Operator concepts (Meas Value Operator domain)
  parts.push('')
  parts.push('-- 2c. Operator concepts (<=, >=, <, >, =)')
  parts.push(`INSERT INTO ${TARGET}.concept`)
  parts.push(`SELECT ${athenaSelectList('concept', 'c')}`)
  parts.push(`FROM ${vs}.concept c`)
  parts.push(`WHERE c.domain_id = 'Meas Value Operator'`)
  parts.push(`  AND c.concept_id NOT IN (SELECT concept_id FROM ${TARGET}.concept);`)

  // 2d. Hard-coded concept IDs
  const fixedIds = ETL_FIXED_CONCEPT_IDS.join(', ')
  parts.push('')
  parts.push('-- 2d. Hard-coded concept IDs (gender, type concepts, etc.)')
  parts.push(`INSERT INTO ${TARGET}.concept`)
  parts.push(`SELECT ${athenaSelectList('concept', 'c')}`)
  parts.push(`FROM ${vs}.concept c`)
  parts.push(`WHERE c.concept_id IN (${fixedIds})`)
  parts.push(`  AND c.concept_id NOT IN (SELECT concept_id FROM ${TARGET}.concept);`)

  // 2e. Source concepts, with the ids the mapping project holds.
  //
  // These used to be numbered at generation time
  // (`${SOURCE_CONCEPT_ID_BASE} + ROW_NUMBER() OVER (ORDER BY …)`), which meant adding or
  // removing a single mapping renumbered every source concept: ids drifted
  // between runs, and data already loaded with the previous ones silently
  // referenced the wrong concept. They are assigned once, stored on the mapping
  // and reused here — see lib/concept-mapping/source-concept-ids.
  parts.push('')
  parts.push('-- 2e. Source concepts (concept_id > 2 000 000 000)')
  parts.push('--')
  parts.push('-- The ids come from the mapping project, which keeps them for the life of the')
  parts.push('-- project: re-generating this script after adding or removing mappings leaves')
  parts.push('-- the existing ones untouched, so data already loaded stays valid. Only')
  parts.push('-- genuinely new source concepts get a newly allocated id.')
  parts.push('--')
  parts.push('-- Read from the same CSV as PART 1, so the source codes stay out of this')
  parts.push('-- file. DISTINCT because an N:1 mapping repeats a source code per target.')

  if (mappings.length > 0) {
    if (usesCcr) {
      // The CSV already IS the concept table: one row per source concept, with the
      // class resolved on the way out (source class, else target's, else domain) —
      // see lib/concept-mapping/ccr-export. Nothing to derive here.
      parts.push(`INSERT INTO ${TARGET}.concept (${CONCEPT_COLUMNS.join(', ')})`)
      parts.push(`SELECT ${CONCEPT_COLUMNS.join(', ')}`)
      parts.push(`FROM read_csv('${MAPPING_REF_PREFIX}${CONCEPT_EXPORT}', header = true);`)
    } else {
      parts.push(`INSERT INTO ${TARGET}.concept (concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, standard_concept, concept_code, valid_start_date, valid_end_date, invalid_reason)`)
      parts.push(`SELECT DISTINCT`)
      parts.push(`    stcm.source_concept_id       AS concept_id,`)
      // concept_name is NOT NULL: a source dictionary that leaves a code
      // unnamed would fail the whole load. The code is the only identity such
      // a concept has — same fallback the C/CR export applies.
      parts.push(`    COALESCE(NULLIF(TRIM(stcm.source_code_description), ''), stcm.source_code) AS concept_name,`)
      parts.push(`    stcm.${SOURCE_DOMAIN_COLUMN}          AS domain_id,`)
      parts.push(`    stcm.source_vocabulary_id    AS vocabulary_id,`)
      parts.push(`    'Clinical Observation'       AS concept_class_id,`)
      parts.push(`    NULL                         AS standard_concept,`)
      parts.push(`    stcm.source_code             AS concept_code,`)
      parts.push(`    DATE '1970-01-01'            AS valid_start_date,`)
      parts.push(`    DATE '2099-12-31'            AS valid_end_date,`)
      parts.push(`    NULL                         AS invalid_reason`)
      parts.push(`FROM read_csv('${MAPPING_REF_PREFIX}${STCM_EXPORT}', header = true) stcm`)
      parts.push(`WHERE stcm.source_concept_id >= ${SOURCE_CONCEPT_ID_BASE};`)
    }
  }

  // 2f. source_to_concept_map already carries these ids (PART 1 writes them), so
  // there is nothing left to back-fill here.

  // 2g. Vocabulary concepts for custom source vocabularies
  parts.push('')
  parts.push('-- 2g. Vocabulary concepts for custom source vocabularies')
  parts.push(`INSERT INTO ${TARGET}.concept (concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, standard_concept, concept_code, valid_start_date, valid_end_date, invalid_reason)`)
  parts.push(`SELECT`)
  parts.push(`    (SELECT COALESCE(MAX(concept_id), ${SOURCE_CONCEPT_ID_BASE}) FROM ${TARGET}.concept WHERE concept_id >= ${SOURCE_CONCEPT_ID_BASE}) + ROW_NUMBER() OVER (ORDER BY sv.source_vocabulary_id) AS concept_id,`)
  parts.push(`    sv.source_vocabulary_id     AS concept_name,`)
  parts.push(`    'Metadata'                  AS domain_id,`)
  parts.push(`    'Vocabulary'                AS vocabulary_id,`)
  parts.push(`    'Vocabulary'                AS concept_class_id,`)
  parts.push(`    NULL                        AS standard_concept,`)
  parts.push(`    sv.source_vocabulary_id     AS concept_code,`)
  parts.push(`    DATE '1970-01-01'           AS valid_start_date,`)
  parts.push(`    DATE '2099-12-31'           AS valid_end_date,`)
  parts.push(`    NULL                        AS invalid_reason`)
  parts.push(`FROM (`)
  // In C/CR mode source_to_concept_map is empty (or not filled yet), so the
  // custom vocabularies are read off the 2-billion concepts themselves. Reading
  // the old table here would silently produce no vocabulary rows at all.
  if (usesCcr) {
    parts.push(`    SELECT DISTINCT vocabulary_id AS source_vocabulary_id`)
    parts.push(`    FROM ${TARGET}.concept`)
    parts.push(`    WHERE concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
    if (has('vocabulary')) {
      parts.push(`      AND vocabulary_id NOT IN (`)
      parts.push(`        SELECT vocabulary_id FROM ${vs}.vocabulary`)
      parts.push(`    )`)
    }
  } else {
    parts.push(`    SELECT DISTINCT source_vocabulary_id`)
    parts.push(`    FROM ${TARGET}.source_to_concept_map`)
    // Exclude vocabularies ATHENA already defines — but only when the reference
    // carries that table. Without it every source vocabulary is custom by
    // definition, so the filter is simply dropped.
    if (has('vocabulary')) {
      parts.push(`    WHERE source_vocabulary_id NOT IN (`)
      parts.push(`        SELECT vocabulary_id FROM ${vs}.vocabulary`)
      parts.push(`    )`)
    }
  }
  parts.push(`) sv;`)

  // =========================================================================
  // PART 3: concept_relationship
  // =========================================================================
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 3: concept_relationship')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`TRUNCATE ${TARGET}.concept_relationship;`)
  parts.push(`INSERT INTO ${TARGET}.concept_relationship`)
  parts.push(`SELECT ${athenaSelectList('concept_relationship', 'cr')}`)
  parts.push(`FROM ${vs}.concept_relationship cr`)
  parts.push(`WHERE cr.concept_id_1 IN (SELECT concept_id FROM ${TARGET}.concept)`)
  parts.push(`  AND cr.concept_id_2 IN (SELECT concept_id FROM ${TARGET}.concept);`)

  // 3b. Custom concept_relationship: "Maps to" and "Mapped from" for source concepts
  parts.push('')
  parts.push('-- 3b. Custom concept_relationship (Maps to + Mapped from) for source concepts')
  if (usesCcr) {
    // Both directions are already in the CSV, so there is nothing to derive and
    // no `> 2 billion` guard to apply — the file holds exactly these rows.
    if (mappings.length > 0) {
      parts.push(`INSERT INTO ${TARGET}.concept_relationship (${CONCEPT_RELATIONSHIP_COLUMNS.join(', ')})`)
      parts.push(`SELECT ${CONCEPT_RELATIONSHIP_COLUMNS.join(', ')}`)
      parts.push(`FROM read_csv('${MAPPING_REF_PREFIX}${CONCEPT_RELATIONSHIP_EXPORT}', header = true);`)
    } else {
      parts.push('-- No mappings selected: nothing to relate.')
    }
  } else {
    parts.push(`INSERT INTO ${TARGET}.concept_relationship (concept_id_1, concept_id_2, relationship_id, valid_start_date, valid_end_date, invalid_reason)`)
    parts.push(`SELECT`)
    parts.push(`    stcm.source_concept_id AS concept_id_1,`)
    parts.push(`    stcm.target_concept_id AS concept_id_2,`)
    parts.push(`    'Maps to'              AS relationship_id,`)
    parts.push(`    DATE '1970-01-01'      AS valid_start_date,`)
    parts.push(`    DATE '2099-12-31'      AS valid_end_date,`)
    parts.push(`    NULL                   AS invalid_reason`)
    parts.push(`FROM ${TARGET}.source_to_concept_map stcm`)
    parts.push(`WHERE stcm.source_concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
    parts.push(`  AND stcm.target_concept_id IS NOT NULL`)
    parts.push(`  AND stcm.target_concept_id != 0;`)
    parts.push('')
    parts.push(`INSERT INTO ${TARGET}.concept_relationship (concept_id_1, concept_id_2, relationship_id, valid_start_date, valid_end_date, invalid_reason)`)
    parts.push(`SELECT`)
    parts.push(`    stcm.target_concept_id AS concept_id_1,`)
    parts.push(`    stcm.source_concept_id AS concept_id_2,`)
    parts.push(`    'Mapped from'          AS relationship_id,`)
    parts.push(`    DATE '1970-01-01'      AS valid_start_date,`)
    parts.push(`    DATE '2099-12-31'      AS valid_end_date,`)
    parts.push(`    NULL                   AS invalid_reason`)
    parts.push(`FROM ${TARGET}.source_to_concept_map stcm`)
    parts.push(`WHERE stcm.source_concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
    parts.push(`  AND stcm.target_concept_id IS NOT NULL`)
    parts.push(`  AND stcm.target_concept_id != 0;`)
  }

  // =========================================================================
  // PART 4: concept_ancestor
  // =========================================================================
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 4: concept_ancestor')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`TRUNCATE ${TARGET}.concept_ancestor;`)
  parts.push(`INSERT INTO ${TARGET}.concept_ancestor`)
  parts.push(`SELECT ca.*`)
  parts.push(`FROM ${vs}.concept_ancestor ca`)
  parts.push(`WHERE ca.ancestor_concept_id IN (SELECT concept_id FROM ${TARGET}.concept)`)
  parts.push(`  AND ca.descendant_concept_id IN (SELECT concept_id FROM ${TARGET}.concept);`)

  // =========================================================================
  // PART 5: metadata tables
  // =========================================================================
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 5: metadata tables')
  parts.push('-- =================================================================')
  parts.push('')

  // vocabulary
  if (has('vocabulary')) {
    parts.push(`TRUNCATE ${TARGET}.vocabulary;`)
    parts.push(`INSERT INTO ${TARGET}.vocabulary`)
    parts.push(`SELECT v.*`)
    parts.push(`FROM ${vs}.vocabulary v`)
    parts.push(`WHERE v.vocabulary_id IN (SELECT DISTINCT vocabulary_id FROM ${TARGET}.concept);`)
  } else {
    parts.push(skipped('vocabulary', vs))
    // The custom entries below are still worth inserting, so clear the table
    // here instead — otherwise a re-run would duplicate them.
    parts.push(`TRUNCATE ${TARGET}.vocabulary;`)
  }
  parts.push('')

  // Custom vocabulary entries for source vocabularies
  parts.push('-- Custom vocabulary entries for source vocabularies (concept_id > 2B)')
  parts.push(`INSERT INTO ${TARGET}.vocabulary (vocabulary_id, vocabulary_name, vocabulary_reference, vocabulary_version, vocabulary_concept_id)`)
  parts.push(`SELECT`)
  parts.push(`    vc.concept_code     AS vocabulary_id,`)
  parts.push(`    vc.concept_code     AS vocabulary_name,`)
  parts.push(`    'Linkr ETL'         AS vocabulary_reference,`)
  parts.push(`    NULL                AS vocabulary_version,`)
  parts.push(`    vc.concept_id       AS vocabulary_concept_id`)
  parts.push(`FROM ${TARGET}.concept vc`)
  parts.push(`WHERE vc.domain_id = 'Metadata'`)
  parts.push(`  AND vc.concept_class_id = 'Vocabulary'`)
  parts.push(`  AND vc.concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
  parts.push(`  AND vc.concept_code NOT IN (SELECT vocabulary_id FROM ${TARGET}.vocabulary);`)
  parts.push('')

  // domain
  if (has('domain')) {
    parts.push(`TRUNCATE ${TARGET}.domain;`)
    parts.push(`INSERT INTO ${TARGET}.domain`)
    parts.push(`SELECT d.*`)
    parts.push(`FROM ${vs}.domain d`)
    parts.push(`WHERE d.domain_id IN (SELECT DISTINCT domain_id FROM ${TARGET}.concept);`)
  } else {
    parts.push(skipped('domain', vs))
  }
  parts.push('')

  // concept_class
  if (has('concept_class')) {
    parts.push(`TRUNCATE ${TARGET}.concept_class;`)
    parts.push(`INSERT INTO ${TARGET}.concept_class`)
    parts.push(`SELECT cc.*`)
    parts.push(`FROM ${vs}.concept_class cc`)
    parts.push(`WHERE cc.concept_class_id IN (SELECT DISTINCT concept_class_id FROM ${TARGET}.concept);`)
  } else {
    parts.push(skipped('concept_class', vs))
  }
  parts.push('')

  // relationship
  if (has('relationship')) {
    parts.push(`TRUNCATE ${TARGET}.relationship;`)
    parts.push(`INSERT INTO ${TARGET}.relationship`)
    parts.push(`SELECT r.*`)
    parts.push(`FROM ${vs}.relationship r`)
    parts.push(`WHERE r.relationship_id IN (SELECT DISTINCT relationship_id FROM ${TARGET}.concept_relationship);`)
  } else {
    parts.push(skipped('relationship', vs))
  }
  parts.push('')

  // concept_synonym
  if (has('concept_synonym')) {
    parts.push(`TRUNCATE ${TARGET}.concept_synonym;`)
    parts.push(`INSERT INTO ${TARGET}.concept_synonym`)
    parts.push(`SELECT cs.*`)
    parts.push(`FROM ${vs}.concept_synonym cs`)
    parts.push(`WHERE cs.concept_id IN (SELECT concept_id FROM ${TARGET}.concept);`)
  } else {
    parts.push(skipped('concept_synonym', vs))
  }
  parts.push('')

  // drug_strength
  if (has('drug_strength')) {
    parts.push('-- drug_strength: dosage of the drug concepts, needed to compute')
    parts.push('-- quantities and to resolve an ingredient from a clinical drug.')
    parts.push('--')
    parts.push('-- Filtered on every concept column, not on drug_concept_id alone: the')
    parts.push('-- ingredient and unit columns are foreign keys to concept as well, and a')
    parts.push('-- row whose ingredient was not copied is a broken key. The unit columns')
    parts.push('-- are nullable, so NULL passes.')
    parts.push(`TRUNCATE ${TARGET}.drug_strength;`)
    parts.push(`INSERT INTO ${TARGET}.drug_strength`)
    parts.push(`SELECT ${athenaSelectList('drug_strength', 'dstr')}`)
    parts.push(`FROM ${vs}.drug_strength dstr`)
    parts.push(DRUG_STRENGTH_CONCEPT_COLUMNS.map((col, i) =>
      `${i === 0 ? 'WHERE' : '  AND'} (dstr.${col} IS NULL`
      + ` OR dstr.${col} IN (SELECT concept_id FROM ${TARGET}.concept))`,
    ).join('\n') + ';')
  } else {
    parts.push(skipped('drug_strength', vs))
  }

  // =========================================================================
  // PART 6: source_to_concept_map, derived from C/CR
  // =========================================================================
  if (mode === 'ccr+stcm') {
    parts.push('')
    parts.push('-- =================================================================')
    parts.push('-- PART 6: source_to_concept_map, derived from CONCEPT/CONCEPT_RELATIONSHIP')
    parts.push('-- =================================================================')
    parts.push('--')
    parts.push('-- STCM is legacy (not an official vocabulary table since CDM 5.3), kept')
    parts.push('-- here for pipelines whose own scripts still join it. It is DERIVED, never')
    parts.push('-- built alongside C/CR: the two can then never disagree, and dropping it')
    parts.push('-- one day means deleting this block alone.')
    parts.push('--')
    parts.push('-- The LEFT JOIN is what keeps unmapped codes: a source concept with no')
    parts.push("-- 'Maps to' still owes STCM a target_concept_id = 0 row, because the CDM")
    parts.push('-- scripts join this table unconditionally. Deriving from')
    parts.push('-- concept_relationship instead would drop every unmapped code.')
    parts.push('')
    parts.push(`TRUNCATE ${TARGET}.source_to_concept_map;`)
    parts.push(`INSERT INTO ${TARGET}.source_to_concept_map (${STCM_COLUMNS.join(', ')})`)
    parts.push(`SELECT`)
    parts.push(`    c.concept_code                AS source_code,`)
    parts.push(`    c.concept_id                  AS source_concept_id,`)
    parts.push(`    c.vocabulary_id               AS source_vocabulary_id,`)
    parts.push(`    c.concept_name                AS source_code_description,`)
    parts.push(`    COALESCE(cr.concept_id_2, 0)  AS target_concept_id,`)
    parts.push(`    COALESCE(t.vocabulary_id, '') AS target_vocabulary_id,`)
    parts.push(`    DATE '1970-01-01'             AS valid_start_date,`)
    parts.push(`    DATE '2099-12-31'             AS valid_end_date,`)
    parts.push(`    NULL                          AS invalid_reason`)
    parts.push(`FROM ${TARGET}.concept c`)
    parts.push(`LEFT JOIN ${TARGET}.concept_relationship cr`)
    parts.push(`       ON cr.concept_id_1 = c.concept_id`)
    parts.push(`      AND cr.relationship_id = 'Maps to'`)
    parts.push(`LEFT JOIN ${TARGET}.concept t ON t.concept_id = cr.concept_id_2`)
    parts.push(`WHERE c.concept_id >= ${SOURCE_CONCEPT_ID_BASE};`)
  }

  return { sql: parts.join('\n'), idsToPersist: sourceIds.toPersist }
}

/** Comment standing in for a part the vocabulary reference cannot satisfy. */
function skipped(table: string, vs: string): string {
  return `-- Skipped: ${vs}.${table} is not part of this vocabulary reference.`
}

// ---------------------------------------------------------------------------
// Custom vocabulary script (00b) — OHDSI reference custom mappings
// ---------------------------------------------------------------------------

/** Compact row from mimic-iv-custom-mappings.json */
export interface CustomMappingRow {
  n: string   // concept_name
  ci: number  // source_concept_id (from OHDSI reference)
  sv: string  // source_vocabulary_id (mimiciv_*)
  sd: string  // source_domain_id
  cc: string  // concept_code
  ti: number  // target_concept_id
  tv: string  // target_vocabulary_id
}

/**
 * Build the 00b_custom_vocabulary.sql script from OHDSI reference custom mappings.
 *
 * This script runs AFTER 00_vocabulary.sql and:
 * 1. Appends custom mappings to source_to_concept_map
 * 2. Creates source concepts (concept_id > 2B) with correct domain_id
 * 3. Updates source_concept_id in STCM
 * 4. Creates "Maps to" and "Mapped from" concept_relationship rows
 * 5. Adds custom vocabulary entries
 */
export function buildCustomVocabularyScript(rows: CustomMappingRow[]): string {
  const parts: string[] = []

  parts.push('-- Auto-generated from mimic-iv-custom-mappings.json')
  parts.push('-- OHDSI reference custom vocabulary mappings (care_site, visit, drug, micro, obs, etc.)')
  parts.push('')

  if (rows.length === 0) {
    parts.push('-- No custom mappings to load.')
    return parts.join('\n')
  }

  // --- PART 1: Append to source_to_concept_map ---
  parts.push('-- =================================================================')
  parts.push('-- PART 1: Append custom mappings to source_to_concept_map')
  parts.push('-- =================================================================')
  parts.push('')

  const stcmValues = rows.map((r) => {
    const code = esc(r.cc)
    const name = esc(r.n)
    const srcVocab = esc(r.sv)
    const tgtVocab = esc(r.tv)
    return `('${code}', 0, '${srcVocab}', '${name}', ${r.ti}, '${tgtVocab}', DATE '1970-01-01', DATE '2099-12-31', NULL)`
  })

  parts.push(`INSERT INTO ${TARGET}.source_to_concept_map (source_code, source_concept_id, source_vocabulary_id, source_code_description, target_concept_id, target_vocabulary_id, valid_start_date, valid_end_date, invalid_reason)`)
  parts.push('VALUES')
  parts.push(stcmValues.join(',\n') + ';')

  // --- PART 2: Create source concepts ---
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 2: Source concepts for custom mappings (concept_id > 2B)')
  parts.push('-- =================================================================')
  parts.push('')

  // Group by unique (source_vocabulary_id, concept_code) and derive domain from target
  parts.push(`INSERT INTO ${TARGET}.concept (concept_id, concept_name, domain_id, vocabulary_id, concept_class_id, standard_concept, concept_code, valid_start_date, valid_end_date, invalid_reason)`)
  parts.push(`SELECT`)
  parts.push(`    (SELECT COALESCE(MAX(concept_id), ${SOURCE_CONCEPT_ID_BASE}) FROM ${TARGET}.concept WHERE concept_id >= ${SOURCE_CONCEPT_ID_BASE})`)
  parts.push(`      + ROW_NUMBER() OVER (ORDER BY src.source_vocabulary_id, src.source_code) AS concept_id,`)
  parts.push(`    COALESCE(NULLIF(TRIM(src.source_code_description), ''), src.source_code) AS concept_name,`)
  parts.push(`    COALESCE(tc.domain_id, 'Observation') AS domain_id,`)
  parts.push(`    src.source_vocabulary_id    AS vocabulary_id,`)
  parts.push(`    'Clinical Observation'      AS concept_class_id,`)
  parts.push(`    NULL                        AS standard_concept,`)
  parts.push(`    src.source_code             AS concept_code,`)
  parts.push(`    DATE '1970-01-01'           AS valid_start_date,`)
  parts.push(`    DATE '2099-12-31'           AS valid_end_date,`)
  parts.push(`    NULL                        AS invalid_reason`)
  parts.push(`FROM (`)
  parts.push(`    SELECT DISTINCT source_vocabulary_id, source_code, source_code_description, target_concept_id`)
  parts.push(`    FROM ${TARGET}.source_to_concept_map`)
  parts.push(`    WHERE source_vocabulary_id NOT IN ('d_items', 'd_labitems')`)
  parts.push(`      AND source_code IS NOT NULL`)
  parts.push(`) src`)
  parts.push(`LEFT JOIN ${TARGET}.concept tc ON tc.concept_id = src.target_concept_id`)
  parts.push(`WHERE NOT EXISTS (`)
  parts.push(`    SELECT 1 FROM ${TARGET}.concept c2`)
  parts.push(`    WHERE c2.concept_code = src.source_code`)
  parts.push(`      AND c2.vocabulary_id = src.source_vocabulary_id`)
  parts.push(`);`)

  // --- PART 3: Update source_concept_id in STCM ---
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 3: Update source_concept_id for custom mappings')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`UPDATE ${TARGET}.source_to_concept_map`)
  parts.push(`SET source_concept_id = c.concept_id`)
  parts.push(`FROM ${TARGET}.concept c`)
  parts.push(`WHERE c.concept_code = source_to_concept_map.source_code`)
  parts.push(`  AND c.vocabulary_id = source_to_concept_map.source_vocabulary_id`)
  parts.push(`  AND c.concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
  parts.push(`  AND source_to_concept_map.source_concept_id = 0;`)

  // --- PART 4: concept_relationship Maps to + Mapped from ---
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 4: concept_relationship (Maps to + Mapped from)')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`INSERT INTO ${TARGET}.concept_relationship (concept_id_1, concept_id_2, relationship_id, valid_start_date, valid_end_date, invalid_reason)`)
  parts.push(`SELECT`)
  parts.push(`    stcm.source_concept_id AS concept_id_1,`)
  parts.push(`    stcm.target_concept_id AS concept_id_2,`)
  parts.push(`    'Maps to'              AS relationship_id,`)
  parts.push(`    DATE '1970-01-01'      AS valid_start_date,`)
  parts.push(`    DATE '2099-12-31'      AS valid_end_date,`)
  parts.push(`    NULL                   AS invalid_reason`)
  parts.push(`FROM ${TARGET}.source_to_concept_map stcm`)
  parts.push(`WHERE stcm.source_concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
  parts.push(`  AND stcm.target_concept_id IS NOT NULL`)
  parts.push(`  AND stcm.target_concept_id != 0`)
  parts.push(`  AND NOT EXISTS (`)
  parts.push(`    SELECT 1 FROM ${TARGET}.concept_relationship cr`)
  parts.push(`    WHERE cr.concept_id_1 = stcm.source_concept_id`)
  parts.push(`      AND cr.concept_id_2 = stcm.target_concept_id`)
  parts.push(`      AND cr.relationship_id = 'Maps to'`)
  parts.push(`  );`)
  parts.push('')
  parts.push(`INSERT INTO ${TARGET}.concept_relationship (concept_id_1, concept_id_2, relationship_id, valid_start_date, valid_end_date, invalid_reason)`)
  parts.push(`SELECT`)
  parts.push(`    stcm.target_concept_id AS concept_id_1,`)
  parts.push(`    stcm.source_concept_id AS concept_id_2,`)
  parts.push(`    'Mapped from'          AS relationship_id,`)
  parts.push(`    DATE '1970-01-01'      AS valid_start_date,`)
  parts.push(`    DATE '2099-12-31'      AS valid_end_date,`)
  parts.push(`    NULL                   AS invalid_reason`)
  parts.push(`FROM ${TARGET}.source_to_concept_map stcm`)
  parts.push(`WHERE stcm.source_concept_id >= ${SOURCE_CONCEPT_ID_BASE}`)
  parts.push(`  AND stcm.target_concept_id IS NOT NULL`)
  parts.push(`  AND stcm.target_concept_id != 0`)
  parts.push(`  AND NOT EXISTS (`)
  parts.push(`    SELECT 1 FROM ${TARGET}.concept_relationship cr`)
  parts.push(`    WHERE cr.concept_id_1 = stcm.target_concept_id`)
  parts.push(`      AND cr.concept_id_2 = stcm.source_concept_id`)
  parts.push(`      AND cr.relationship_id = 'Mapped from'`)
  parts.push(`  );`)

  // --- PART 5: Custom vocabulary entries ---
  parts.push('')
  parts.push('-- =================================================================')
  parts.push('-- PART 5: Custom vocabulary entries')
  parts.push('-- =================================================================')
  parts.push('')
  parts.push(`INSERT INTO ${TARGET}.vocabulary (vocabulary_id, vocabulary_name, vocabulary_reference, vocabulary_version, vocabulary_concept_id)`)
  parts.push(`SELECT`)
  parts.push(`    sv.source_vocabulary_id AS vocabulary_id,`)
  parts.push(`    sv.source_vocabulary_id AS vocabulary_name,`)
  parts.push(`    'OHDSI MIMIC-IV ETL'   AS vocabulary_reference,`)
  parts.push(`    NULL                    AS vocabulary_version,`)
  parts.push(`    0                       AS vocabulary_concept_id`)
  parts.push(`FROM (`)
  parts.push(`    SELECT DISTINCT source_vocabulary_id`)
  parts.push(`    FROM ${TARGET}.source_to_concept_map`)
  parts.push(`    WHERE source_vocabulary_id NOT IN (SELECT vocabulary_id FROM ${TARGET}.vocabulary)`)
  parts.push(`) sv;`)

  return parts.join('\n')
}
