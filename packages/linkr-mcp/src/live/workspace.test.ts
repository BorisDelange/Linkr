import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { BadgeCategory, CustomSchemaPreset, DataSource, Project, ProjectBadge } from '@/types'
import { registerWorkspaceTools } from './tools-workspace'
import {
  applyTodoChanges, databaseCreateBody, databaseKind, entityIdError, linkRefusal, linkedAfterLink, linkedAfterUnlink,
  nameTaken, newAlias, presetMappingChange, projectCreateBody, projectEntityId, retestUpdate, setBadges,
} from './workspace'

const mapping = { formatVersion: 2, presetId: 'omop', presetLabel: { en: 'OMOP' }, ddl: 'CREATE TABLE person (person_id INT);' }
const preset = (over: Partial<CustomSchemaPreset> = {}): CustomSchemaPreset => ({
  id: 'p1', entityId: 'omop', presetId: 'omop', workspaceId: 'ws', lineageId: 'lin-omop', version: '5.4',
  mapping, createdAt: '', updatedAt: '', ...over,
} as CustomSchemaPreset)
const db = (over: Partial<DataSource> = {}): DataSource => ({
  id: 'd1', alias: 'mimic', name: { en: 'MIMIC' }, description: {}, sourceType: 'database', workspaceId: 'ws',
  status: 'connected', connectionConfig: { engine: 'duckdb', managed: true }, lineageId: 'lin-d1', entityId: 'mimic',
  createdAt: '', updatedAt: '', ...over,
} as DataSource)
const project = (over: Partial<Project> = {}): Project => ({
  uid: 'u1', workspaceId: 'ws', name: { en: 'Sepsis' }, description: {}, shortDescription: {}, config: {}, ownerId: 1,
  createdAt: '', updatedAt: '', ...over,
} as Project)

describe('project identifiers', () => {
  it('validates like the create dialog', () => {
    expect(entityIdError('ok-id', [])).toBeNull()
    expect(entityIdError('a', [])).toMatch(/2 to 50/)
    expect(entityIdError('-bad', [])).toMatch(/lowercase/)
    expect(entityIdError('Bad', [])).toMatch(/lowercase/)
    expect(entityIdError('taken', ['taken'])).toMatch(/another project of this workspace/)
    expect(entityIdError('taken', ['taken'], 'mapping project')).toBe('already used by another mapping project')
  })

  it('derives a unique slug from the name when none is given', () => {
    expect(projectEntityId('Sepsis à l\'ICU', undefined, [])).toEqual({ id: 'sepsis-a-l-icu' })
    expect(projectEntityId('Sepsis', '', ['sepsis'])).toEqual({ id: 'sepsis-2' })
    expect(projectEntityId('日本', undefined, [])).toEqual({ id: 'entity' })
    expect(projectEntityId('x', 'NOPE', [])).toHaveProperty('error')
  })

  it('builds the addProject body', () => {
    const body = projectCreateBody({
      uid: 'u', lineageId: 'l', workspaceId: 'ws', entityId: 'e', name: 'N', lang: 'fr', status: 'active',
    })
    expect(body).toMatchObject({
      uid: 'u', entityId: 'e', projectId: 'e', workspaceId: 'ws', name: { fr: 'N' }, description: { fr: '' },
      shortDescription: {}, config: {}, lineageId: 'l', version: '0.1.0',
    })
    expect(body).not.toHaveProperty('status')
    expect(projectCreateBody({ uid: 'u', lineageId: 'l', workspaceId: 'ws', entityId: 'e', name: 'N', lang: 'en', status: 'draft' }))
      .toHaveProperty('status', 'draft')
  })
})

describe('badges', () => {
  const categories: BadgeCategory[] = [{ id: 'c', name: { en: 'Source' }, color: 'green', exclusive: true }]
  let n = 0
  const id = () => `b${++n}`

  it('keeps existing badges, adds new ones in their category colour, one value per exclusive category', () => {
    const existing: ProjectBadge[] = [{ id: 'keep', label: { en: 'ICU' }, color: 'red' }]
    const out = setBadges(existing, [{ label: 'icu' }, { label: 'Source::MIMIC' }, { label: 'Source::eICU' }, { label: 'x', color: 'amber' }],
      categories, 'en', id)
    expect(out.map((b) => [b.id === 'keep', b.color])).toEqual([[true, 'red'], [false, 'green'], [false, 'amber']])
    expect(out[1].label).toEqual({ en: 'Source::eICU' })
  })
})

describe('tasks', () => {
  const todos = [{ id: 't-1', text: { en: 'a' }, done: false }, { id: 't-2', text: { en: 'b' }, done: true }]

  it('adds, completes, reopens, renames and removes', () => {
    const r = applyTodoChanges(todos, { add: ['c', ' '], done: ['t-1'], undone: ['t-2'], rename: [{ id: 't-1', text: 'A' }] }, 'fr', 100)
    if ('error' in r) throw new Error(r.error)
    expect(r.todos).toEqual([
      { id: 't-1', text: { en: 'a', fr: 'A' }, done: true },
      { id: 't-2', text: { en: 'b' }, done: false },
      { id: 't-100', text: { fr: 'c' }, done: false },
    ])
    const removed = applyTodoChanges(todos, { remove: ['t-2'] }, 'en', 0)
    expect('todos' in removed && removed.todos.map((t) => t.id)).toEqual(['t-1'])
  })

  it('refuses unknown ids', () => {
    expect(applyTodoChanges(todos, { done: ['nope'] }, 'en', 0)).toHaveProperty('error')
  })
})

describe('linking', () => {
  it('appends the id and its portable pointer, index-aligned', () => {
    const p = project({ linkedDataSourceIds: ['a', 'b'], linkedDataSourceRefs: [{ lineageId: 'la' }] as never })
    const out = linkedAfterLink(p, [db()], 'd1')
    expect(out).toEqual({
      linkedDataSourceIds: ['a', 'b', 'd1'],
      linkedDataSourceRefs: [{ lineageId: 'la' }, {}, { lineageId: 'lin-d1', entityId: 'mimic', label: { en: 'MIMIC' } }],
    })
    expect(linkedAfterLink(project({ linkedDataSourceIds: ['d1'] }), [db()], 'd1')).toBeNull()
  })

  it('drops the unlinked database\'s pointer only', () => {
    const p = project({ linkedDataSourceIds: ['a', 'b', 'c'], linkedDataSourceRefs: [{ entityId: 'a' }, { entityId: 'b' }, { entityId: 'c' }] as never })
    expect(linkedAfterUnlink(p, 'b')).toEqual({
      linkedDataSourceIds: ['a', 'c'], linkedDataSourceRefs: [{ entityId: 'a' }, { entityId: 'c' }],
    })
    expect(linkedAfterUnlink(p, 'z')).toBeNull()
  })

  it('refuses vocabulary references and other workspaces\' databases', () => {
    expect(linkRefusal(project(), db())).toBeNull()
    expect(linkRefusal(project(), db({ isVocabularyReference: true }))).toMatch(/vocabulary/)
    expect(linkRefusal(project(), db({ workspaceId: 'other' }))).toMatch(/another workspace/)
  })
})

describe('databases', () => {
  it('never tells where a database is, only what it is', () => {
    expect(databaseKind(db())).toEqual({ kind: 'managed', engine: 'duckdb' })
    expect(databaseKind(db({ connectionConfig: { engine: 'duckdb', serverPath: '/data/x.duckdb' } }))).toEqual({ kind: 'server-file', engine: 'duckdb' })
    expect(databaseKind(db({ connectionConfig: { engine: 'duckdb', serverPath: '/data/parquet' } })).kind).toBe('server-folder')
    expect(databaseKind(db({ connectionConfig: { engine: 'postgresql', host: 'h' } })).kind).toBe('external')
  })

  it('makes aliases and refuses duplicate names', () => {
    expect(newAlias('MIMIC-IV Demo', undefined, [db({ alias: 'mimic_iv_demo' })])).toBe('mimic_iv_demo_2')
    expect(newAlias('x', 'My Alias', [])).toBe('my_alias')
    expect(nameTaken(' mimic ', [db()])).toBe(true)
    expect(nameTaken('mimic', [db()], 'd1')).toBe(false)
  })

  it('builds the empty-from-schema row as createEmptyDatabase does', () => {
    const body = databaseCreateBody({
      id: 'n', lineageId: 'l', workspaceId: 'ws', name: 'Target', alias: 'target', lang: 'en',
      spec: { kind: 'empty-from-schema', preset: preset() },
    })
    expect(body).toMatchObject({
      id: 'n', alias: 'target', name: { en: 'Target' }, description: { en: 'Created from OMOP preset (empty)' },
      sourceType: 'database', connectionConfig: { engine: 'duckdb', managed: true }, status: 'configuring',
      schemaSource: { lineageId: 'lin-omop', label: { en: 'OMOP' }, version: '5.4' }, workspaceId: 'ws', lineageId: 'l',
    })
    expect(body).not.toHaveProperty('version')
  })

  it('never puts a login in an external database\'s config', () => {
    const body = databaseCreateBody({
      id: 'n', lineageId: 'l', workspaceId: 'ws', name: 'PG', alias: 'pg', lang: 'en',
      spec: { kind: 'external', engine: 'postgresql', host: 'h', port: 5432, database: 'd', allowWrites: true, requireSessionOnly: true },
    })
    expect(body.connectionConfig).toEqual({ engine: 'postgresql', host: 'h', port: 5432, database: 'd', allowWrites: true })
    expect(body).toMatchObject({ requireSessionOnly: true, version: '0.1.0' })
    expect(body).not.toHaveProperty('schemaMapping')
  })

  it('updates from its own preset keeping overrides, switches to another dropping them', () => {
    const own = preset()
    const other = preset({ id: 'p2', presetId: 'mimic', lineageId: 'lin-mimic', version: '1.0' })
    const withOverrides = db({ schemaMapping: mapping as never, schemaSource: { lineageId: 'lin-omop', version: '5.3' }, schemaOverrides: { relations: {} } })
    const same = presetMappingChange(withOverrides, own, [own, other])
    expect(same.update).toBe(true)
    expect(same.changes).not.toHaveProperty('schemaOverrides')
    expect(same.changes).toMatchObject({ schemaSource: { lineageId: 'lin-omop', version: '5.4' } })
    const switched = presetMappingChange(withOverrides, other, [own, other])
    expect(switched).toMatchObject({ update: false, changes: { schemaOverrides: null, schemaSource: { lineageId: 'lin-mimic' } } })
  })

  it('stores a re-test like the Retest button', () => {
    expect(retestUpdate(db({ stats: { patientCount: 5 } }), { ok: true, tableCount: 3 }, true))
      .toEqual({ status: 'connected', errorMessage: null, stats: { patientCount: 5, tableCount: 3 } })
    expect(retestUpdate(db(), { ok: true, tableCount: 0 }, true)).toMatchObject({ status: 'disconnected' })
    expect(retestUpdate(db(), { ok: true, tableCount: 0 }, false)).toMatchObject({ status: 'connected' })
    expect(retestUpdate(db(), { ok: false, error: 'boom' }, false)).toEqual({ status: 'error', errorMessage: 'boom' })
  })
})

describe('registration', () => {
  it('registers every tool without a schema error', () => {
    expect(() => registerWorkspaceTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
