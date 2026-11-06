import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plugin } from '@/types/plugin'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => true }))
vi.mock('@/lib/runtimes/pyodide-engine', () => ({ installPythonPackage: vi.fn(), listPythonPackages: vi.fn() }))
vi.mock('@/lib/runtimes/webr-engine', () => ({ installRPackage: vi.fn(), listRPackages: vi.fn() }))

import { getAllPlugins, getLabPlugins, getPlugin, registerPlugin, setPluginWorkspaceResolver, unregisterPlugin } from './registry'

const plugin = (id: string, workspaceId?: string, code = id): Plugin => ({
  manifest: { id, scope: 'lab', runtime: ['script'] } as unknown as Plugin['manifest'],
  templates: { python: code },
  workspaceId,
})

let active: string | null = null

beforeEach(() => {
  for (const p of getAllPlugins()) unregisterPlugin(p.manifest.id, p.workspaceId)
  active = null
  setPluginWorkspaceResolver(() => active)
})

describe('plugin registry', () => {
  it('runs in a workspace only that workspace copy of a shared id', () => {
    registerPlugin(plugin('shared', 'ws-a', 'code of a'))
    registerPlugin(plugin('shared', 'ws-b', 'code of b'))
    active = 'ws-a'
    expect(getPlugin('shared')?.templates?.python).toBe('code of a')
    active = 'ws-b'
    expect(getPlugin('shared')?.templates?.python).toBe('code of b')
  })

  it('never resolves a plugin of another workspace', () => {
    registerPlugin(plugin('only-in-a', 'ws-a'))
    active = 'ws-b'
    expect(getPlugin('only-in-a')).toBeUndefined()
    expect(getLabPlugins().map((p) => p.manifest.id)).toEqual([])
    active = null
    expect(getPlugin('only-in-a')).toBeUndefined()
  })

  it('falls back to the bundled built-in', () => {
    registerPlugin(plugin('builtin'))
    registerPlugin(plugin('builtin', 'ws-a', 'copy of a'))
    active = 'ws-b'
    expect(getPlugin('builtin')?.templates?.python).toBe('builtin')
    active = 'ws-a'
    expect(getPlugin('builtin')?.templates?.python).toBe('copy of a')
    expect(getLabPlugins().map((p) => p.templates?.python)).toEqual(['copy of a'])
  })

  it('looks a plugin up in the workspace it is asked about', () => {
    registerPlugin(plugin('shared', 'ws-a', 'code of a'))
    active = 'ws-b'
    expect(getPlugin('shared', 'ws-a')?.templates?.python).toBe('code of a')
    expect(getLabPlugins('ws-a').map((p) => p.templates?.python)).toEqual(['code of a'])
  })

  it('removes only the copy of the workspace named', () => {
    registerPlugin(plugin('shared', 'ws-a'))
    registerPlugin(plugin('shared', 'ws-b'))
    unregisterPlugin('shared', 'ws-a')
    active = 'ws-a'
    expect(getPlugin('shared')).toBeUndefined()
    active = 'ws-b'
    expect(getPlugin('shared')).toBeDefined()
  })
})
