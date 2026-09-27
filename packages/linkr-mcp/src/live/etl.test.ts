import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import { resolveRolePrefixes } from '@/lib/duckdb/role-prefix'
import type { EtlRunHistoryEntry } from '@/types'
import {
  etlRoles, findByPath, formatRun, isInside, locatePath, mappingDataOf, normalizePath, pipelineScripts, pruneMarks,
  renameMarks, reorderPatch, reservedNameReason, serverRoleSchemas, type TreeFile,
} from './etl.js'
import { subtreeIds } from './helpers.js'
import { registerEtlTools } from './tools-etl.js'

const node = (id: string, name: string, parentId: string | null, extra: Partial<TreeFile> = {}): TreeFile => ({
  id, name, parentId, type: 'file', order: 0, ...extra,
})

const tree: TreeFile[] = [
  node('m', 'mapping', null, { type: 'folder', order: -2 }),
  node('csv', 'concept.csv', 'm', { content: 'a,b\n1,2' }),
  node('v', '00_vocabulary.sql', null, { language: 'sql', order: -1, content: 'SELECT 1' }),
  node('p', '10_person.sql', null, { language: 'sql', order: 1, content: 'SELECT 2' }),
  node('o', '20_obs.sql', null, { language: 'sql', order: 1, content: 'SELECT 3', disabled: true }),
  node('md', 'notes.md', null, { language: 'markdown', order: 5 }),
]

describe('tree paths', () => {
  it('finds nodes by path and plans the folders a new path needs', () => {
    expect(findByPath(tree, 'mapping/concept.csv')?.id).toBe('csv')
    expect(locatePath(tree, 'mapping/new/x.csv')).toEqual({ parentId: 'm', missing: ['new'], name: 'x.csv' })
    expect(locatePath(tree, '/a.sql/')).toEqual({ parentId: null, missing: [], name: 'a.sql' })
    expect(() => locatePath(tree, '10_person.sql/x.sql')).toThrow(/is a file/)
  })

  it('refuses empty, dot and dot-dot segments', () => {
    expect(normalizePath(' a//b/ ')).toBe('a/b')
    expect(() => normalizePath('a/../b')).toThrow()
    expect(() => normalizePath('/')).toThrow()
  })

  it('reserves README / LICENSE at the root only, and the pipeline manifests', () => {
    expect(reservedNameReason('README.md', true, false)).toBeTruthy()
    expect(reservedNameReason('README.md', false, false)).toBeNull()
    expect(reservedNameReason('_tree.json', false, true)).toBeTruthy()
    expect(reservedNameReason('10_x.sql', true, true)).toBeNull()
  })

  it('deletes a folder with its subtree, children first; a folder cannot move into itself', () => {
    expect(subtreeIds(tree, 'm')).toEqual(['csv', 'm'])
    expect(isInside(tree, 'm', 'm')).toBe(true)
    expect(isInside(tree, null, 'm')).toBe(false)
  })
})

describe('versioning marks', () => {
  it('follows a rename, subtree included, and drops marks of deleted files', () => {
    const config = { excludedFiles: ['mapping/concept.csv', 'x.sql'], versionedDataFiles: [] }
    expect(renameMarks(config, 'mapping', 'exports')?.excludedFiles).toEqual(['exports/concept.csv', 'x.sql'])
    expect(renameMarks(config, 'other.sql', 'y.sql')).toBeNull()
    expect(pruneMarks(config, tree)?.excludedFiles).toEqual(['mapping/concept.csv'])
    expect(pruneMarks({ excludedFiles: ['notes.md'] }, tree)).toBeNull()
  })
})

describe('running a pipeline', () => {
  it('runs SQL scripts by order, ties broken by name, disabled ones kept for the runner to skip', () => {
    expect(pipelineScripts(tree).map((f) => f.id)).toEqual(['v', 'p', 'o'])
    expect(reorderPatch([{ id: 'p', order: 1 }, { id: 'v', order: -1 }])).toEqual(new Map([['p', 0], ['v', 1]]))
  })

  it('sends the mapping exports the pipeline holds', () => {
    expect(mappingDataOf(tree)).toEqual({ concept: 'a,b\n1,2' })
  })

  it('resolves role prefixes to the attached roles on a managed target', () => {
    const ids = { sourceId: 'S', targetId: 'T', vocabId: 'V' }
    const schemas = serverRoleSchemas(ids, true, 'T')
    expect(resolveRolePrefixes('INSERT INTO target.person SELECT * FROM source.p', schemas))
      .toBe('INSERT INTO "target".person SELECT * FROM "source".p')
    expect(etlRoles(ids)).toEqual({ source: 'S', vocab: 'V' })
    expect(etlRoles({ sourceId: 'T', targetId: 'T' })).toEqual({})
  })

  it('without a managed target, only the database queried is reachable, unqualified', () => {
    const schemas = serverRoleSchemas({ sourceId: 'S', targetId: 'T' }, false, 'S')
    expect(resolveRolePrefixes('SELECT * FROM source.p JOIN target.q', schemas)).toBe('SELECT * FROM p JOIN target.q')
  })

  it('formats a run with each script by path', () => {
    const run: EtlRunHistoryEntry = {
      id: 'run-1', pipelineId: 'x', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', status: 'error',
      scripts: [
        { id: 'l1', pipelineId: 'x', fileId: 'v', status: 'success', durationMs: 1200, output: '3 rows in 1.2s' },
        { id: 'l2', pipelineId: 'x', fileId: 'p', status: 'error', error: 'Catalog Error' },
      ],
    }
    const out = formatRun(run, tree)
    expect(out).toContain('00_vocabulary.sql: success in 1.2s — 3 rows in 1.2s')
    expect(out).toContain('10_person.sql: error\n      error: Catalog Error')
  })
})

describe('registration', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerEtlTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
