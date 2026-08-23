import { describe, expect, it } from 'vitest'
import { sanitizeConnectionConfig } from './entity-io'

/**
 * What a published database export may contain. These assertions are the
 * security boundary itself: a workspace export can be pushed to a public git
 * repo and indexed by the catalog, so anything that survives this function is
 * world-readable.
 */
describe('sanitizeConnectionConfig', () => {
  const full = {
    engine: 'postgres',
    host: 'db.chu-rennes.fr',
    port: 5432,
    database: 'omop_prod',
    schema: 'cdm',
    username: 'bdelange',
    password: 'hunter2',
    token: 'ghp_deadbeef',
    baseUrl: 'https://fhir.example.org',
    authType: 'bearer',
    fileId: 'f1',
    fileIds: ['f1', 'f2'],
    fileNames: ['patients.parquet'],
    fileHandleIds: ['h1'],
  }

  it('keeps only the engine out of a full connection', () => {
    expect(sanitizeConnectionConfig(full)).toEqual({ engine: 'postgres' })
  })

  it('leaks no credential, host or file reference', () => {
    const out = JSON.stringify(sanitizeConnectionConfig(full))
    for (const secret of [
      'hunter2', 'ghp_deadbeef', 'bdelange',
      'db.chu-rennes.fr', '5432', 'omop_prod', 'cdm',
      'fhir.example.org', 'bearer',
      'f1', 'f2', 'patients.parquet', 'h1',
    ]) {
      expect(out).not.toContain(secret)
    }
  })

  it('withholds an unknown field — the allowlist is the point', () => {
    // A denylist would publish every one of these. Should a future config need
    // one, it has to be added to EXPORTED_CONNECTION_KEYS deliberately.
    const out = sanitizeConnectionConfig({
      engine: 'postgres',
      sslCert: '-----BEGIN CERTIFICATE-----',
      dsn: 'postgres://user:pw@host/db',
      apiKey: 'sk-live-1234',
      connectionString: 'Server=x;Password=y',
    })
    expect(out).toEqual({ engine: 'postgres' })
  })

  it('keeps the structural flags, which address nothing', () => {
    expect(sanitizeConnectionConfig({ engine: 'duckdb', inMemory: true, managed: false }))
      .toEqual({ engine: 'duckdb', inMemory: true, managed: false })
  })

  it('drops null and undefined so both builders emit the same bytes', () => {
    // JSON.stringify keeps an explicit null; the Python builder drops it.
    expect(sanitizeConnectionConfig({ engine: 'duckdb', inMemory: null, managed: undefined }))
      .toEqual({ engine: 'duckdb' })
  })

  it('emits keys in allowlist order, not input order', () => {
    const out = sanitizeConnectionConfig({ managed: true, inMemory: true, engine: 'duckdb' })
    expect(Object.keys(out)).toEqual(['engine', 'inMemory', 'managed'])
  })

  it('returns an empty object for an empty config', () => {
    expect(sanitizeConnectionConfig({})).toEqual({})
  })
})
