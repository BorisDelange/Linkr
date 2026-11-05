import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsTree } from './fs-tree.js'
import { buildSeedManifest } from '../seed-manifest.js'

let base: string
let root: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'linkr-fs-tree-'))
  root = join(base, 'tree')
  mkdirSync(join(base, 'elsewhere'), { recursive: true })
  writeFileSync(join(base, 'elsewhere', 'note.txt'), 'not part of the tree\n')
  mkdirSync(join(root, 'databases/demo/data'), { recursive: true })
  writeFileSync(join(root, 'entity.json'), '{"type":"workspace"}')
  writeFileSync(join(root, 'databases/demo/entity.json'), '{"entityId":"demo"}')
  writeFileSync(join(root, 'databases/demo/mapping.json'), '{}')
  writeFileSync(join(root, 'databases/demo/data/person.parquet'), '')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('FsTree — a content tree is read as regular files inside its root only', () => {
  it('lists and reads regular files', () => {
    const tree = new FsTree(root)
    expect(tree.paths()).toContain('databases/demo/mapping.json')
    expect(tree.read('databases/demo/mapping.json')).toBe('{}')
    expect(tree.read('./databases/demo/mapping.json')).toBe('{}')
  })

  it('neither lists nor reads a file link', () => {
    symlinkSync(join(base, 'elsewhere/note.txt'), join(root, 'databases/demo/schema.ddl'))
    symlinkSync('../../../elsewhere/note.txt', join(root, 'databases/demo/rel.txt'))
    const tree = new FsTree(root)
    expect(tree.paths()).not.toContain('databases/demo/schema.ddl')
    expect(tree.paths()).not.toContain('databases/demo/rel.txt')
    expect(tree.read('databases/demo/schema.ddl')).toBeNull()
    expect(tree.read('databases/demo/rel.txt')).toBeNull()
  })

  it('neither walks nor reads through a directory link', () => {
    symlinkSync(join(base, 'elsewhere'), join(root, 'linked'))
    const tree = new FsTree(root)
    expect(tree.paths().some((p) => p.startsWith('linked'))).toBe(false)
    expect(tree.read('linked/note.txt')).toBeNull()
  })

  it('reads nothing outside its root by path', () => {
    const tree = new FsTree(root)
    expect(tree.read('../elsewhere/note.txt')).toBeNull()
    expect(tree.read('databases/../../elsewhere/note.txt')).toBeNull()
    expect(tree.read(join(base, 'elsewhere/note.txt'))).toBeNull()
  })

  it('keeps a linked schema out of the seed manifest', () => {
    symlinkSync(join(base, 'elsewhere/note.txt'), join(root, 'databases/demo/schema.ddl'))
    const manifest = buildSeedManifest(new FsTree(root), { seedBaseUrl: '/data/seed/ws' })
    expect(JSON.stringify(manifest)).not.toContain('not part of the tree')
  })
})
