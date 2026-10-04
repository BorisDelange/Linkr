import { describe, expect, it } from 'vitest'
import { aliasKey, ensureUniqueAlias, isAliasTaken } from './alias'

// Same cases as test_alias_key_matches_the_frontend (apps/api/tests/test_data_source_alias.py).
describe('aliasKey', () => {
  it('compares aliases as the catalog DuckDB mounts, case-insensitive', () => {
    expect(aliasKey('My-DB')).toBe('my_db')
    expect(aliasKey('my_db')).toBe('my_db')
    expect(aliasKey('MIMIC')).toBe('mimic')
    expect(aliasKey('a.b c')).toBe('a_b_c')
  })
})

describe('ensureUniqueAlias', () => {
  it('treats an alias differing only by case or punctuation as taken', () => {
    expect(isAliasTaken('My-DB', ['my_db'])).toBe(true)
    expect(ensureUniqueAlias('mimic', ['MIMIC'])).toBe('mimic_2')
    expect(ensureUniqueAlias('my_db', ['My-DB', 'MY_DB_2'])).toBe('my_db_3')
    expect(ensureUniqueAlias('omop', ['mimic'])).toBe('omop')
  })
})
