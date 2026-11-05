import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { isWorkspaceTree, validateWorkspace } from './workspace.js'

const codes = (files: Record<string, string>) => validateWorkspace(new MemoryTree(files)).map((i) => [i.path, i.severity, i.code])

describe('workspace indexes', () => {
  it('accepts well-formed indexes', () => {
    expect(codes({
      'wiki/_tree.json': JSON.stringify([{ entityId: 'home', parentEntityId: null }, { entityId: 'faq', parentEntityId: 'home' }]),
      'wiki/_attachments/_meta.json': JSON.stringify([{ pageEntityId: 'home', fileName: 'a.png' }]),
      'wiki/_attachments/home/a.png': '',
      'data-dictionaries/_dictionaries.json': JSON.stringify([{ entityId: 'core', name: 'Core', git: { url: 'https://x/core', branch: 'main' } }]),
    })).toEqual([])
  })

  it('needs unique page entityIds, reads an old tree with ids as legacy', () => {
    expect(codes({ 'wiki/_tree.json': JSON.stringify([{ entityId: 'home' }, { entityId: 'home' }, { id: 'u1', parentId: null }, {}]) })).toEqual([
      ['wiki/_tree.json', 'error', 'duplicate-key'],
      ['wiki/_tree.json', 'warning', 'legacy-format'],
      ['wiki/_tree.json', 'error', 'missing-field'],
    ])
  })

  it('flags an attachment listed twice, one of no page, and one with no bytes', () => {
    expect(codes({
      'wiki/_tree.json': JSON.stringify([{ entityId: 'home' }]),
      'wiki/_attachments/_meta.json': JSON.stringify([
        { pageEntityId: 'home', fileName: 'a.png' }, { pageEntityId: 'home', fileName: 'a.png' },
        { pageEntityId: 'gone', fileName: 'b.png' }, { pageId: 'u1', fileName: 'c.png' },
      ]),
      'wiki/_attachments/home/a.png': '',
      'wiki/_attachments/gone/b.png': '',
    })).toEqual([
      ['wiki/_attachments/_meta.json', 'error', 'duplicate-key'],
      ['wiki/_attachments/_meta.json', 'warning', 'orphan-record'],
      ['wiki/_attachments/_meta.json', 'warning', 'legacy-format'],
    ])
  })

  it('needs each dictionary\'s entityId, unique, and its repository url', () => {
    expect(codes({
      'data-dictionaries/_dictionaries.json': JSON.stringify([
        { entityId: 'core', git: { url: 'https://x/a' } }, { entityId: 'core', git: { url: 'https://x/b' } },
        { git: { url: 'https://x/c' } }, { entityId: 'd', git: { url: 42 } },
      ]),
    })).toEqual([
      ['data-dictionaries/_dictionaries.json', 'error', 'duplicate-key'],
      ['data-dictionaries/_dictionaries.json', 'error', 'missing-field'],
      ['data-dictionaries/_dictionaries.json', 'error', 'missing-field'],
    ])
    expect(codes({ 'data-dictionaries/_dictionaries.json': '{' })).toEqual([['data-dictionaries/_dictionaries.json', 'error', 'invalid-json']])
  })

  it('recognises a workspace tree by its declared type or its historical manifest', () => {
    expect(isWorkspaceTree(new MemoryTree({ 'entity.json': '{"type":"workspace"}' }))).toBe(true)
    expect(isWorkspaceTree(new MemoryTree({ 'workspace.json': '{}' }))).toBe(true)
    expect(isWorkspaceTree(new MemoryTree({ 'entity.json': '{"type":"project"}' }))).toBe(false)
  })
})
