import { describe, it, expect } from 'vitest'
import { buildProjectDiffPlan, buildProjectPullDiff, entityDiffPath } from './project-pull-diff'
import { PROJECT_GROUP_PATHS } from './project-pull-plan-builder'
import type { PreparedProjectPull, ProjectPullPlan } from './project-pull'

const emptyPlan = (): ProjectPullPlan => ({
  dashboards: [], scripts: [], cohorts: [], datasets: [], pipeline: [], readmeChanged: false,
})

const prepared = (
  plan: Partial<ProjectPullPlan>,
  ideFiles: { path: string; type: string; content?: string }[] = [],
  localScriptContent = new Map<string, string | undefined>(),
): PreparedProjectPull => ({
  parsed: { ideFiles } as never,
  plan: { ...emptyPlan(), ...plan },
  clonedOid: 'oid-1',
  branch: 'main',
  localScriptContent,
  localExportShape: { cohorts: new Map(), pipeline: new Map() },
  remoteExportShape: { cohorts: new Map(), pipeline: new Map() },
})

describe('buildProjectDiffPlan', () => {
  it('turns the scripts GROUP into one row per script, so the viewer can navigate', () => {
    const plan = buildProjectDiffPlan(prepared({
      scripts: [
        { key: 'a.py', label: 'a.py', exists: true },
        { key: 'utils/b.py', label: 'utils/b.py', exists: false },
      ],
    }), 'main')

    expect(plan.files.map((f) => f.path))
      .toEqual([entityDiffPath('scripts', 'a.py'), entityDiffPath('scripts', 'utils/b.py')])
    expect(plan.files[0].items[0].state).toBe('update')
    expect(plan.files[1].items[0].state).toBe('add')
  })

  it('carries cohorts and the pipeline too, each as its own row', () => {
    const plan = buildProjectDiffPlan(prepared({
      cohorts: [{ key: 'sepsis', label: 'Sepsis', exists: true }],
      pipeline: [{ key: 'main', label: 'Main', exists: false }],
    }), 'main')

    expect(plan.files.map((f) => f.path))
      .toEqual([entityDiffPath('cohorts', 'sepsis'), entityDiffPath('pipeline', 'main')])
    // The label is the human name, not the slug — this is what the sidebar reads.
    expect(plan.files[0].items[0].label).toBe('Sepsis')
  })

  it('leaves out the groups it cannot rebuild', () => {
    // A dashboard exports as a BUNDLE (board + tabs + widgets, re-keyed by
    // content) that this module cannot reassemble from the plan alone; a dataset
    // row is data, not a document. Neither reaches the viewer.
    const plan = buildProjectDiffPlan(prepared({
      dashboards: [{ key: 'overview', label: 'Overview', exists: true }],
      datasets: [{ key: 'data.csv', label: 'data.csv', exists: true }],
    }), 'main')
    expect(plan.files).toEqual([])
  })
})

describe('buildProjectPullDiff', () => {
  it('puts what we hold on the left and what the remote would write on the right', () => {
    const p = prepared(
      { scripts: [{ key: 'a.py', label: 'a.py', exists: true }] },
      [{ path: 'a.py', type: 'file', content: 'print(2)' }],
      new Map([['a.py', 'print(1)']]),
    )
    const file = buildProjectDiffPlan(p, 'main').files[0]

    expect(buildProjectPullDiff(file, p, p.localScriptContent)).toEqual({
      oldContent: 'print(1)',
      newContent: 'print(2)',
      language: 'python',
    })
  })

  it('shows an empty left side for a script we do not have yet', () => {
    const p = prepared(
      { scripts: [{ key: 'new.sql', label: 'new.sql', exists: false }] },
      [{ path: 'new.sql', type: 'file', content: 'SELECT 1' }],
    )
    const file = buildProjectDiffPlan(p, 'main').files[0]
    const diff = buildProjectPullDiff(file, p, p.localScriptContent)
    expect(diff).toMatchObject({ oldContent: '', newContent: 'SELECT 1', language: 'sql' })
  })

  it('degrades to a blank side rather than throwing when a row has no remote file', () => {
    const p = prepared({ scripts: [{ key: 'gone.py', label: 'gone.py', exists: true }] }, [])
    const file = buildProjectDiffPlan(p, 'main').files[0]
    expect(buildProjectPullDiff(file, p, p.localScriptContent).newContent).toBe('')
  })

  it('keys the diff off the path under the group folder, not the raw row path', () => {
    // The row is `scripts/utils/b.py`; the parsed node and the local map are both
    // keyed by `utils/b.py`. Getting this wrong yields two blank sides, not an error.
    const p = prepared(
      { scripts: [{ key: 'utils/b.py', label: 'utils/b.py', exists: true }] },
      [{ path: 'utils/b.py', type: 'file', content: 'remote' }],
      new Map([['utils/b.py', 'local']]),
    )
    const file = buildProjectDiffPlan(p, 'main').files[0]
    expect(file.path).toBe(`${PROJECT_GROUP_PATHS.scripts}utils/b.py`)
    expect(buildProjectPullDiff(file, p, p.localScriptContent))
      .toMatchObject({ oldContent: 'local', newContent: 'remote' })
  })
})

describe('buildProjectPullDiff — cohorts and the pipeline', () => {
  const withShapes = (
    plan: Partial<ProjectPullPlan>,
    local: Record<string, unknown>,
    remote: Record<string, unknown>,
  ): PreparedProjectPull => ({
    ...prepared(plan),
    localExportShape: { cohorts: new Map(Object.entries(local)), pipeline: new Map() },
    remoteExportShape: { cohorts: new Map(Object.entries(remote)), pipeline: new Map() },
  })

  it('diffs the EXPORT projection, sorted, not the raw rows', () => {
    const p = withShapes(
      { cohorts: [{ key: 'sepsis', label: 'Sepsis', exists: true }] },
      { sepsis: { name: 'Sepsis', definition: { op: 'and' } } },
      { sepsis: { definition: { op: 'or' }, name: 'Sepsis' } },
    )
    const file = buildProjectDiffPlan(p, 'main').files[0]
    const diff = buildProjectPullDiff(file, p, p.localScriptContent)

    expect(diff.language).toBe('json')
    // Keys sorted on both sides, so a JSON round-trip's reordering is not a change.
    expect(diff.oldContent).toBe('{\n  "definition": {\n    "op": "and"\n  },\n  "name": "Sepsis"\n}')
    expect(diff.newContent).toBe('{\n  "definition": {\n    "op": "or"\n  },\n  "name": "Sepsis"\n}')
  })

  it('shows an empty left side for a cohort we do not have yet', () => {
    const p = withShapes(
      { cohorts: [{ key: 'new', label: 'New', exists: false }] },
      {},
      { new: { name: 'New' } },
    )
    const file = buildProjectDiffPlan(p, 'main').files[0]
    // An absent side renders blank, never the string "null".
    expect(buildProjectPullDiff(file, p, p.localScriptContent).oldContent).toBe('')
  })

  it('degrades to a blank diff for a row belonging to no known group', () => {
    const p = prepared({})
    const orphan = { path: 'dashboards/overview', category: 'x', order: 0, items: [] }
    expect(buildProjectPullDiff(orphan, p, p.localScriptContent))
      .toEqual({ oldContent: '', newContent: '', language: 'json' })
  })
})
