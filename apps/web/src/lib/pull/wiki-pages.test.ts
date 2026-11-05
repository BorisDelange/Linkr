import { describe, expect, it } from 'vitest'
import { itemIdFor, type PullDecision } from '@/lib/pull-plan'
import { buildThreeWayPlan, prepareThreeWay, type ThreeWayFile } from './three-way'
import { groupWikiPages } from './wiki-pages'

const labels = { file: 'file', field: (k: string) => k, element: (k: string) => k, merged: 'merged' }
const tree = (...pages: object[]) => JSON.stringify(pages, null, 2)

function plan(files: ThreeWayFile[]) {
  const preview = { branch: 'main', remoteHead: 'r', files }
  return buildThreeWayPlan('workspaces', preview, prepareThreeWay(preview), labels)
}

describe('groupWikiPages', () => {
  const setup = { id: 'p1', entityId: 'setup', title: { en: 'Setup' }, status: 'draft', sortOrder: 0 }
  const faq = { id: 'p2', title: { en: 'FAQ' }, status: 'draft', sortOrder: 1 }
  const files: ThreeWayFile[] = [
    {
      path: 'wiki/_tree.json',
      base: tree(setup, faq), local: tree(setup, faq),
      remote: tree({ ...setup, title: { en: 'Install' }, status: 'approved' }, { ...faq, status: 'approved' }),
    },
    { path: 'wiki/setup.md', base: 'Install.\n', local: 'Install.\n', remote: 'Install it.\n' },
    { path: 'wiki/setup.fr.md', base: 'Installer.\n', local: 'Installer.\n', remote: 'L’installer.\n' },
  ]

  it('puts a page’s settings on its main text row and keeps the others on the tree', () => {
    const { plan: view } = groupWikiPages(plan(files), files, 'Page settings', (f) => f)
    const setupRow = view.files.find((f) => f.path === 'wiki/setup.md')!
    expect(setupRow.items.map((i) => [i.label, i.detail])).toEqual([['file', undefined], ['Page settings', 'title, status']])
    expect(view.files.find((f) => f.path === 'wiki/setup.fr.md')!.items).toHaveLength(1)
    // FAQ's text did not change: its settings stay on the tree row.
    expect(view.files.find((f) => f.path === 'wiki/_tree.json')!.items.map((i) => i.key)).toEqual(['el:p2'])
  })

  it('reads a decision on the page settings as one on the tree element', () => {
    const { toReal } = groupWikiPages(plan(files), files, 'Page settings', (f) => f)
    const decided = new Map<string, PullDecision>([[itemIdFor('wiki/setup.md', 'page-settings:p1'), 'accept']])
    expect([...toReal(decided)]).toEqual([[itemIdFor('wiki/_tree.json', 'el:p1'), 'accept']])
  })
})
