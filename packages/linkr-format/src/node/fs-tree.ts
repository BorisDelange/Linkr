/**
 * Disk-backed EntityTree (Node only).
 *
 * Kept in its own entry point so the core package stays runtime-agnostic: the
 * browser build must never pull `node:fs` in through a barrel import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
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
    try {
      return readFileSync(join(this.root, path), 'utf-8')
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
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(root, full, out)
    else out.push(relative(root, full).split(sep).join('/'))
  }
}
