import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '@/lib/duckdb/sql-tokenizer'
import {
  ETL_FIXED_CONCEPT_IDS,
  OMOP_METADATA_VOCABULARIES,
  athenaSelectList,
  buildCustomVocabularyScript,
  buildFillVocabularyScript,
  buildVocabularyScript,
  buildVocabularyScriptWithIds,
} from './build-vocabulary-script'
import type { ConceptMapping } from '@/types'

const MAPPING: ConceptMapping = {
  id: 'm1',
  projectId: 'p1',
  sourceConceptId: 1,
  sourceConceptName: 'Sodium',
  sourceVocabularyId: 'mimiciv_labs',
  sourceDomainId: 'Measurement',
  sourceConceptCode: '50983',
  targetConceptId: 3019550,
  targetConceptName: 'Sodium [Moles/volume] in Serum or Plasma',
  targetVocabularyId: 'LOINC',
  targetDomainId: 'Measurement',
  targetConceptCode: '2951-2',
  mappingType: 'maps_to',
  equivalence: 'skos:exactMatch',
  status: 'approved',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** OMOP tables the script writes to — all live on the pipeline target. */
const TARGET_TABLES = [
  'concept', 'concept_relationship', 'concept_ancestor', 'concept_synonym',
  'concept_class', 'source_to_concept_map', 'vocabulary', 'domain', 'relationship',
]

/** Every table an ATHENA download can carry. */
const ATHENA_TABLES = [
  'concept', 'concept_ancestor', 'concept_relationship', 'concept_synonym',
  'vocabulary', 'domain', 'concept_class', 'relationship', 'drug_strength',
]

/** The fill script against a reference holding every ATHENA table. */
const FULL_FILL = buildFillVocabularyScript(undefined, ATHENA_TABLES)

/** drug_strength columns that are foreign keys to concept. */
const DRUG_STRENGTH_CONCEPT_COLS = [
  'drug_concept_id', 'ingredient_concept_id', 'amount_unit_concept_id',
  'numerator_unit_concept_id', 'denominator_unit_concept_id',
]

describe('buildVocabularyScript', () => {
  const sql = buildVocabularyScript([MAPPING])

  it('reads the ATHENA reference through the vocab role', () => {
    expect(sql).toContain('FROM vocab.concept ')
    expect(sql).not.toMatch(/\bds_[0-9a-f_]{8}/i)
  })

  it('qualifies every write with target., in every mode', () => {
    // Left bare, a write would resolve through the Run dropdown's search_path —
    // so a DELETE could hit the ATHENA reference instead of the target.
    for (const mode of ['ccr', 'ccr+stcm', 'stcm'] as const) {
      const modeSql = buildVocabularyScript([MAPPING], undefined, undefined, mode)
      for (const table of TARGET_TABLES) {
        expect(modeSql).not.toMatch(new RegExp(`TRUNCATE ${table}\\b`))
        expect(modeSql).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`))
        expect(modeSql).not.toMatch(new RegExp(`UPDATE ${table}\\b`))
      }
      expect(modeSql).toContain('TRUNCATE target.concept;')
      expect(modeSql).toContain('TRUNCATE target.concept_relationship;')
    }
  })

  it('qualifies target tables read in subqueries too, in every mode', () => {
    // An unqualified read here would resolve via search_path, i.e. silently
    // depend on which database the Run dropdown happens to point at.
    for (const mode of ['ccr', 'ccr+stcm', 'stcm'] as const) {
      const modeSql = buildVocabularyScript([MAPPING], undefined, undefined, mode)
      expect(modeSql).not.toMatch(/FROM concept\b(?!_)/)
      expect(modeSql).not.toMatch(/FROM source_to_concept_map\b/)
    }
  })

  it('writes source_to_concept_map only in the modes that own it', () => {
    for (const mode of ['ccr+stcm', 'stcm'] as const) {
      expect(buildVocabularyScript([MAPPING], undefined, undefined, mode))
        .toContain('INSERT INTO target.source_to_concept_map')
    }
    expect(buildVocabularyScript([MAPPING], undefined, undefined, 'ccr'))
      .not.toContain('INSERT INTO target.source_to_concept_map')
  })

  it('leaves column names containing a table name alone', () => {
    expect(sql).toContain('concept_id')
    expect(sql).toContain('vocabulary_id')
  })

  it('copies from the reference only what the mapping project knows', () => {
    // Copying the whole reference here (~10M concepts, then ~140M relationship
    // and ancestor rows) ran an indexed DuckDB target out of memory. The rest
    // of what the CDM uses is copied by the fill script, once it is known.
    for (const mode of ['ccr', 'ccr+stcm', 'stcm'] as const) {
      const full = buildVocabularyScript([MAPPING], undefined, ATHENA_TABLES, mode)
      const code = full.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      for (const t of ['concept_relationship', 'concept_ancestor', 'concept_synonym', 'drug_strength', 'domain', 'concept_class', 'relationship']) {
        expect(code).not.toContain(`vocab.${t}`)
      }
      expect(code).not.toMatch(/FROM vocab\.concept c\nWHERE c\.concept_id NOT IN/)
      expect(code).not.toContain("'Meas Value Operator'")
    }
  })

  it('leaves the tables the fill script owns alone', () => {
    const full = buildVocabularyScript([MAPPING], undefined, ATHENA_TABLES)
    for (const t of ['concept_ancestor', 'concept_synonym', 'drug_strength', 'domain', 'concept_class', 'relationship']) {
      expect(full).not.toMatch(new RegExp(`target\\.${t}\\b`))
    }
  })

  it('allocates custom-vocabulary concept ids with COALESCE so an empty target does not NULL them', () => {
    // Without COALESCE, MAX(concept_id) over an empty set is NULL and
    // NULL + ROW_NUMBER() inserts nothing (or violates NOT NULL).
    expect(sql).toContain('COALESCE(MAX(concept_id), 2000000000)')
    expect(sql).not.toMatch(/\(SELECT MAX\(concept_id\) FROM target\.concept WHERE concept_id >= 2000000000\) \+ ROW_NUMBER/)
  })
})

describe('buildFillVocabularyScript', () => {
  const sql = FULL_FILL

  it('finds the used concepts from the schema, not a fixed column list', () => {
    // A hand-written list of *_concept_id columns missed half of them (43 vs the
    // 99 a CDM 5.4 target actually holds), and would drift with the CDM version.
    expect(sql).toContain('FROM duckdb_columns()')
    expect(sql).toContain("column_name SIMILAR TO '.*_concept_id'")
  })

  it('resolves the target in both engines', () => {
    // The target is an ATTACHed database on the server and a schema in the
    // browser engine; filtering on either alone works in one mode only.
    expect(sql).toContain("(database_name = 'target' OR schema_name = 'target')")
  })

  it('skips the vocabulary tables when scanning for used concepts', () => {
    // They reference concepts in order to describe them, so counting those
    // references would copy concepts no CDM row uses.
    expect(sql).toMatch(/table_name NOT IN \([^)]*'concept'[^)]*\)/)
    expect(sql).toMatch(/table_name NOT IN \([^)]*'concept_ancestor'[^)]*\)/)
  })

  it('passes the generated scan through a variable', () => {
    // query() rejects a subquery argument: "Table function cannot contain
    // subqueries". Verified against DuckDB on the real database.
    expect(sql).toContain('SET VARIABLE linkr_used_concepts_sql')
    expect(sql).toContain("query(getvariable('linkr_used_concepts_sql'))")
    expect(sql).not.toMatch(/FROM query\(\s*\(SELECT/)
  })

  it('aborts when no concept is referenced, before copying anything', () => {
    // An empty scan means it ran before the CDM tables were filled; carrying on
    // would leave every concept_id dangling for the tests to report.
    const guard = sql.indexOf('error(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(sql.indexOf('INSERT INTO target.concept'))
  })

  it('expands the used concepts through the reference, not the target', () => {
    // The target holds only the mapping project's concepts at this point, so
    // reading ancestors and relations there would find almost nothing.
    expect(sql).toContain('FROM vocab.concept_ancestor a')
    expect(sql).toContain('FROM vocab.concept_relationship cr\n    INNER JOIN target.tmp_used_concepts')
    expect(sql).toContain('a.ancestor_concept_id')
    expect(sql).toContain('cr.concept_id_2')
  })

  it('adds only the missing concepts and relationships, so it can re-run', () => {
    // The vocabulary script already loaded the mapping project's concepts and
    // 'Maps to' rows; a plain INSERT would duplicate them on a re-run.
    expect(sql).toContain('ANTI JOIN target.concept t ON t.concept_id = c.concept_id;')
    expect(sql).toMatch(/ANTI JOIN target\.concept_relationship t\s+ON\s+t\.concept_id_1 = cr\.concept_id_1/)
    expect(sql).not.toContain('TRUNCATE target.concept;')
    expect(sql).not.toContain('TRUNCATE target.concept_relationship;')
  })

  it('keeps every foreign key of the copied relationship and ancestor rows', () => {
    expect(sql).toContain('SEMI JOIN target.concept c1 ON c1.concept_id = cr.concept_id_1')
    expect(sql).toContain('SEMI JOIN target.concept c2 ON c2.concept_id = cr.concept_id_2')
    expect(sql).toContain('SEMI JOIN target.concept c1 ON c1.concept_id = ca.ancestor_concept_id')
    expect(sql).toContain('SEMI JOIN target.concept c2 ON c2.concept_id = ca.descendant_concept_id')
  })

  it('never touches a clinical table', () => {
    // A write here would silently alter patient data.
    const written = [...sql.matchAll(/(?:INSERT INTO|TRUNCATE|DELETE FROM|CREATE OR REPLACE TABLE) target\.(\w+)/g)].map((m) => m[1])
    for (const clinical of ['person', 'measurement', 'condition_occurrence', 'drug_exposure', 'drug_era']) {
      expect(written).not.toContain(clinical)
    }
    expect(sql).not.toContain('DELETE FROM')
  })

  it('splits into separate statements', () => {
    // The runner splits on top-level semicolons and reports progress per
    // statement. `LIKE ... ESCAPE '\'` broke that: the tokenizer read the
    // backslash as escaping the closing quote, so the string never ended and
    // the whole script ran — and was reported — as a single statement.
    expect(splitSqlStatements(sql).length).toBeGreaterThan(10)
    expect(sql).not.toContain("ESCAPE '\\'")
  })

  it('copies the metadata vocabularies whole', () => {
    // The metadata tables' *_concept_id columns, cdm_source's CDM version and
    // fact_relationship's domains all point into them, and no CDM row scan
    // would find most of them.
    const keep = sql.slice(sql.indexOf('CREATE OR REPLACE TABLE target.tmp_keep_concepts'))
    const keepStatement = keep.slice(0, keep.indexOf(';'))
    expect(keepStatement).toContain(
      `WHERE m.vocabulary_id IN (${OMOP_METADATA_VOCABULARIES.map((v) => `'${v}'`).join(', ')})`,
    )
    expect(OMOP_METADATA_VOCABULARIES).toContain('CDM')
    expect(OMOP_METADATA_VOCABULARIES).toContain('Relationship')
  })

  it('copies the metadata tables whole, the None row included', () => {
    // 'None' carries the vocabulary bundle release that cdm_source reads.
    expect(sql).toMatch(/INSERT INTO target\.vocabulary\nSELECT v\.\*\nFROM vocab\.vocabulary v\nWHERE v\.vocabulary_id NOT IN/)
    for (const [table, alias] of [['domain', 'd'], ['concept_class', 'cc'], ['relationship', 'r']]) {
      expect(sql).toContain(`INSERT INTO target.${table}\nSELECT ${alias}.*\nFROM vocab.${table} ${alias};`)
    }
  })

  it('keeps the custom vocabulary entries the vocabulary script wrote', () => {
    expect(sql).not.toContain('TRUNCATE target.vocabulary;')
    expect(sql).toContain('WHERE v.vocabulary_id NOT IN (SELECT vocabulary_id FROM target.vocabulary);')
  })

  it('drops its temporary tables', () => {
    expect(sql).toContain('DROP TABLE IF EXISTS target.tmp_used_concepts;')
    expect(sql).toContain('DROP TABLE IF EXISTS target.tmp_keep_concepts;')
  })
})

describe('ATHENA date columns', () => {
  const sql = buildVocabularyScript([MAPPING])

  it('never copies the ATHENA tables positionally', () => {
    // `SELECT c.*` put a YYYYMMDD BIGINT into a DATE column, which DuckDB
    // refuses ("Unimplemented type for cast (BIGINT -> DATE)").
    for (const script of [sql, FULL_FILL]) {
      expect(script).not.toContain('SELECT c.*')
      expect(script).not.toContain('SELECT cr.*')
    }
  })

  it('converts the date columns of every copied table', () => {
    for (const col of ['valid_start_date', 'valid_end_date']) {
      expect(sql).toContain(`try_strptime(CAST(c.${col} AS VARCHAR), '%Y%m%d')`)
      expect(FULL_FILL).toContain(`try_strptime(CAST(c.${col} AS VARCHAR), '%Y%m%d')`)
      expect(FULL_FILL).toContain(`try_strptime(CAST(cr.${col} AS VARCHAR), '%Y%m%d')`)
    }
  })

  it('falls back to a plain cast so real DATE columns still work', () => {
    expect(sql).toContain('TRY_CAST(c.valid_start_date AS DATE)')
  })

  it('lists the concept columns explicitly, in DDL order', () => {
    expect(athenaSelectList('concept', 'c')).toMatch(
      /^c\.concept_id, c\.concept_name, c\.domain_id, c\.vocabulary_id, c\.concept_class_id, c\.standard_concept, c\.concept_code, COALESCE/,
    )
  })

  it('leaves a table it has no column list for as a star select', () => {
    expect(athenaSelectList('concept_ancestor', 'ca')).toBe('ca.*')
  })
})

describe('source concept ids', () => {
  it('loads source_to_concept_map from the mapping export, not inline rows', () => {
    // The rows carry a private dictionary's source codes; the CSV keeps them out
    // of this (versioned) file — see lib/duckdb/mapping-source.
    const { sql } = buildVocabularyScriptWithIds(
      [{ ...MAPPING, sourceConceptId: 2_000_000_042 }],
      undefined, undefined, undefined, 'stcm',
    )
    expect(sql).toContain("read_csv('mapping.source_to_concept_map'")
    expect(sql).not.toContain('50983')
    expect(sql).not.toContain('2000000042')
  })

  it('reads the C/CR exports instead, by default', () => {
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_042 },
    ])
    expect(sql).toContain("read_csv('mapping.concept'")
    expect(sql).toContain("read_csv('mapping.concept_relationship'")
    expect(sql).not.toContain('50983')
    expect(sql).not.toContain('2000000042')
  })

  it('leaks no mapping content into the script, whatever the mappings', () => {
    // The point of the CSV: this file is versioned, the dictionary may be private.
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptCode: 'SECRET_CODE', sourceConceptName: 'Secret Name' },
      { ...MAPPING, id: 'm2', sourceConceptCode: 'OTHER_CODE', sourceConceptName: 'Other Name' },
    ])
    expect(sql).not.toContain('SECRET_CODE')
    expect(sql).not.toContain('Secret Name')
    expect(sql).not.toContain('OTHER_CODE')
    expect(sql).not.toContain('Other Name')
  })

  it('never renumbers with ROW_NUMBER', () => {
    // Row-numbering at generation time made every id shift whenever a mapping
    // was added or removed.
    const { sql } = buildVocabularyScriptWithIds([MAPPING])
    expect(sql).not.toContain('ROW_NUMBER() OVER (ORDER BY src.')
  })

  it('reports a newly allocated id so the caller can persist it', () => {
    const { idsToPersist } = buildVocabularyScriptWithIds([MAPPING])
    expect(idsToPersist.get(MAPPING.id)).toBeGreaterThanOrEqual(2_000_000_000)
  })

  it('persists nothing when every mapping already has an id', () => {
    const { idsToPersist } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_007 },
    ])
    expect(idsToPersist.size).toBe(0)
  })

  it('builds the source concepts from the export, keeping ids consistent (stcm)', () => {
    // Both the STCM rows and the source concepts come from the one CSV, so the
    // id used in each cannot drift apart.
    const { sql } = buildVocabularyScriptWithIds(
      [{ ...MAPPING, sourceConceptId: 2_000_000_123 }],
      undefined, undefined, undefined, 'stcm',
    )
    const reads = sql.match(/read_csv\('mapping\.source_to_concept_map'/g)
    expect(reads).toHaveLength(2)
    expect(sql).toContain('stcm.source_concept_id       AS concept_id')
    expect(sql).toContain('WHERE stcm.source_concept_id >= 2000000000')
  })

  it('takes the source concepts straight from concept.csv (ccr)', () => {
    // No derivation at all here: the CSV already carries the ids, the class and
    // the domain, so there is nothing for the SQL to reconstruct.
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_123 },
    ])
    expect(sql).toContain("read_csv('mapping.concept'")
    // No per-column derivation of the source concepts (2g still builds the
    // custom-vocabulary rows, which is a different thing).
    expect(sql).not.toContain('stcm.source_concept_id       AS concept_id')
    expect(sql).not.toContain('WHERE stcm.source_concept_id >= 2000000000')
  })

  it('allocates against the whole project, not just the filtered subset', () => {
    // A mapping hidden by the status filter still owns its id; reusing it for a
    // different source concept would collide once the filter changes.
    const hidden = { ...MAPPING, id: 'm2', sourceConceptCode: '99999', sourceConceptId: 2_000_000_500 }
    const { idsToPersist } = buildVocabularyScriptWithIds(
      [MAPPING], undefined, undefined, [MAPPING, hidden],
    )
    expect(idsToPersist.get(MAPPING.id)).toBeGreaterThan(2_000_000_500)
  })

  it('explains in the script why the ids are stable', () => {
    const { sql } = buildVocabularyScriptWithIds([MAPPING])
    expect(sql).toContain('come from the mapping project')
  })
})

describe('vocabulary references missing the metadata tables', () => {
  // An ATHENA import keeps only the four tables the mapping UI needs, so the
  // metadata parts have to be skipped rather than left to fail at run time
  // ("Table with name vocabulary does not exist").
  const CORE = ['concept', 'concept_ancestor', 'concept_relationship', 'concept_synonym']
  const sql = buildVocabularyScript([MAPPING], undefined, CORE)
  const fill = buildFillVocabularyScript(undefined, CORE)
  const code = (script: string) => script.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

  it('never reads a table the reference does not have', () => {
    // Comments still name the skipped table, so assert on executable lines only.
    for (const script of [sql, fill]) {
      for (const t of ['vocabulary', 'domain', 'concept_class', 'relationship', 'drug_strength']) {
        expect(code(script)).not.toContain(`vocab.${t}`)
      }
    }
  })

  it('still copies the tables it does have', () => {
    expect(fill).toContain('FROM vocab.concept ')
    expect(fill).toContain('FROM vocab.concept_synonym ')
  })

  it('drops the ATHENA filter from the custom-vocabulary insert', () => {
    // Without vocab.vocabulary every source vocabulary is custom by definition.
    expect(sql).not.toContain('SELECT vocabulary_id FROM vocab.vocabulary')
    expect(sql).toContain("'Linkr ETL'")
  })

  it('still clears target.vocabulary before inserting the custom entries', () => {
    // Otherwise re-running the script would duplicate them.
    expect(sql).toContain('TRUNCATE target.vocabulary;')
  })

  it('still clears the tables it cannot refill', () => {
    // Left alone they would keep a previous run's rows, pointing at concepts
    // this run may not have copied.
    for (const t of ['drug_strength', 'domain', 'concept_class', 'relationship']) {
      expect(fill).toContain(`TRUNCATE target.${t};`)
    }
  })

  it('says which parts were skipped', () => {
    expect(fill).toContain('-- Skipped: vocab.vocabulary is not part of this vocabulary reference.')
  })

  it('emits every part when the reference is complete', () => {
    expect(FULL_FILL).toContain('FROM vocab.vocabulary v')
    expect(FULL_FILL).toContain('FROM vocab.domain d')
    expect(FULL_FILL).not.toContain('-- Skipped:')
  })
})

describe('drug_strength', () => {
  it('is copied by the fill script, and cleared first', () => {
    expect(FULL_FILL).toContain('TRUNCATE target.drug_strength;')
    expect(FULL_FILL).toContain('INSERT INTO target.drug_strength')
    expect(FULL_FILL).toContain('FROM vocab.drug_strength dstr')
  })

  it('normalises the ATHENA date columns instead of copying positionally', () => {
    // ATHENA's CSV-derived parquet types them as BIGINT (20100401); a bare
    // SELECT * then fails the implicit cast on INSERT.
    expect(FULL_FILL).not.toContain('SELECT dstr.*')
    expect(FULL_FILL).toContain("try_strptime(CAST(dstr.valid_start_date AS VARCHAR), '%Y%m%d')")
    expect(FULL_FILL).toContain('dstr.box_size')
  })

  it('copies only rows whose every concept column was copied, NULL units aside', () => {
    // Each of the five is a foreign key to concept: keeping a row on
    // drug_concept_id alone leaves a broken key on its ingredient or unit.
    for (const col of DRUG_STRENGTH_CONCEPT_COLS) {
      expect(FULL_FILL).toContain(
        `(dstr.${col} IS NULL OR dstr.${col} IN (SELECT concept_id FROM target.concept))`,
      )
    }
  })

  it('pulls in the ingredients and units of the drugs the CDM uses', () => {
    // They are described by drug_strength and referenced by no CDM column, so
    // the used-concept scan never sees them: without this every drug_strength
    // row of every drug in use would be dropped.
    expect(FULL_FILL).toContain('FROM vocab.drug_strength ds')
    expect(FULL_FILL).toContain(
      'SELECT UNNEST([ds.drug_concept_id, ds.ingredient_concept_id, ds.amount_unit_concept_id,'
      + ' ds.numerator_unit_concept_id, ds.denominator_unit_concept_id]) AS concept_id',
    )
  })
})

describe('concepts to copy', () => {
  const keep = FULL_FILL.slice(FULL_FILL.indexOf('CREATE OR REPLACE TABLE target.tmp_keep_concepts'))
  const keepStatement = keep.slice(0, keep.indexOf(';'))

  it('never lets a NULL into tmp_keep_concepts', () => {
    // The unit columns of drug_strength are nullable.
    expect(keepStatement).toContain('WHERE concept_id IS NOT NULL')
  })

  it('never writes a NULL concept_name, whichever path builds concept', () => {
    // concept.concept_name is NOT NULL, so one unnamed source code fails the
    // entire vocabulary load. The C/CR path resolves this in the CSV itself
    // (see ccr-export); the STCM and custom-vocabulary paths read a description
    // column straight out of the CSV and need the fallback in the SQL.
    const stcm = buildVocabularyScript([MAPPING], undefined, undefined, 'stcm')
    expect(stcm).toContain(
      "COALESCE(NULLIF(TRIM(stcm.source_code_description), ''), stcm.source_code) AS concept_name",
    )
    const custom = buildCustomVocabularyScript([
      { n: 'Foo', ci: 1, sv: 'mimiciv_drug', sd: 'Drug', cc: 'X1', ti: 42, tv: 'RxNorm' },
    ])
    expect(custom).toContain(
      "COALESCE(NULLIF(TRIM(src.source_code_description), ''), src.source_code) AS concept_name",
    )
  })

  it('includes the concepts the ETL writes as literals', () => {
    // Concept 0 above all: every unmapped row carries concept_id = 0. It is
    // deliberately absent from tmp_used_concepts — expanding the closure of
    // "no matching concept" means nothing — which is why it is added here.
    expect(keepStatement).toContain(
      `SELECT UNNEST([${ETL_FIXED_CONCEPT_IDS.join(', ')}]) AS concept_id`,
    )
    expect(ETL_FIXED_CONCEPT_IDS).toContain(0)
  })
})

describe('buildCustomVocabularyScript', () => {
  const sql = buildCustomVocabularyScript([
    { n: 'Foo', ci: 1, sv: 'mimiciv_drug', sd: 'Drug', cc: 'X1', ti: 42, tv: 'RxNorm' },
  ])

  it('qualifies its writes with target. as well', () => {
    expect(sql).not.toMatch(/INSERT INTO concept\b/)
    expect(sql).not.toMatch(/UPDATE source_to_concept_map\b/)
    expect(sql).toContain('INSERT INTO target.source_to_concept_map')
    expect(sql).toContain('UPDATE target.source_to_concept_map')
  })

  it('is a no-op script when there are no rows', () => {
    expect(buildCustomVocabularyScript([])).toContain('No custom mappings')
  })
})

describe('clearing tables', () => {
  it('truncates rather than deleting, everywhere', () => {
    // Every clear wipes a whole table, and DELETE journals row by row — on
    // concept / concept_relationship that dominated the script's runtime.
    const { sql } = buildVocabularyScriptWithIds([MAPPING], undefined, ATHENA_TABLES)
    expect(sql).not.toContain('DELETE FROM')
    for (const table of ['concept', 'concept_relationship', 'vocabulary']) {
      expect(sql).toContain(`TRUNCATE target.${table};`)
    }
    expect(FULL_FILL).not.toContain('DELETE FROM')
    for (const table of ['concept_ancestor', 'concept_synonym', 'drug_strength', 'domain', 'concept_class', 'relationship']) {
      expect(FULL_FILL).toContain(`TRUNCATE target.${table};`)
    }
  })

  it('leaves source_to_concept_map alone in ccr mode', () => {
    // A pipeline may fill that table by other means; C/CR does not own it.
    const { sql } = buildVocabularyScriptWithIds([MAPPING], undefined, ATHENA_TABLES, undefined, 'ccr')
    expect(sql).not.toContain('TRUNCATE target.source_to_concept_map;')
  })

  it('truncates source_to_concept_map in the modes that write it', () => {
    for (const mode of ['stcm', 'ccr+stcm'] as const) {
      const { sql } = buildVocabularyScriptWithIds([MAPPING], undefined, ATHENA_TABLES, undefined, mode)
      expect(sql).toContain('TRUNCATE target.source_to_concept_map;')
      expect(sql).not.toContain('DELETE FROM')
    }
  })
})

describe('vocabulary mode', () => {
  const stmts = (sql: string) => splitSqlStatements(sql).map((s) => s.trim()).filter(Boolean)

  it('defaults to C/CR — the OMOP v5 shape', () => {
    expect(buildVocabularyScript([MAPPING])).toBe(buildVocabularyScript([MAPPING], undefined, undefined, 'ccr'))
  })

  it('still builds the legacy shape byte for byte when asked', () => {
    // A pipeline pinned to 'stcm' must regenerate exactly what it holds, so
    // switching the default produces no git diff for it.
    const sql = buildVocabularyScript([MAPPING], undefined, undefined, 'stcm')
    expect(sql).toContain("read_csv('mapping.source_to_concept_map'")
    expect(sql).toContain('TRUNCATE target.source_to_concept_map;')
    expect(sql).not.toContain("read_csv('mapping.concept'")
  })

  describe('ccr', () => {
    const sql = buildVocabularyScript([MAPPING], undefined, undefined, 'ccr')

    it('reads the concept and relationship exports', () => {
      expect(sql).toContain("read_csv('mapping.concept'")
      expect(sql).toContain("read_csv('mapping.concept_relationship'")
    })

    it('never reads the STCM export', () => {
      expect(sql).not.toContain("read_csv('mapping.source_to_concept_map'")
    })

    it('leaves source_to_concept_map alone — a pipeline may fill it otherwise', () => {
      expect(sql).not.toContain('TRUNCATE target.source_to_concept_map;')
      expect(sql).not.toContain('INSERT INTO target.source_to_concept_map')
    })

    it('drops the 2-billion guard: the CSV holds only local concepts', () => {
      expect(sql).not.toContain('WHERE stcm.source_concept_id >= 2000000000')
    })

    it('derives no Mapped from in SQL — the CSV carries both directions', () => {
      expect(sql).not.toContain("'Mapped from'          AS relationship_id")
    })

    it('reads custom vocabularies off the 2B concepts, not the empty STCM table', () => {
      // The trap: source_to_concept_map is empty here, so the old subquery would
      // have produced no vocabulary rows at all.
      expect(sql).toContain('SELECT DISTINCT vocabulary_id AS source_vocabulary_id')
      expect(sql).toContain('WHERE concept_id >= 2000000000')
    })

    it('still leaks no mapping content into the versioned script', () => {
      const secret = buildVocabularyScript(
        [{ ...MAPPING, sourceConceptCode: 'SECRET_CODE', sourceConceptName: 'Secret Name' }],
        undefined, undefined, 'ccr',
      )
      expect(secret).not.toContain('SECRET_CODE')
      expect(secret).not.toContain('Secret Name')
    })

    it('pulls in target concepts via the Maps to rows', () => {
      expect(sql).toContain("WHERE relationship_id = 'Maps to'")
    })

    it('parses into complete statements', () => {
      expect(stmts(sql).length).toBeGreaterThan(5)
      for (const s of stmts(sql)) expect(s).not.toContain('read_csv(\'mapping.source_to_concept_map')
    })

    it('copies no reference concepts for 2a when there are no mappings', () => {
      // A bare INSERT ... FROM vocab.concept would duplicate the whole reference.
      const empty = buildVocabularyScript([], undefined, undefined, 'ccr')
      expect(empty).toContain('WHERE FALSE;')
    })
  })

  describe('ccr+stcm', () => {
    const sql = buildVocabularyScript([MAPPING], undefined, undefined, 'ccr+stcm')

    it('fills C/CR from the exports', () => {
      expect(sql).toContain("read_csv('mapping.concept'")
      expect(sql).toContain("read_csv('mapping.concept_relationship'")
    })

    it('derives STCM from the tables, not from a CSV', () => {
      expect(sql).toContain('PART 5')
      expect(sql).toContain('INSERT INTO target.source_to_concept_map')
      expect(sql).not.toContain("read_csv('mapping.source_to_concept_map'")
    })

    it('keeps unmapped codes as target_concept_id = 0 rows', () => {
      // The LEFT JOIN is the whole point: the CDM scripts join STCM
      // unconditionally, so an unmapped code still owes it a row.
      expect(sql).toContain('LEFT JOIN target.concept_relationship cr')
      expect(sql).toContain('COALESCE(cr.concept_id_2, 0)  AS target_concept_id')
    })

    it('derives only the local concepts', () => {
      expect(sql).toContain('WHERE c.concept_id >= 2000000000;')
    })

    it('runs the derivation after concept_relationship is filled', () => {
      // It reads target.concept_relationship, so PART 3 has to have run.
      expect(sql.indexOf('-- PART 3: concept_relationship'))
        .toBeLessThan(sql.indexOf('-- PART 5: source_to_concept_map'))
    })
  })
})
