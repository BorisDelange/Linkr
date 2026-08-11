import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Storage } from '@/lib/storage'
import type { PreparedEtlPull } from './etl-pull'

const gitMocks = vi.hoisted(() => ({
  gitCloneToZip: vi.fn(),
  gitSetSyncState: vi.fn(async () => {}),
}))
vi.mock('@/lib/api/git', () => gitMocks)
vi.mock('@/lib/git-clone', () => ({ cleanGitUrl: (u: string) => u }))

const { applyEtlPull } = await import('./etl-pull')

/** Minimal storage: the empty-selection path must not touch files at all. */
const storage = () => ({
  etlFiles: {
    getByPipeline: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
  },
  etlPipelines: {
    getById: vi.fn(async () => ({ id: 'p1' })),
    update: vi.fn(async () => {}),
  },
}) as unknown as Storage

const prepared = (): PreparedEtlPull => ({
  plan: { groups: { docs: [], scripts: [], mappings: [], other: [] }, settingsChanged: false },
  nodes: [],
  remotePipeline: null,
  remoteDocs: {},
  clonedOid: '6ced4a58497fdc24d1e703f63a00f41f65c5ebac',
  branch: 'main',
})

beforeEach(() => {
  gitMocks.gitSetSyncState.mockClear()
})

describe('applyEtlPull anchors even with nothing selected', () => {
  it('advances the anchor on an EMPTY selection', async () => {
    // The dialog calls it this way when the plan is empty: the local content
    // already matches the remote, so only the baseline is missing. Without this
    // the "behind" banner and "pull first" never cleared — an actual deadlock,
    // since Apply is disabled when there is nothing to pull.
    const s = storage()
    await applyEtlPull('p1', prepared(), { paths: new Set(), settings: false }, s)
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledWith(
      'etl-pipelines', 'p1', 'main', '6ced4a58497fdc24d1e703f63a00f41f65c5ebac',
    )
  })

  it('writes nothing when nothing is selected', async () => {
    const s = storage()
    await applyEtlPull('p1', prepared(), { paths: new Set(), settings: false }, s)
    expect(s.etlFiles.create).not.toHaveBeenCalled()
    expect(s.etlFiles.update).not.toHaveBeenCalled()
    expect(s.etlPipelines.update).not.toHaveBeenCalled()
  })

  it('does not anchor when the clone reported no commit', async () => {
    // clonedOid is null when the server did not expose X-Git-Cloned-Oid; claiming
    // a sync we cannot identify would be worse than leaving the banner up.
    const s = storage()
    await applyEtlPull('p1', { ...prepared(), clonedOid: null }, { paths: new Set(), settings: false }, s)
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })
})

describe('the anchor only moves on a COMPLETE, successful pull', () => {
  const withPlan = (): PreparedEtlPull => ({
    plan: {
      groups: {
        docs: [],
        scripts: [{ key: 'a.sql', exists: false }, { key: 'b.sql', exists: false }],
        mappings: [],
        other: [],
      },
      settingsChanged: false,
    },
    nodes: [
      { type: 'file', path: 'a.sql', name: 'a.sql', content: 'SELECT 1', parentId: null } as never,
      { type: 'file', path: 'b.sql', name: 'b.sql', content: 'SELECT 2', parentId: null } as never,
    ],
    remotePipeline: null,
    remoteDocs: {},
    clonedOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    branch: 'main',
  })

  it('does NOT anchor when only some of the offered files were taken', async () => {
    // The reported loss: the remote carries a.sql and b.sql, the user ticks only
    // a.sql, and the anchor jumped to the commit containing BOTH — clearing the
    // banner and rebuilding every later plan against it, so b.sql's remote change
    // was never offered again.
    await applyEtlPull('p1', withPlan(), { paths: new Set(['a.sql']), settings: false }, storage())
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  it('anchors once everything on offer was taken', async () => {
    await applyEtlPull(
      'p1', withPlan(), { paths: new Set(['a.sql', 'b.sql']), settings: false }, storage(),
    )
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledWith(
      'etl-pipelines', 'p1', 'main', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    )
  })

  it('does NOT anchor when the settings block was offered but declined', async () => {
    const prep = withPlan()
    prep.plan.settingsChanged = true
    prep.remotePipeline = { name: { en: 'remote' } } as never
    await applyEtlPull(
      'p1', prep, { paths: new Set(['a.sql', 'b.sql']), settings: false }, storage(),
    )
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  it('throws and does NOT anchor when a write failed', async () => {
    // Every write used to be `.catch(() => {})`, so a total failure resolved
    // successfully and anchored anyway — and the dialog's rollback never ran.
    const failing = {
      etlFiles: {
        getByPipeline: vi.fn(async () => []),
        update: vi.fn(async () => {}),
        create: vi.fn(async () => { throw new Error('quota exceeded') }),
      },
      etlPipelines: {
        getById: vi.fn(async () => ({ id: 'p1' })),
        update: vi.fn(async () => {}),
      },
    } as unknown as Storage

    await expect(
      applyEtlPull('p1', withPlan(), { paths: new Set(['a.sql', 'b.sql']), settings: false }, failing),
    ).rejects.toThrow(/could not be written/)
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })
})
