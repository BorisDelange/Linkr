import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { applyClonedEntity, buildDqRuleSetFolder, parseWorkspaceZip } from './entity-io'
import type { Storage } from './storage'
import type { DqCustomCheck, DqRuleSet } from '@/types'

// Every field a check gained with schema-generated rule sets must survive both
// ways a rule set comes back in: a cloned git repo, and a workspace ZIP.

const RULE_SET = {
  id: 'rs-1', workspaceId: 'w1', entityId: 'omop-dq', name: { en: 'OMOP DQ' }, description: {},
  dataSourceId: 'ds-1', dataSourceRef: { lineageId: 'db-lin', entityId: 'omop-db' },
  schemaPresetRef: { lineageId: 'schema-lin', entityId: 'omop-cdm-5-4', label: { en: 'OMOP CDM 5.4' } },
  status: 'draft', lineageId: 'rs-lin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
} as unknown as DqRuleSet

const CHECK: DqCustomCheck = {
  id: 'chk-1', ruleSetId: 'rs-1', name: 'person.person_id not null', description: 'never empty',
  category: 'conformance', subcategory: 'relational', severity: 'error', threshold: 0,
  sql: 'SELECT 0 AS violated_rows, 1 AS total_rows', exploreSql: 'SELECT * FROM person WHERE person_id IS NULL',
  order: 3, origin: 'ddl', templateKey: 'ddl.not_null:person.person_id', tableName: 'my group', disabled: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
}

const PORTABLE = {
  name: CHECK.name, description: CHECK.description, category: 'conformance', subcategory: 'relational',
  severity: 'error', threshold: 0, sql: CHECK.sql, exploreSql: CHECK.exploreSql, order: 3,
  origin: 'ddl', templateKey: CHECK.templateKey, tableName: 'my group', disabled: true,
}

const exportStore = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'dqCustomChecks') return { getByRuleSet: async () => [CHECK] }
    return new Proxy({}, { get: () => async () => [] })
  },
}) as unknown as Storage

describe('DQ rule set round trip', () => {
  it('a cloned git repo restores every check field and the schema pointer', async () => {
    const zip = new JSZip()
    await buildDqRuleSetFolder(zip, '', RULE_SET, exportStore)

    const updates: Partial<DqRuleSet>[] = []
    const created: DqCustomCheck[] = []
    const store = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'dqRuleSets') return { update: async (_id: string, c: Partial<DqRuleSet>) => { updates.push(c) } }
        if (prop === 'dqCustomChecks') return { deleteByRuleSet: async () => {}, create: async (c: DqCustomCheck) => { created.push(c) } }
        return new Proxy({}, { get: () => async () => [] })
      },
    }) as unknown as Storage

    expect(await applyClonedEntity(zip, 'dq-rule-set', 'rs-target', store)).toEqual({ ok: true })
    expect(updates[0].schemaPresetRef).toEqual(RULE_SET.schemaPresetRef)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ ...PORTABLE, ruleSetId: 'rs-target' })
  })

  it('a workspace ZIP reads every check field back', async () => {
    const zip = new JSZip()
    zip.file('entity.json', JSON.stringify({ name: { en: 'W' }, type: 'workspace' }))
    await buildDqRuleSetFolder(zip, 'data-quality/omop-dq/', RULE_SET, exportStore)
    const file = await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
    const parsed = await parseWorkspaceZip(file)
    const [entry] = parsed!.dqRuleSets
    expect(entry.ruleSet.schemaPresetRef).toEqual(RULE_SET.schemaPresetRef)
    expect(entry.checks[0]).toMatchObject(PORTABLE)
  })
})
