import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { useFileStore, type FileNode } from './file-store'
import { initStorage } from '@/lib/storage'

/**
 * The IDE multi-selection must never outlive its project.
 *
 * Server-mode IDE ids are sha1(relative path) with no project in the hash, so
 * `scripts/etl.sql` has the SAME id in every project. A selection carried across a
 * project switch therefore still matched real rows in the new project, survived
 * pruning, stayed visibly tinted — and a bulk delete removed the WRONG project's
 * files. Two projects made from one template is all it took to hit it.
 */

const file = (id: string, name: string, projectUid: string): FileNode => ({
  id,
  projectUid,
  name,
  type: 'file',
  parentId: null,
  createdAt: '2026-01-01',
})

// Same ids in both projects, exactly as the server derives them from the path.
const PROJECT_A = [file('ide-aaa', 'etl.sql', 'proj-a'), file('ide-bbb', 'load.sql', 'proj-a')]
const PROJECT_B = [file('ide-aaa', 'etl.sql', 'proj-b'), file('ide-bbb', 'load.sql', 'proj-b')]

describe('IDE selection across a project switch', () => {
  beforeEach(() => {
    useFileStore.setState({
      files: PROJECT_A,
      activeProjectUid: 'proj-a',
      selection: { ids: ['ide-aaa', 'ide-bbb'], anchorId: 'ide-aaa' },
    })
  })

  afterEach(() => {
    initStorage(undefined as unknown as Parameters<typeof initStorage>[0])
  })

  it('drops the selection when another project is scanned from disk', async () => {
    initStorage({
      ideFiles: { getByProject: async () => PROJECT_B },
    } as unknown as Parameters<typeof initStorage>[0])

    await useFileStore.getState().reloadFromDisk('proj-b')

    // The ids DO exist in project B — which is exactly why carrying them over was
    // dangerous, and why the reset cannot rely on pruning alone.
    expect(useFileStore.getState().files.map((f) => f.id)).toContain('ide-aaa')
    expect(useFileStore.getState().selection.ids).toEqual([])
    expect(useFileStore.getState().selection.anchorId).toBeNull()
  })

  it('keeps the selection when the SAME project is re-scanned, minus deleted files', async () => {
    initStorage({
      ideFiles: { getByProject: async () => [PROJECT_A[0]] },
    } as unknown as Parameters<typeof initStorage>[0])

    await useFileStore.getState().reloadFromDisk('proj-a')

    // Still the same project, so the selection survives — pruned to what is left.
    expect(useFileStore.getState().selection.ids).toEqual(['ide-aaa'])
  })
})
