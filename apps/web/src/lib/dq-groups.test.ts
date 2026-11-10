import { describe, expect, it } from 'vitest'
import type { DqCheckGroup, DqCustomCheck } from '@/types'
import {
  allGroups, canMoveGroup, groupPath, groupTree, moveGroup, newGroupKey, nodeChecks, readCheckGroups,
  removeGroup, removeSubtree, renameGroup, subtreeKeys,
} from './dq-groups'
import { readStoredCheck, readStoredReport } from './duckdb/data-quality-checks'

const g = (key: string, parentKey: string | null = null): DqCheckGroup => ({ key, name: { en: key.toUpperCase(), fr: key }, parentKey })
const c = (id: string, groupKey: string | null) => ({ id, groupKey })

// demo › (labs › blood), person is only named by a check (generated from a schema).
const GROUPS = [g('demo'), g('labs', 'demo'), g('blood', 'labs')]
const CHECKS = [c('1', 'blood'), c('2', 'demo'), c('3', 'person'), c('4', null), c('5', 'gone-parent-ok')]

describe('dq-groups', () => {
  it('reads the bare keys stored before groups had names', () => {
    expect(readCheckGroups(['person', 'person', { key: 'x', name: { fr: 'X' } }, 3, null])).toEqual([
      { key: 'person', name: { en: 'person' }, parentKey: null },
      { key: 'x', name: { fr: 'X' }, parentKey: null },
    ])
    expect(readCheckGroups(null)).toEqual([])
  })

  it('builds the nested tree, undeclared keys at the top, ungrouped apart', () => {
    const { roots, ungrouped } = groupTree(GROUPS, CHECKS)
    expect(roots.map((n) => n.key)).toEqual(['demo', 'person', 'gone-parent-ok'])
    expect(roots[0].children[0].children[0].checks.map((x) => x.id)).toEqual(['1'])
    expect(roots[1].implicit).toBe(true)
    expect(nodeChecks(roots[0]).map((x) => x.id)).toEqual(['2', '1'])
    expect(ungrouped.map((x) => x.id)).toEqual(['4'])
  })

  it('drops the groups with nothing under them only when asked', () => {
    const tree = groupTree([...GROUPS, g('empty')], [c('1', 'blood')], { keepEmpty: false })
    expect(tree.roots.map((n) => n.key)).toEqual(['demo'])
    expect(groupTree([...GROUPS, g('empty')], []).roots.map((n) => n.key)).toEqual(['demo', 'empty'])
  })

  it('survives a parent cycle from a hand-edited export', () => {
    const cyclic = [g('a', 'b'), g('b', 'a')]
    expect(groupPath(cyclic, 'a').map((s) => s.key)).toEqual(['b', 'a'])
    const { roots } = groupTree(cyclic, [])
    expect(roots.length).toBeGreaterThan(0)
  })

  it('gives a check its path, root first, an undeclared key as one step', () => {
    expect(groupPath(GROUPS, 'blood').map((s) => s.key)).toEqual(['demo', 'labs', 'blood'])
    expect(groupPath(GROUPS, 'person')).toEqual([{ key: 'person', name: { en: 'person' } }])
    expect(groupPath(GROUPS, null)).toEqual([])
  })

  it('never moves a group inside itself', () => {
    expect(subtreeKeys(GROUPS, 'demo')).toEqual(new Set(['demo', 'labs', 'blood']))
    expect(canMoveGroup(GROUPS, 'demo', 'blood')).toBe(false)
    expect(moveGroup(GROUPS, 'demo', 'blood')).toBe(GROUPS)
    expect(moveGroup(GROUPS, 'blood', null).at(-1)).toEqual(g('blood'))
  })

  it('declares an undeclared group when it is renamed or moved, keeping its key', () => {
    expect(renameGroup(GROUPS, 'person', { en: 'Patients', fr: 'Patients' }).at(-1))
      .toEqual({ key: 'person', name: { en: 'Patients', fr: 'Patients' }, parentKey: null })
    expect(moveGroup(GROUPS, 'person', 'demo').at(-1)).toEqual({ key: 'person', name: { en: 'person' }, parentKey: 'demo' })
  })

  it('removes a group, lifting its sub-groups, or with everything under it', () => {
    expect(removeGroup(GROUPS, 'labs')).toEqual([g('demo'), g('blood', 'demo')])
    expect(removeSubtree(GROUPS, 'labs')).toEqual([g('demo')])
  })

  it('keys a new group from its English name, unique', () => {
    expect(newGroupKey({ en: 'Lab values', fr: 'Biologie' }, ['lab-values'])).toBe('lab-values-2')
    expect(newGroupKey({ fr: 'Biologie' }, [])).toBe('biologie')
    expect(newGroupKey({}, [])).toBe('group')
  })

  it('lists the declared groups then the keys only checks name', () => {
    expect(allGroups(GROUPS, CHECKS).map((x) => x.key)).toEqual(['demo', 'labs', 'blood', 'person', 'gone-parent-ok'])
  })
})

describe('legacy DQ records', () => {
  it('reads a check stored with plain-text names and a table as its group', () => {
    const stored = { id: 'x', name: 'Not null', description: '', category: 'validity', severity: 'info', tableName: 'person' }
    expect(readStoredCheck(stored as unknown as DqCustomCheck)).toMatchObject({
      name: { en: 'Not null' }, description: {}, groupKey: 'person', category: 'conformance', severity: 'notice',
    })
    expect(readStoredCheck(stored as unknown as DqCustomCheck)).not.toHaveProperty('tableName')
  })

  it('reads a run recorded before groups: its table becomes a one-step path', () => {
    const report = readStoredReport({
      dataSourceId: 'd', computedAt: '', results: [], summary: {},
      checks: [{ id: 'x', name: 'Old', description: 'd', category: 'completeness', severity: 'error', tableName: 'visit' }],
    })
    expect(report?.checks[0]).toMatchObject({ name: { en: 'Old' }, description: { en: 'd' }, groupPath: [{ key: 'visit', name: { en: 'visit' } }] })
    expect(readStoredReport(null)).toBeNull()
  })
})
