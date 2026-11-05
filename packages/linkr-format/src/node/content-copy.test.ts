import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  childPath, copyContentTree, irregularEntries, isSafeFolderName, writeGeneratedFile,
} from './content-copy.js'

let base: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'linkr-content-copy-'))
  mkdirSync(join(base, 'repo/.git'), { recursive: true })
  mkdirSync(join(base, 'repo/scripts'), { recursive: true })
  writeFileSync(join(base, 'repo/.git/config'), '[core]\n')
  writeFileSync(join(base, 'repo/entity.json'), '{}')
  writeFileSync(join(base, 'repo/scripts/a.sql'), 'select 1')
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(base, 'outside/keep.txt'), 'original')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('isSafeFolderName / childPath — a folder named by content stays a direct child', () => {
  it('accepts plain names', () => {
    for (const name of ['icu-demo', 'omop_5.4', '_x', 'A1']) expect(isSafeFolderName(name)).toBe(true)
  })

  it('refuses anything that is not one plain segment', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'a\\b', '/abs', '.hidden', '-x', 42, null, undefined]) {
      expect(isSafeFolderName(name)).toBe(false)
    }
  })

  it('resolves under its parent, or throws', () => {
    const parent = join(base, 'seed/projects')
    expect(childPath(parent, 'p1')).toBe(join(parent, 'p1'))
    expect(() => childPath(parent, '../../outside')).toThrow()
    expect(() => childPath(parent, join(base, 'outside'))).toThrow()
  })
})

describe('copyContentTree — content is copied as regular files only', () => {
  it('copies files and folders, without git metadata', () => {
    const to = join(base, 'seed/p1')
    copyContentTree(join(base, 'repo'), to)
    expect(readFileSync(join(to, 'scripts/a.sql'), 'utf-8')).toBe('select 1')
    expect(existsSync(join(to, '.git'))).toBe(false)
  })

  it('refuses a tree holding a file link, before writing anything', () => {
    symlinkSync(join(base, 'outside/keep.txt'), join(base, 'repo/scripts/leak.txt'))
    const to = join(base, 'seed/p1')
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'previous.txt'), 'kept')
    expect(() => copyContentTree(join(base, 'repo'), to)).toThrow(/scripts\/leak\.txt/)
    expect(readFileSync(join(to, 'previous.txt'), 'utf-8')).toBe('kept')
  })

  it('refuses a tree holding a directory link', () => {
    symlinkSync(join(base, 'outside'), join(base, 'repo/linked'))
    expect(() => copyContentTree(join(base, 'repo'), join(base, 'seed/p1'))).toThrow(/linked/)
  })
})

describe('irregularEntries / writeGeneratedFile — generated files never land through a link', () => {
  it('lists the links under a folder', () => {
    mkdirSync(join(base, 'seed/p1'), { recursive: true })
    symlinkSync(join(base, 'outside/keep.txt'), join(base, 'seed/p1/_index.json'))
    expect(irregularEntries(join(base, 'seed'))).toEqual(['p1/_index.json'])
    expect(irregularEntries(join(base, 'repo/scripts'))).toEqual([])
  })

  it('replaces a link with a regular file instead of writing through it', () => {
    const link = join(base, '_index.json')
    symlinkSync(join(base, 'outside/keep.txt'), link)
    writeGeneratedFile(link, '{}')
    expect(lstatSync(link).isFile()).toBe(true)
    expect(readFileSync(link, 'utf-8')).toBe('{}')
    expect(readFileSync(join(base, 'outside/keep.txt'), 'utf-8')).toBe('original')
  })

  it('overwrites an existing regular file', () => {
    const file = join(base, 'seed.json')
    writeFileSync(file, 'old')
    writeGeneratedFile(file, 'new')
    expect(readFileSync(file, 'utf-8')).toBe('new')
  })
})
