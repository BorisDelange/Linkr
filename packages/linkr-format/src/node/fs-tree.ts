/**
 * Disk-backed EntityTree (Node only).
 *
 * Kept in its own entry point so the core package stays runtime-agnostic: the
 * browser build must never pull `node:fs` in through a barrel import.
 *
 * The tree is often a clone of someone else's repository, so it exposes only
 * regular files physically inside its root: symbolic links are never listed nor
 * followed, and a path that leaves the root reads as absent.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { EntityTree } from '../tree.js'

/** Never part of an entity tree, and huge — walking them wastes time and noise. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

export class FsTree implements EntityTree {
  private cache: string[] | null = null
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  paths(): string[] {
    if (this.cache) return this.cache
    const out: string[] = []
    walk(this.root, this.root, out)
    this.cache = out.sort()
    return this.cache
  }

  read(path: string): string | null {
    const segments = path.split(/[/\\]/).filter((s) => s !== '' && s !== '.')
    if (isAbsolute(path) || !segments.length || segments.includes('..')) return null
    try {
      // Every component is checked, not only the last: a linked directory on the
      // way would otherwise carry the read outside the root.
      let full = this.root
      for (const segment of segments) {
        full = join(full, segment)
        if (lstatSync(full).isSymbolicLink()) return null
      }
      if (!lstatSync(full).isFile()) return null
      const rel = relative(realpathSync(this.root), realpathSync(full))
      if (rel.startsWith('..') || isAbsolute(rel)) return null
      return readFileSync(full, 'utf-8')
    } catch {
      return null
    }
  }
}

function walk(root: string, dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(root, full, out)
    else if (st.isFile()) out.push(relative(root, full).split(sep).join('/'))
  }
}
