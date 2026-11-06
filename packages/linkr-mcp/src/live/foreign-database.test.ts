import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCatalogVariables } from '@/lib/data-catalog/config'
import { captureTools } from './gateway'
import { registerDqTools } from './tools-dq'
import { registerEtlTools } from './tools-etl'
import { registerWikiTools } from './tools-wiki'
import { ApiError, LinkrApi } from './api'

const HERE = 'ws-here'
const database = (workspaceId: string) => ({
  id: 'db1', workspaceId, status: 'connected', name: { en: 'D' },
  schemaMapping: { formatVersion: 2, patient: { from: { table: 'person', alias: 'p' }, fields: { patient_id: 'p.person_id' } } },
})
const ruleSet = { id: 'rs', workspaceId: HERE, dataSourceId: 'db1', name: { en: 'R' }, status: 'draft' }
const check = {
  id: 'c1', ruleSetId: 'rs', name: 'C', description: '', category: 'plausibility', subcategory: 'atemporal', severity: 'warning',
  threshold: 0, sql: 'SELECT 0 AS violated_rows, 1 AS total_rows', exploreSql: null, order: 0, origin: 'manual', disabled: false,
}
const catalog = {
  id: 'cat', workspaceId: HERE, dataSourceId: 'db1', name: { en: 'C' }, status: 'draft', updatedAt: '2020-01-01T00:00:00Z',
  anonymization: { threshold: 5, mode: 'replace' }, variables: defaultCatalogVariables(), crossings: [],
}

/** Every call the tool makes, answered from the fixtures; a query answers an empty result. */
function fakeApi(dbWorkspace: string) {
  const calls: { method: string; path: string }[] = []
  vi.spyOn(LinkrApi.prototype, 'request').mockImplementation((async (method: string, path: string) => {
    calls.push({ method, path })
    if (path.includes('/query')) return { rows: [{ violated_rows: 0, total_rows: 1 }] }
    if (path.startsWith('/data-sources/')) return database(dbWorkspace)
    if (path.endsWith('/checks')) return [check]
    if (path.startsWith('/dq-rule-sets/rs')) return ruleSet
    if (path.startsWith('/data-catalogs/cat')) return path.includes('results') ? null : catalog
    return {}
  }) as never)
  return calls
}

const queries = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path.includes('/query'))
const tool = (name: string) => {
  const found = captureTools('t', [registerDqTools, registerWikiTools, registerEtlTools]).find((t) => t.name === name)
  if (!found) throw new Error(name)
  return found
}
const run = (name: string, args: unknown) => tool(name).handler(args)
const words = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

afterEach(() => vi.restoreAllMocks())

describe('a stored database of another workspace', () => {
  it('runs no query for a rule set, however it is asked', async () => {
    const calls = fakeApi('ws-elsewhere')
    const runs = [
      await run('run_dq_rule_set', { rule_set_id: 'rs' }),
      await run('investigate_dq_check', { rule_set_id: 'rs', check_id: 'c1' }),
      await run('test_dq_check', { rule_set_id: 'rs', check_id: 'c1' }),
    ]
    for (const r of runs) {
      expect(r.isError).toBe(true)
      expect(words(r)).toMatch(/another workspace/)
    }
    expect(queries(calls)).toEqual([])
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('runs no query for a catalog, whether computing it or listing its options', async () => {
    const calls = fakeApi('ws-elsewhere')
    const computed = await run('compute_data_catalog', { catalog_id: 'cat' })
    expect(computed.isError).toBe(true)
    expect(words(computed)).toMatch(/another workspace/)
    const described = await run('get_data_catalog', { catalog_id: 'cat', options: true })
    expect(words(described)).toMatch(/another workspace/)
    expect(queries(calls)).toEqual([])
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('still runs a rule set on a database of its own workspace', async () => {
    const calls = fakeApi(HERE)
    await run('run_dq_rule_set', { rule_set_id: 'rs', record: false })
    expect(queries(calls).length).toBeGreaterThan(0)
  })

  it('runs no script when the server refuses to record the run', async () => {
    const calls: { method: string; path: string }[] = []
    const node = { id: 'n', pipelineId: 'p', name: 'a.sql', type: 'file', content: 'SELECT 1', language: 'sql', order: 0, dataSourceId: null, disabled: false, parentId: null }
    vi.spyOn(LinkrApi.prototype, 'request').mockImplementation((async (method: string, path: string) => {
      calls.push({ method, path })
      if (method === 'POST' && path === '/etl-runs') throw new ApiError(409, 'This entity points at a database of another workspace')
      if (path.endsWith('/files')) return [node]
      if (path.endsWith('/runs') || path.includes('etl-runs')) return []
      if (path.startsWith('/etl-pipelines/')) return { id: 'p', workspaceId: HERE, targetDataSourceId: 'db1', sourceDataSourceId: null, name: { en: 'P' } }
      if (path.startsWith('/data-sources')) return path === '/data-sources' ? [database('ws-elsewhere')] : database('ws-elsewhere')
      return {}
    }) as never)
    const r = await run('run_etl_pipeline', { pipeline_id: 'p' })
    expect(r.isError).toBe(true)
    expect(calls.filter((c) => c.path.includes('/etl-run') && !c.path.includes('/etl-runs') || c.path.includes('/query'))).toEqual([])
  })
})
