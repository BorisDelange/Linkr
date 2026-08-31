import { describe, it, expect } from 'vitest'
import { paramsFromPath } from './use-resolved-params'

describe('paramsFromPath', () => {
  it('reads the workspace prefix off a workspace-level route', () => {
    expect(paramsFromPath('/workspaces/1e9a8988/warehouse/databases')).toEqual({
      wsUid: '1e9a8988',
      uid: undefined,
    })
  })

  it('reads both prefixes off a project-level route', () => {
    expect(
      paramsFromPath('/workspaces/1e9a8988/projects/abcd1234/warehouse/databases'),
    ).toEqual({ wsUid: '1e9a8988', uid: 'abcd1234' })
  })

  it('reads the workspace prefix on a detail route with a trailing id', () => {
    expect(
      paramsFromPath('/workspaces/1e9a8988/warehouse/databases/66604214'),
    ).toEqual({ wsUid: '1e9a8988', uid: undefined })
  })

  it('accepts a full uuid, which is a prefix of itself', () => {
    const id = '1e9a8988-7be4-4967-b072-0226b2c3dcc7'
    expect(paramsFromPath(`/workspaces/${id}/warehouse/schemas`).wsUid).toBe(id)
  })

  it('finds nothing outside the workspace tree', () => {
    expect(paramsFromPath('/settings/general')).toEqual({
      wsUid: undefined,
      uid: undefined,
    })
    expect(paramsFromPath('/')).toEqual({ wsUid: undefined, uid: undefined })
  })

  it('does not mistake the workspaces list for a workspace', () => {
    expect(paramsFromPath('/workspaces').wsUid).toBeUndefined()
  })

  it('only matches `projects` directly under a workspace', () => {
    // /catalog/projects/... must not yield a project uid.
    expect(paramsFromPath('/catalog/projects/abcd1234').uid).toBeUndefined()
  })
})
