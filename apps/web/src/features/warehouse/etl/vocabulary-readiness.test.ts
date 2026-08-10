import { describe, expect, it } from 'vitest'
import { vocabularyReadiness, type VocabFile } from './vocabulary-readiness'

const STCM_REF = `INSERT INTO target.source_to_concept_map
SELECT * FROM read_csv('mapping.source_to_concept_map', header = true);`

const file = (
  name: string,
  content?: string,
  extra: Partial<VocabFile> = {},
): VocabFile => ({
  id: extra.parentId ? `${extra.parentId}/${name}` : name,
  name,
  type: 'file',
  parentId: null,
  content,
  ...extra,
})

const folder = (name: string): VocabFile => ({
  id: name,
  name,
  type: 'folder',
  parentId: null,
})

const CSV_WITH_ROWS = 'source_code,source_concept_id\nABC,2000000001\n'

describe('vocabularyReadiness', () => {
  it('reports the export a git-imported pipeline is missing', () => {
    // The exact case: the script travels through git, the CSV is gitignored.
    const result = vocabularyReadiness([file('00_vocabulary.sql', STCM_REF, { language: 'sql' })])
    expect(result.missingExports).toEqual(['source_to_concept_map'])
    expect(result.usesExports).toBe(true)
    expect(result.ready).toBe(false)
  })

  it('is ready when the export sits at mapping/<name>.csv with rows', () => {
    const result = vocabularyReadiness([
      file('00_vocabulary.sql', STCM_REF, { language: 'sql' }),
      folder('mapping'),
      file('source_to_concept_map.csv', CSV_WITH_ROWS, { parentId: 'mapping' }),
    ])
    expect(result).toMatchObject({ missingExports: [], emptyExports: [], ready: true })
  })

  it('flags a header-only export separately from a missing one', () => {
    // Regenerating with every status unchecked yields a header row and nothing
    // else: the script succeeds and leaves source_to_concept_map empty, so the
    // real failure surfaces much later as unmapped data.
    const result = vocabularyReadiness([
      file('00_vocabulary.sql', STCM_REF, { language: 'sql' }),
      folder('mapping'),
      file('source_to_concept_map.csv', 'source_code,source_concept_id\n', { parentId: 'mapping' }),
    ])
    expect(result.missingExports).toEqual([])
    expect(result.emptyExports).toEqual(['source_to_concept_map'])
    expect(result.ready).toBe(false)
  })

  it('treats a CSV holding only blank lines after the header as empty', () => {
    const result = vocabularyReadiness([
      file('00_vocabulary.sql', STCM_REF, { language: 'sql' }),
      folder('mapping'),
      file('source_to_concept_map.csv', 'a,b\n\n  \n', { parentId: 'mapping' }),
    ])
    expect(result.emptyExports).toEqual(['source_to_concept_map'])
  })

  it('is ready when no script reads an export at all', () => {
    const result = vocabularyReadiness([
      file('01_person.sql', 'INSERT INTO target.person SELECT * FROM source.patients;', {
        language: 'sql',
      }),
    ])
    expect(result).toMatchObject({ usesExports: false, ready: true })
  })

  it('ignores a disabled script, which a run leaves out anyway', () => {
    const result = vocabularyReadiness([
      file('00_vocabulary.sql', STCM_REF, { language: 'sql', disabled: true }),
    ])
    expect(result).toMatchObject({ missingExports: [], usesExports: false, ready: true })
  })

  it('generalises to any mapping export, not just the STCM one', () => {
    const result = vocabularyReadiness([
      file('05_units.sql', `SELECT * FROM read_csv('mapping.units');`, { language: 'sql' }),
      folder('mapping'),
      file('source_to_concept_map.csv', CSV_WITH_ROWS, { parentId: 'mapping' }),
    ])
    expect(result.missingExports).toEqual(['units'])
  })

  it('reports several missing exports sorted, deduped across scripts', () => {
    const result = vocabularyReadiness([
      file('a.sql', `read_csv('mapping.units')`, { language: 'sql' }),
      file('b.sql', `read_csv('mapping.units') , read_csv('mapping.source_to_concept_map')`, {
        language: 'sql',
      }),
    ])
    expect(result.missingExports).toEqual(['source_to_concept_map', 'units'])
  })

  it('does not scan non-SQL files, where mapping. is not the rewritten form', () => {
    const result = vocabularyReadiness([
      file('load.py', `df = read("mapping.source_to_concept_map")`, { language: 'python' }),
    ])
    expect(result).toMatchObject({ usesExports: false, ready: true })
  })

  it('recognises a .sql file even when language is unset', () => {
    const result = vocabularyReadiness([file('00_vocabulary.sql', STCM_REF)])
    expect(result.missingExports).toEqual(['source_to_concept_map'])
  })

  it('does not treat a CSV outside mapping/ as an export', () => {
    const result = vocabularyReadiness([
      file('00_vocabulary.sql', STCM_REF, { language: 'sql' }),
      file('source_to_concept_map.csv', CSV_WITH_ROWS),
    ])
    expect(result.missingExports).toEqual(['source_to_concept_map'])
  })
})
