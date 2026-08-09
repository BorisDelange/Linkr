import { describe, expect, it } from 'vitest'
import {
  mappingExportNameOf,
  mappingExportPath,
  resolveMappingRefs,
  STCM_EXPORT,
  usedMappingRefs,
} from './mapping-source'

const resolve = (name: string) =>
  name === STCM_EXPORT ? '/data/etl/p1/mapping/source_to_concept_map.csv' : undefined

describe('resolveMappingRefs', () => {
  it('rewrites the reference to the real file', () => {
    const sql = "SELECT * FROM read_csv('mapping.source_to_concept_map')"
    expect(resolveMappingRefs(sql, resolve))
      .toBe("SELECT * FROM read_csv('/data/etl/p1/mapping/source_to_concept_map.csv')")
  })

  it('accepts a double-quoted reference but always emits a string literal', () => {
    // A double-quoted path would read as an identifier in DuckDB.
    const out = resolveMappingRefs('SELECT * FROM read_csv("mapping.source_to_concept_map")', resolve)
    expect(out).toContain("'/data/etl/p1/mapping/source_to_concept_map.csv'")
    expect(out).not.toContain('"/data')
  })

  it('leaves an unknown export as written, so the error names it', () => {
    const sql = "SELECT * FROM read_csv('mapping.not_exported')"
    expect(resolveMappingRefs(sql, resolve)).toBe(sql)
  })

  it('escapes a quote in the resolved path', () => {
    const out = resolveMappingRefs(
      "read_csv('mapping.x')",
      () => "/tmp/o'brien/x.csv",
    )
    expect(out).toBe("read_csv('/tmp/o''brien/x.csv')")
  })

  it('does not touch a schema qualifier of the same shape', () => {
    // `mapping.` outside a literal is not a mapping export; only the quoted form
    // is, which is what keeps this separate from the role prefixes.
    const sql = 'SELECT * FROM mapping.source_to_concept_map'
    expect(resolveMappingRefs(sql, resolve)).toBe(sql)
  })

  it('rewrites every occurrence', () => {
    const sql = "read_csv('mapping.source_to_concept_map') UNION read_csv('mapping.source_to_concept_map')"
    expect(resolveMappingRefs(sql, resolve).match(/\/data\//g)).toHaveLength(2)
  })
})

describe('usedMappingRefs', () => {
  it('lists the exports a script needs', () => {
    expect(usedMappingRefs("read_csv('mapping.source_to_concept_map')")).toEqual([STCM_EXPORT])
  })

  it('deduplicates and ignores unquoted lookalikes', () => {
    const sql = "read_csv('mapping.a') read_csv('mapping.a') FROM mapping.b"
    expect(usedMappingRefs(sql)).toEqual(['a'])
  })

  it('returns nothing for a script with no mapping data', () => {
    expect(usedMappingRefs('SELECT * FROM vocab.concept')).toEqual([])
  })
})

describe('mappingExportPath', () => {
  it('places exports in a folder of their own', () => {
    expect(mappingExportPath(STCM_EXPORT)).toBe('mapping/source_to_concept_map.csv')
  })
})

describe('mappingExportNameOf', () => {
  it('round-trips with mappingExportPath', () => {
    expect(mappingExportNameOf(mappingExportPath(STCM_EXPORT))).toBe(STCM_EXPORT)
  })

  it('ignores a file outside the mapping folder', () => {
    expect(mappingExportNameOf('00_vocabulary.sql')).toBeUndefined()
    expect(mappingExportNameOf('data/source_to_concept_map.csv')).toBeUndefined()
  })

  it('ignores a nested path, so only direct exports count', () => {
    expect(mappingExportNameOf('mapping/sub/x.csv')).toBeUndefined()
  })

  it('ignores a non-CSV file in the mapping folder', () => {
    expect(mappingExportNameOf('mapping/notes.md')).toBeUndefined()
  })
})
