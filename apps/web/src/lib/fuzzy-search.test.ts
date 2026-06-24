import { describe, it, expect } from 'vitest'
import { fuzzyTextMatch, buildFuzzySearchSql, JW_FUZZY_THRESHOLD } from './fuzzy-search'

describe('fuzzyTextMatch', () => {
  it('matches exactly', () => {
    expect(fuzzyTextMatch('plaquettes', 'plaquettes')).toBe(true)
  })

  it('is accent- and case-insensitive', () => {
    expect(fuzzyTextMatch('Fréquence Cardiaque', 'frequence cardiaque')).toBe(true)
  })

  it('matches on prefix', () => {
    expect(fuzzyTextMatch('plaquettes', 'plaq')).toBe(true)
  })

  it('matches when every query word appears as a substring', () => {
    expect(fuzzyTextMatch('hémoglobine glyquée', 'glyquee hemoglobine')).toBe(true)
  })

  it('tolerates a typo via Jaro-Winkler', () => {
    expect(fuzzyTextMatch('plaquettes', 'plquettes')).toBe(true)
  })

  it('rejects an unrelated term', () => {
    expect(fuzzyTextMatch('plaquettes', 'créatinine')).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(fuzzyTextMatch('anything', '   ')).toBe(true)
  })

  it('null/undefined value never matches a non-empty query', () => {
    expect(fuzzyTextMatch(null, 'x')).toBe(false)
    expect(fuzzyTextMatch(undefined, 'x')).toBe(false)
  })
})

describe('buildFuzzySearchSql', () => {
  it('returns null for an empty term', () => {
    expect(buildFuzzySearchSql('   ', { nameColumn: 'concept_name' })).toBeNull()
  })

  it('escapes single quotes in the term (injection guard)', () => {
    const sql = buildFuzzySearchSql("O'Brien", { nameColumn: 'concept_name' })
    expect(sql).not.toBeNull()
    // The doubled quote must appear; a bare unescaped quote must not break out.
    expect(sql!.where).toContain("O''Brien")
  })

  it('includes a numeric id tier (tier 0) only when the term is numeric and idColumn is set', () => {
    const numeric = buildFuzzySearchSql('123', {
      nameColumn: 'concept_name',
      idColumn: 'concept_id',
    })
    expect(numeric!.tierClauses.some((c) => c.tier === 0)).toBe(true)

    const text = buildFuzzySearchSql('abc', {
      nameColumn: 'concept_name',
      idColumn: 'concept_id',
    })
    expect(text!.tierClauses.some((c) => c.tier === 0)).toBe(false)
  })

  it('adds a code tier (tier 1) only when codeColumn is provided', () => {
    const withCode = buildFuzzySearchSql('abc', {
      nameColumn: 'concept_name',
      codeColumn: 'concept_code',
    })
    expect(withCode!.tierClauses.some((c) => c.tier === 1)).toBe(true)

    const withoutCode = buildFuzzySearchSql('abc', { nameColumn: 'concept_name' })
    expect(withoutCode!.tierClauses.some((c) => c.tier === 1)).toBe(false)
  })

  it('references the table alias when provided', () => {
    const sql = buildFuzzySearchSql('abc', { nameColumn: 'concept_name', alias: 'd' })
    expect(sql!.where).toContain('d.concept_name')
  })

  it('embeds the tuned JW threshold in the fuzzy tier', () => {
    const sql = buildFuzzySearchSql('abc', { nameColumn: 'concept_name' })
    expect(sql!.where).toContain(String(JW_FUZZY_THRESHOLD))
  })
})
