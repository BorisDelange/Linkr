import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { GitStatus, GitSyncState } from '@/lib/api/git'
import { explainGitError, formatBranches, formatDiff, formatStatus, formatSyncState, gitPath, unifiedDiff } from './git'
import { registerGitTools } from './tools-git'

const status = (over: Partial<GitStatus>): GitStatus => ({
  linked: true, branch: 'main', files: [], modified: 0, added: 0, deleted: 0, ...over,
})
const sync = (over: Partial<GitSyncState>): GitSyncState => ({
  linked: true, branch: 'main', remoteHead: 'abcdef0123456789', syncedOid: '0123456789abcdef', reviewedOid: null,
  behind: false, diverged: false, ...over,
})

describe('gitPath', () => {
  it('routes each entity kind to its prefix', () => {
    expect(gitPath('project', 'p 1', 'status')).toBe('/git/projects/p%201/status')
    expect(gitPath('mapping_project', 'm1', 'branches')).toBe('/git/mapping-projects/m1/branches')
    expect(gitPath('plugin', 'u1', 'sync-state', 'dev')).toBe('/git/user-plugins/u1/sync-state?branch=dev')
  })

  it('refuses an unknown kind', () => {
    expect(() => gitPath('settings' as never, 'account', 'status')).toThrow(/Unknown entity kind/)
  })
})

describe('formatStatus', () => {
  it('lists changes sorted, with renames and sizes, cut at the limit', () => {
    const out = formatStatus(status({
      modified: 1, added: 1, deleted: 1,
      files: [
        { path: 'b.json', changeType: 'added', size: 2048 },
        { path: 'a.json', changeType: 'modified', size: 10 },
        { path: 'c.json', changeType: 'renamed', size: 5, oldPath: 'old.json' },
        { path: 'd.json', changeType: 'deleted', size: 0 },
      ],
    }), 3)
    const lines = out.split('\n')
    expect(lines[0]).toContain('4 file(s) differ')
    expect(lines[1]).toBe('- modified a.json · 10 B')
    expect(lines[2]).toBe('- added b.json · 2 KB')
    expect(lines[3]).toBe('- renamed c.json (from old.json) · 5 B')
    expect(lines[4]).toBe('… 1 more file(s)')
  })

  it('says when there is nothing to commit, or no link', () => {
    expect(formatStatus(status({}))).toContain('nothing to commit')
    expect(formatStatus(status({ linked: false }))).toContain('Not linked')
  })
})

describe('formatSyncState', () => {
  it('tells behind, diverged, in sync and unanchored apart', () => {
    expect(formatSyncState(sync({ behind: true }))).toMatch(/^Behind/)
    expect(formatSyncState(sync({ diverged: true }))).toMatch(/^Diverged/)
    expect(formatSyncState(sync({}))).toMatch(/^In sync/)
    expect(formatSyncState(sync({ syncedOid: null }))).toContain('never anchored')
    expect(formatSyncState(sync({ remoteHead: null }))).toContain('does not exist on the remote')
    expect(formatSyncState(sync({ linked: false }))).toContain('Not linked')
  })
})

describe('formatBranches', () => {
  it('marks the current branch', () => {
    expect(formatBranches({ branches: ['dev', 'main'], current: 'main' })).toBe('- dev\n- main (current)')
    expect(formatBranches({ branches: [], current: null })).toContain('No branch')
  })
})

describe('explainGitError', () => {
  it('turns a structured detail into advice that never asks for a token', () => {
    const out = explainGitError(JSON.stringify({ code: 'auth_required', message: 'fatal: auth' }))
    expect(out).toContain('never ask')
    expect(out).toContain('fatal: auth')
    expect(explainGitError('{"code":"weird"}')).toContain('weird')
  })

  it('leaves other errors alone', () => {
    expect(explainGitError('Not found')).toBeNull()
    expect(explainGitError('{"detail":1}')).toBeNull()
  })
})

describe('registerGitTools', () => {
  it('registers every tool with a valid schema', () => {
    expect(() => registerGitTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})

describe('unifiedDiff', () => {
  it('marks removed and added lines, keeps 3 lines of context, elides the rest', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const after = ['a', 'b', 'c', 'd', 'e', 'F', 'g', 'h', 'i', 'j'].join('\n')
    expect(unifiedDiff(before, after)).toBe(['…', ' c', ' d', ' e', '-f', '+F', ' g', ' h', ' i', '…'].join('\n'))
  })

  it('treats an empty side as a pure addition', () => {
    expect(unifiedDiff('', 'x\ny')).toBe('+x\n+y')
  })

  it('shows both sides instead of a diff past the size budget', () => {
    expect(unifiedDiff('a\nb', 'c\nd', 400, 1)).toMatch(/^\(too large for a line diff/)
  })
})

describe('formatDiff', () => {
  const diff = { path: 'x.json', changeType: 'modified' as const, oldContent: 'a', newContent: 'b',
    truncated: false, truncationMode: 'none' as const, binary: false }

  it('heads the diff with the change and the rename', () => {
    expect(formatDiff({ ...diff, changeType: 'renamed', oldPath: 'w.json' })).toBe('renamed x.json (from w.json)\n-a\n+b')
  })

  it('explains the no-text cases', () => {
    expect(formatDiff({ ...diff, binary: true })).toMatch(/binary file/)
    expect(formatDiff({ ...diff, truncationMode: 'eol_only' })).toMatch(/line endings/)
  })
})
