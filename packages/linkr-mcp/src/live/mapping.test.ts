import { describe, expect, it } from 'vitest'
import {
  checkJudgement, checkTarget, describeInfo, describeSourceRow, groupSuggestions, indexKeyToSourceKey, infoSummary, mappingPayload,
  methodForModel, sourceByCodesSql, synonymSearchSql, type VocabConcept,
} from './mapping'
import type { ScoreRow } from './api'

describe('methodForModel', () => {
  it('slugs the model name under ai/', () => {
    expect(methodForModel('Qwen3 235B (OpenRouter)')).toBe('ai/qwen3-235b-openrouter')
    expect(methodForModel('claude-opus-5-5')).toBe('ai/claude-opus-5-5')
    expect(methodForModel('  ')).toBe('ai/unknown')
  })
})

describe('indexKeyToSourceKey', () => {
  it('turns vocabulary::code into the SQL filter key', () => {
    expect(indexKeyToSourceKey('REA::Parameter_4599')).toBe('REA\0Parameter_4599')
    expect(indexKeyToSourceKey('::x')).toBe('\0x')
  })
})

describe('infoSummary', () => {
  it('keeps what disambiguates a target: type, unit, range, values, path', () => {
    const info = JSON.stringify({
      full_name: 'Laboratoire / GDS / PaO2', data_types: 'numerical',
      numerical_data: { unit: 'mmHg', min: 20, max: 600.456, median: 88 },
    })
    expect(infoSummary(info)).toBe('numerical · unit mmHg · range 20–600.46, median 88 · path Laboratoire / GDS / PaO2')
    expect(infoSummary({ data_types: 'numeric', unit: 'bpm', numeric_data: { min: 39, median: 90, max: 143, p5: 62, p95: 121 } }))
      .toBe('numeric · unit bpm · range 39–143, median 90, p5–p95 62–121')
    expect(infoSummary({ categorical_data: [{ category: 'Oui' }, { category: 'Non' }] })).toBe('values Oui, Non')
    expect(infoSummary('not json')).toBe('')
    expect(infoSummary(null)).toBe('')
  })
})

describe('describeSourceRow', () => {
  it('shows code, name, category, counts and the metadata line', () => {
    expect(describeSourceRow({
      vocabulary_id: 'REA', concept_code: 'hr', concept_name: 'Fréquence cardiaque', category: 'Vital signs',
      record_count: 1200, patient_count: 40, info_json: '{"numerical_data":{"unit":"bpm"}}',
    }, 'unchecked → 3027018')).toBe(
      '- REA/hr — Fréquence cardiaque [Vital signs] · 1200 records, 40 patients · unchecked → 3027018\n    unit bpm')
  })
})

describe('sourceByCodesSql', () => {
  it('matches on vocabulary and code when the source has vocabularies, else on code', () => {
    expect(sourceByCodesSql([{ code: "a'b", vocabularyId: 'REA' }, { code: 'c' }], true))
      .toBe("SELECT * FROM source_concepts WHERE (vocabulary_id = 'REA' AND concept_code = 'a''b') OR concept_code = 'c'")
    expect(sourceByCodesSql([{ code: 'a', vocabularyId: 'REA' }], false))
      .toBe("SELECT * FROM source_concepts WHERE concept_code = 'a'")
  })
})

describe('synonymSearchSql', () => {
  it('requires every word, escaped, and nothing for an empty term', () => {
    const sql = synonymSearchSql('concept', "heart rat'e", true, 10)!
    expect(sql).toContain("LIKE '%' || strip_accents('heart') || '%'")
    expect(sql).toContain("strip_accents('rat''e')")
    expect(sql).toContain("c.standard_concept = 'S'")
    expect(synonymSearchSql('concept', ' a ', true, 10)).toBeNull()
  })
})

describe('groupSuggestions', () => {
  const row = (concept_id: number, method: string, score: number): ScoreRow => ({
    source_vocabulary_id: 'REA', source_concept_code: 'hr', concept_id, method, score, equivalence: 'skos:exactMatch',
    comment: null, created_at: null, concept_set_uid: null, concept_set_source_repo: null,
  })
  it('groups by target, best target first, best method first', () => {
    const groups = groupSuggestions([row(1, 'syntactic/jaro-winkler', 0.7), row(2, 'semantic/biolord', 0.9), row(1, 'ai/m', 0.8)])
    expect(groups.map((g) => [g.conceptId, g.best])).toEqual([[2, 0.9], [1, 0.8]])
    expect(groups[1].rows.map((r) => r.method)).toEqual(['ai/m', 'syntactic/jaro-winkler'])
  })
})

describe('checkJudgement / checkTarget', () => {
  it('requires a known equivalence, a comment and a 0–1 score', () => {
    expect(checkJudgement({ equivalence: 'skos:closeMatch', comment: 'ok', score: 0.8 }, '#1')).toEqual([])
    expect(checkJudgement({ equivalence: 'close', comment: ' ', score: '1.5' }, '#1')).toEqual([
      expect.stringContaining('equivalence must be one of'),
      '#1: a comment justifying the match is required.',
      '#1: score must be between 0 and 1.',
    ])
  })

  it('refuses unknown, invalid and non-standard targets', () => {
    const c = (over: Partial<VocabConcept>): VocabConcept => ({
      concept_id: 5, concept_name: 'X', vocabulary_id: 'LOINC', standard_concept: 'S', invalid_reason: null, ...over,
    })
    expect(checkTarget(c({}), 5, '#1')).toBeNull()
    expect(checkTarget(undefined, 5, '#1')).toContain('not in the vocabulary')
    expect(checkTarget(c({ invalid_reason: 'U' }), 5, '#1')).toContain('invalid')
    expect(checkTarget(c({ standard_concept: null }), 5, '#1')).toContain('not standard')
  })
})

describe('mappingPayload', () => {
  it('builds the row the app writes, authored so it stays editable', () => {
    const m = mappingPayload({
      id: 'm1', projectId: 'p1', now: '2026-09-24T00:00:00Z', author: 'Jane Doe',
      source: { concept_id: 7, concept_name: 'FC', concept_code: 'hr', vocabulary_id: 'REA', record_count: 12, category: 'Vitals' },
      target: { concept_id: 3027018, concept_name: 'Heart rate', vocabulary_id: 'LOINC', domain_id: 'Measurement', concept_code: '8867-4', concept_class_id: 'Clinical Observation', standard_concept: 'S' },
      equivalence: 'skos:exactMatch', status: 'unchecked', comment: ' Same measurement. ', matchScore: 0.95,
    })
    expect(m).toMatchObject({
      sourceConceptId: 7, sourceVocabularyId: 'REA', sourceConceptCode: 'hr', sourceFrequency: 12, sourceCategoryId: 'Vitals',
      targetConceptId: 3027018, targetVocabularyId: 'LOINC', targetConceptCode: '8867-4', targetStandardConcept: 'S',
      status: 'unchecked', matchScore: 0.95, mappedBy: 'Jane Doe',
      comments: [{ id: 'm1-c0', authorId: 'Jane Doe', text: 'Same measurement.', createdAt: '2026-09-24T00:00:00Z' }],
    })
    const ignored = mappingPayload({
      id: 'm2', projectId: 'p1', now: 'n', author: 'a', source: { concept_code: 'bed' }, target: null,
      equivalence: 'skos:relatedMatch', status: 'ignored', comment: 'Bed identifier.',
    })
    expect([ignored.targetConceptId, ignored.targetConceptName, ignored.status]).toEqual([0, '', 'ignored'])
  })
})

describe('describeInfo', () => {
  it('drops the histogram and cuts to the budget', () => {
    expect(describeInfo({ unit: 'bpm', histogram: [{ x: 1, count: 2 }] })).toBe('{\n "unit": "bpm"\n}')
    expect(describeInfo({ a: 'x'.repeat(50) }, 10)).toMatch(/more characters cut/)
    expect(describeInfo(null)).toBe('(none)')
  })
})
