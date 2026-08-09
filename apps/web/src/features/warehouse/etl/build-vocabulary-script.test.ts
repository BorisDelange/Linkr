import { describe, expect, it } from 'vitest'
import {
  athenaSelectList,
  buildCustomVocabularyScript,
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
      expect(sql).not.toMatch(new RegExp(`DELETE FROM ${table}\\b`))
      expect(sql).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`))
      expect(sql).not.toMatch(new RegExp(`UPDATE ${table}\\b`))
    }
    expect(sql).toContain('DELETE FROM target.concept;')
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
  it('writes the stored id into source_to_concept_map, not 0', () => {
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_042 },
    ])
    expect(sql).toContain("('50983', 2000000042,")
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

  it('inserts the source concept with the same id it wrote in the STCM', () => {
    const { sql } = buildVocabularyScriptWithIds([
      { ...MAPPING, sourceConceptId: 2_000_000_123 },
    ])
    expect(sql).toContain('(2000000123,')
    expect(sql).toContain("('50983', 2000000123,")
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
    expect(sql).toContain('DELETE FROM target.vocabulary;')
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
