import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '@/lib/duckdb/sql-tokenizer'
import {
  athenaSelectList,
  buildCustomVocabularyScript,
  buildPruneVocabularyScript,
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

describe('buildVocabularyScript', () => {
  const sql = buildVocabularyScript([MAPPING])

  it('reads the ATHENA reference through the vocab role', () => {
    expect(sql).toContain('FROM vocab.concept ')
    expect(sql).toContain('FROM vocab.concept_relationship ')
    expect(sql).not.toMatch(/\bds_[0-9a-f_]{8}/i)
  })

  it('qualifies every write with target.', () => {
    for (const table of TARGET_TABLES) {
      expect(sql).not.toMatch(new RegExp(`TRUNCATE ${table}\\b`))
      expect(sql).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`))
      expect(sql).not.toMatch(new RegExp(`UPDATE ${table}\\b`))
    }
    expect(sql).toContain('TRUNCATE target.concept;')
    expect(sql).toContain('INSERT INTO target.concept_ancestor')
    expect(sql).toContain('INSERT INTO target.source_to_concept_map')
  })

  it('qualifies target tables read in subqueries too', () => {
    // An unqualified read here would resolve via search_path, i.e. silently
    // depend on which database the Run dropdown happens to point at.
    expect(sql).not.toMatch(/FROM concept\b(?!_)/)
    expect(sql).not.toMatch(/FROM source_to_concept_map\b/)
    expect(sql).toContain('FROM target.source_to_concept_map')
  })

  it('leaves column names containing a table name alone', () => {
    expect(sql).toContain('concept_id')
    expect(sql).toContain('vocabulary_id')
  })

  it('copies the concept table without filtering on vocabulary_id', () => {
    // A 'Maps to' can land outside whatever vocabularies the ETL reads
    // directly (ICD -> OMOP Extension, NDC -> CVX). Filtering the copy left
    // those targets out and the CDM ended up with concept_ids absent from
    // target.concept - a broken foreign key. 91_prune_vocabulary.sql cuts the
    // table back down once the CDM says which concepts are used.
    const copy = sql.slice(sql.indexOf('-- 2b.'), sql.indexOf('-- 2c.'))
    expect(copy).toContain('INSERT INTO target.concept')
    expect(copy).not.toMatch(/WHERE c\.vocabulary_id IN \(/)
    expect(copy).not.toContain("'OMOP Extension'")
    expect(copy).not.toContain("'ICD10CM'")
  })

  it('allocates custom-vocabulary concept ids with COALESCE so an empty target does not NULL them', () => {
    // Without COALESCE, MAX(concept_id) over an empty set is NULL and
    // NULL + ROW_NUMBER() inserts nothing (or violates NOT NULL).
    expect(sql).toContain('COALESCE(MAX(concept_id), 2000000000)')
    expect(sql).not.toMatch(/\(SELECT MAX\(concept_id\) FROM target\.concept WHERE concept_id >= 2000000000\) \+ ROW_NUMBER/)
  })
})

describe('buildPruneVocabularyScript', () => {
  const sql = buildPruneVocabularyScript()

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
    // references would keep every concept alive and prune nothing.
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

  it('keeps ancestors and related concepts, not just the used ones', () => {
    // Dropping ancestors breaks hierarchical queries ("everything under
    // Diabetes"), and dropping relations breaks source-to-standard traceability.
    expect(sql).toContain('a.ancestor_concept_id')
    expect(sql).toContain('cr.concept_id_2')
  })

  it('deletes from the vocabulary tables only', () => {
    const deleted = [...sql.matchAll(/DELETE FROM target\.(\w+)/g)].map((m) => m[1])
    expect(deleted).toContain('concept')
    expect(deleted).toContain('concept_ancestor')
    // A DELETE on a clinical table here would silently drop patient data.
    for (const clinical of ['person', 'measurement', 'condition_occurrence', 'drug_exposure']) {
      expect(deleted).not.toContain(clinical)
    }
  })

  it('splits into separate statements', () => {
    // The runner splits on top-level semicolons and reports progress per
    // statement. `LIKE ... ESCAPE '\'` broke that: the tokenizer read the
    // backslash as escaping the closing quote, so the string never ended and
    // the whole script ran — and was reported — as a single statement.
    expect(splitSqlStatements(sql).length).toBeGreaterThan(10)
    expect(sql).not.toContain("ESCAPE '\\'")
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
    expect(sql).not.toContain('SELECT c.*')
    expect(sql).not.toContain('SELECT cr.*')
  })

  it('converts the date columns of every copied table', () => {
    for (const col of ['valid_start_date', 'valid_end_date']) {
      expect(sql).toContain(`try_strptime(CAST(c.${col} AS VARCHAR), '%Y%m%d')`)
      expect(sql).toContain(`try_strptime(CAST(cr.${col} AS VARCHAR), '%Y%m%d')`)
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
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_042 },
    ])
    expect(sql).toContain("read_csv('mapping.source_to_concept_map'")
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
    expect(idsToPersist.get(MAPPING.id)).toBeGreaterThan(2_000_000_000)
  })

  it('persists nothing when every mapping already has an id', () => {
    const { idsToPersist } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_007 },
    ])
    expect(idsToPersist.size).toBe(0)
  })

  it('builds the source concepts from the export, keeping ids consistent', () => {
    // Both the STCM rows and the source concepts come from the one CSV, so the
    // id used in each cannot drift apart.
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_123 },
    ])
    const reads = sql.match(/read_csv\('mapping\.source_to_concept_map'/g)
    expect(reads).toHaveLength(2)
    expect(sql).toContain('stcm.source_concept_id       AS concept_id')
    expect(sql).toContain('WHERE stcm.source_concept_id > 2000000000')
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

  it('never reads a table the reference does not have', () => {
    // Comments still name the skipped table, so assert on executable lines only.
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const t of ['vocabulary', 'domain', 'concept_class', 'relationship']) {
      expect(code).not.toContain(`vocab.${t}`)
    }
  })

  it('still copies the tables it does have', () => {
    expect(sql).toContain('FROM vocab.concept ')
    expect(sql).toContain('FROM vocab.concept_synonym ')
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

  it('says which parts were skipped', () => {
    expect(sql).toContain('-- Skipped: vocab.vocabulary is not part of this vocabulary reference.')
  })

  it('emits every part when the reference is complete', () => {
    const full = buildVocabularyScript([MAPPING], undefined, [
      ...CORE, 'vocabulary', 'domain', 'concept_class', 'relationship',
    ])
    expect(full).toContain('FROM vocab.vocabulary v')
    expect(full).toContain('FROM vocab.domain d')
    expect(full).not.toContain('-- Skipped:')
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
    const { sql } = buildVocabularyScriptWithIds([MAPPING], undefined, [
      'concept', 'concept_relationship', 'concept_ancestor', 'concept_synonym',
      'vocabulary', 'domain', 'concept_class', 'relationship',
    ])
    expect(sql).not.toContain('DELETE FROM')
    for (const table of [
      'source_to_concept_map', 'concept', 'concept_relationship', 'concept_ancestor',
      'vocabulary', 'domain', 'concept_class', 'relationship', 'concept_synonym',
    ]) {
      expect(sql).toContain(`TRUNCATE target.${table};`)
    }
  })
})
