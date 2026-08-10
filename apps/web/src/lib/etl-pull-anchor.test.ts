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
