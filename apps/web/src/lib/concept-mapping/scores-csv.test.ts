import { describe, it, expect } from 'vitest'
import {
  csvPathForMethod,
  csvSelectList,
  csvToScoresSelect,
  isScoresCsv,
  methodCsvCopySql,
  methodForCsvPath,
  scoreCsvsInTree,
  versionedMethodsValue,
} from './scores-csv'

describe('csvPathForMethod / methodForCsvPath', () => {
  it('maps a method onto its versioned CSV and back', () => {
    expect(csvPathForMethod('ai/claude-opus-4-8')).toBe('similarity-scores/ai/claude-opus-4-8.csv')
    expect(methodForCsvPath('similarity-scores/ai/claude-opus-4-8.csv')).toBe('ai/claude-opus-4-8')
    expect(csvPathForMethod('syntactic/jaro-winkler')).toBe('similarity-scores/syntactic/jaro-winkler.csv')
  })

  // The method becomes a path in a git tree the server unpacks: anything a
  // filesystem would reinterpret must stay out.
  it('refuses a method that cannot be a plain path', () => {
    for (const bad of ['../etc', 'ai/..', 'ai//x', '.hidden', 'ai/.x', 'a b', 'ai\\x', '', 'ai\n', 'ai/x\n']) {
      expect(csvPathForMethod(bad), bad).toBeNull()
    }
  })

  it('reads only its own folder and extension', () => {
    expect(methodForCsvPath('similarity-scores.parquet')).toBeNull()
    expect(methodForCsvPath('source-concepts.csv')).toBeNull()
    expect(methodForCsvPath('similarity-scores/ai/x.parquet')).toBeNull()
    expect(methodForCsvPath('similarity-scores/../x.csv')).toBeNull()
  })

  it('collects the per-method CSVs of a tree, sorted by method', () => {
    const tree = {
      'entity.json': '{}',
      'similarity-scores/semantic/biolord.csv': 'b',
      'similarity-scores/ai/claude-opus-4-8.csv': 'a',
    }
    expect(scoreCsvsInTree(tree)).toEqual([
      { method: 'ai/claude-opus-4-8', content: 'a' },
      { method: 'semantic/biolord', content: 'b' },
    ])
  })
})

describe('isScoresCsv', () => {
  it('tells a scores CSV from the HTML shell a static host serves for a missing path', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    expect(isScoresCsv(enc('source_vocabulary_id,source_concept_code,concept_id,score\nL,1,2,0.5000\n'))).toBe(true)
    expect(isScoresCsv(enc('<!doctype html><html></html>'))).toBe(false)
  })
})

// The SQL is the twin of scores_service.py's: pinned here so an edit on one side
// shows up as a failing test rather than as a false git diff between instances.
describe('scores CSV SQL', () => {
  it('rounds the score and blanks empty optional values', () => {
    expect(csvSelectList(['comment'])).toBe(
      "source_vocabulary_id, source_concept_code, CAST(concept_id AS VARCHAR) AS concept_id, printf('%.4f', score) AS score, NULLIF(CAST(comment AS VARCHAR), '') AS comment",
    )
  })

  it('sorts on the full key and escapes the method literal', () => {
    expect(methodCsvCopySql('s.parquet', "ai/o'brien", [], 'out.csv')).toBe(
      "COPY (SELECT source_vocabulary_id, source_concept_code, CAST(concept_id AS VARCHAR) AS concept_id, printf('%.4f', score) AS score FROM read_parquet('s.parquet') "
      + "WHERE method = 'ai/o''brien' ORDER BY source_vocabulary_id, source_concept_code, concept_id) "
      + "TO 'out.csv' (FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"', NULL '')",
    )
  })

  it('reads a CSV back with the method from its path and NULL for absent columns', () => {
    const sql = csvToScoresSelect('m.csv', 'semantic/biolord', new Set(['source_vocabulary_id', 'equivalence']))
    expect(sql).toContain("'semantic/biolord' AS method")
    expect(sql).toContain('equivalence::VARCHAR AS equivalence')
    expect(sql).toContain('NULL::VARCHAR AS comment')
    expect(sql).toContain("read_csv('m.csv', header=true, all_varchar=true)")
  })
})

describe('versionedMethodsValue', () => {
  // [] would export as a key the manifest never had: a git change out of nothing.
  it('is absent, not empty, when no method is versioned', () => {
    expect(versionedMethodsValue([])).toBeUndefined()
    expect(versionedMethodsValue(new Set(['semantic/biolord', 'ai/x', 'ai/x']))).toEqual(['ai/x', 'semantic/biolord'])
  })
})
