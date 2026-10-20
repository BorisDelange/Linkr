import { describe, it, expect } from 'vitest'
import { fuzzyTextMatch, buildFuzzySearchSql, buildLabelFilterSql, labelMatcher, JW_FUZZY_THRESHOLD, JW_FILTER_THRESHOLD } from './fuzzy-search'
import labelFixture from './label-filter.fixture.json'

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

describe('buildLabelFilterSql', () => {
  it('folds every word, and falls back on the whole term only when none matches', () => {
    const sql = buildLabelFilterSql("note  d'évol", 'concept_name', 'concepts')!
    expect(sql).toContain("contains(strip_accents(LOWER(concept_name)), strip_accents(LOWER('note')))")
    expect(sql).toContain("strip_accents(LOWER('d''évol'))")
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM concepts _lf WHERE contains(strip_accents(LOWER(_lf.concept_name))')
    expect(sql).toContain(`jaro_winkler_similarity(strip_accents(LOWER(concept_name)), strip_accents(LOWER('note d''évol'))) >= ${JW_FILTER_THRESHOLD}`)
  })

  it('takes % and _ literally, as labelMatcher does', () => {
    const sql = buildLabelFilterSql('100% a_b', 'concept_name', 'concepts')!
    expect(sql).not.toContain('LIKE')
    expect(sql).toContain("strip_accents(LOWER('100%'))")
    expect(sql).toContain("strip_accents(LOWER('a_b'))")
  })

  it('qualifies the row being filtered, not the subquery', () => {
    const sql = buildLabelFilterSql('x', 'concept_name', 'linkr_concept_concept', 'c')!
    expect(sql).toContain('LOWER(c.concept_name)')
    expect(sql).toContain('FROM linkr_concept_concept _lf WHERE contains(strip_accents(LOWER(_lf.concept_name))')
  })

  it('is no filter for a blank term', () => {
    expect(buildLabelFilterSql('  ', 'concept_name', 'concepts')).toBeNull()
  })

  // The Python twin (label_filter_sql, test_label_filter.py) checks the same
  // strings and runs them on DuckDB over the fixture rows.
  it.each(labelFixture.sqlCases)('emits the SQL the server twin emits for "$term"', (c) => {
    expect(buildLabelFilterSql(c.term, c.column, c.from, 'alias' in c ? c.alias : undefined)).toBe(c.sql)
  })
})

describe('labelMatcher', () => {
  const rows = ["Note d'évolution", 'Antécédents', 'Antecedents medicaux', 'Conclusion']
  const keep = (term: string, opts?: { typos?: boolean }) => rows.filter(labelMatcher(rows, (r) => r, term, opts))

  it('keeps every row for a blank term', () => {
    expect(keep('  ')).toEqual(rows)
  })

  it('needs every word, in any order, accents and case aside', () => {
    expect(keep('EVOLUTION note')).toEqual(["Note d'évolution"])
    expect(keep('antecedents')).toEqual(['Antécédents', 'Antecedents medicaux'])
  })

  it('falls back on names close to the term only when none holds its words', () => {
    expect(keep('antecedant')).toEqual(['Antécédents', 'Antecedents medicaux'])
    expect(keep('antecedant', { typos: false })).toEqual([])
  })

  it.each(labelFixture.filterCases)('keeps the rows the SQL keeps on DuckDB for "$term"', ({ term, expected }) => {
    const all = labelFixture.rows
    expect(all.filter(labelMatcher(all, (r) => r, term))).toEqual(expected)
  })
})
