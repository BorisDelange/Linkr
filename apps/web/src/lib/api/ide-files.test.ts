import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdeFile } from '@/types'

const apiRequest = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiRequest }))

const { apiIdeFileStorage } = await import('./ide-files')

const P = 'proj-1'

/** The paths POSTed to the create endpoint, in call order. */
function createdPaths(): string[] {
  return apiRequest.mock.calls
    .filter(([url]) => url === '/ide-files')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).path as string)
}

function node(id: string, name: string, type: 'file' | 'folder', parentId: string | null): IdeFile {
  return { id, projectUid: P, name, type, parentId, createdAt: '' } as IdeFile
}

describe('apiIdeFileStorage.create', () => {
  beforeEach(() => {
    apiRequest.mockReset()
    apiRequest.mockResolvedValue(undefined)
  })

  it('nests a file under a folder created in the same pass', async () => {
    // An import writes the whole tree in one go with client-derived ids no scan
    // has ever returned. Resolving the parent through the scan cache alone made
    // `sql/cohort-stays.sql` land flat as `cohort-stays.sql` in scripts/.
    await apiIdeFileStorage.create(node('f-sql', 'sql', 'folder', null))
    await apiIdeFileStorage.create(node('s-1', 'cohort-stays.sql', 'file', 'f-sql'))

    expect(createdPaths()).toEqual(['sql', 'sql/cohort-stays.sql'])
  })

  it('keeps same-named files in different folders apart', async () => {
    await apiIdeFileStorage.create(node('f-sql', 'sql', 'folder', null))
    await apiIdeFileStorage.create(node('f-py', 'python', 'folder', null))
    await apiIdeFileStorage.create(node('a-sql', 'a.sql', 'file', 'f-sql'))
    await apiIdeFileStorage.create(node('a-py', 'a.sql', 'file', 'f-py'))

    expect(createdPaths()).toEqual(['sql', 'python', 'sql/a.sql', 'python/a.sql'])
  })

  it('handles folders nested more than one level deep', async () => {
    await apiIdeFileStorage.create(node('f-a', 'sql', 'folder', null))
    await apiIdeFileStorage.create(node('f-b', 'cohorts', 'folder', 'f-a'))
    await apiIdeFileStorage.create(node('s', 'adults.sql', 'file', 'f-b'))

    expect(createdPaths()).toEqual(['sql', 'sql/cohorts', 'sql/cohorts/adults.sql'])
  })

  it('skips the synthetic scripts root, which already exists on disk', async () => {
    await apiIdeFileStorage.create(node('root', 'scripts', 'folder', null))
    expect(apiRequest).not.toHaveBeenCalled()
  })
})
