/**
 * Where a catalog workspace install lands.
 *
 * The re-install dialog offers only "keep both" for a workspace (overwriting one
 * would delete every project, database and mapping it holds), so that choice must
 * actually be honoured — but only when there IS something to keep beside, or a
 * first install would land as "… (copy)" with a fresh lineage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const storageHolder = vi.hoisted(() => ({ rows: [] as { id: string; lineageId?: string }[] }))
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({ workspaces: { getAll: async () => storageHolder.rows } }),
}))

import { workspaceLineageExists } from './install'

describe('workspaceLineageExists', () => {
  beforeEach(() => { storageHolder.rows = [] })

  it('is false when nothing local carries the lineage', async () => {
    storageHolder.rows = [{ id: 'w1', lineageId: 'other' }]
    expect(await workspaceLineageExists('lin-1')).toBe(false)
  })

  it('is true when a local workspace carries it', async () => {
    // The row's own id is a local uuid, NOT the repo id — which is exactly why
    // the id-keyed `existingName` lookup cannot answer this question.
    storageHolder.rows = [{ id: 'local-uuid', lineageId: 'lin-1' }]
    expect(await workspaceLineageExists('lin-1')).toBe(true)
  })

  it('is false for a workspace the repo publishes without a lineage', async () => {
    storageHolder.rows = [{ id: 'w1', lineageId: 'lin-1' }]
    expect(await workspaceLineageExists(undefined)).toBe(false)
  })

  it('does not match a local row that has no lineage of its own', async () => {
    storageHolder.rows = [{ id: 'w1' }]
    expect(await workspaceLineageExists(undefined)).toBe(false)
  })
})
