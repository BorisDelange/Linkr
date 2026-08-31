import { describe, it, expect } from 'vitest'
import { buildProjectDiffPlan, buildProjectPullDiff, scriptDiffPath } from './project-pull-diff'
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
      .toEqual([scriptDiffPath('a.py'), scriptDiffPath('utils/b.py')])
    expect(plan.files[0].items[0].state).toBe('update')
    expect(plan.files[1].items[0].state).toBe('add')
  })

  it('ignores the groups that have no readable diff', () => {
    // A dashboard's export is a rewritten JSON document: diffing it would parade
    // regenerated ids rather than the change, so it never reaches the viewer.
    const plan = buildProjectDiffPlan(prepared({
      dashboards: [{ key: 'overview', label: 'Overview', exists: true }],
      cohorts: [{ key: 'sepsis', label: 'Sepsis', exists: true }],
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
