/**
 * Copying cloned content trees into a build output (Node only).
 *
 * The default-data fetch and the portal build splice other people's repositories
 * into a folder that is then published. Content is data: it arrives as regular
 * files and directories only, and it lands where the build decides, never where a
 * path written inside the content points.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** One plain path segment: a folder name a content file may choose for itself. */
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isSafeFolderName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_SEGMENT.test(name) && name !== '.' && name !== '..'
}

/**
 * `parent/name`, for a `name` taken from content. Throws unless `name` is a single
 * plain segment, so the result is always a direct child of `parent`.
 */
export function childPath(parent: string, name: unknown): string {
  if (!isSafeFolderName(name)) throw new Error(`not a plain folder name: ${JSON.stringify(name)}`)
  const base = resolve(parent)
  const dest = resolve(base, name)
  if (dirname(dest) !== base) throw new Error(`${JSON.stringify(name)} is not inside ${parent}`)
  return dest
}

const GIT_DIR = '.git'

/**
 * Replace `to` with a copy of `from`, minus git metadata. Throws on a symbolic
 * link or any entry that is neither a regular file nor a directory, before
 * anything is written: such an entry would make the copy read or write outside
 * both trees.
 */
export function copyContentTree(from: string, to: string): void {
  const files: string[] = []
  const dirs: string[] = []
  collect(from, from, files, dirs)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  for (const dir of dirs) mkdirSync(join(to, dir), { recursive: true })
  for (const file of files) copyFileSync(join(from, file), join(to, file))
}

function collect(root: string, dir: string, files: string[], dirs: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === GIT_DIR) continue
    const full = join(dir, name)
    const st = lstatSync(full)
    const rel = relative(root, full)
    if (st.isDirectory()) {
      dirs.push(rel)
      collect(root, full, files, dirs)
    } else if (st.isFile()) {
      files.push(rel)
    } else {
      throw new Error(`${rel.split(sep).join('/')} is not a regular file`)
    }
  }
}

/** Every entry under `root` that is not a regular file nor a directory, relative. */
export function irregularEntries(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isDirectory()) visit(full)
      else if (!st.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  visit(root)
  return out.sort()
}

/**
 * Write a generated file as a new regular file: whatever stood at `path` before
 * (a link included) is removed first rather than written through.
 */
export function writeGeneratedFile(path: string, content: string): void {
  try {
    if (!lstatSync(path).isDirectory()) unlinkSync(path)
  } catch {
    // Absent: nothing to replace.
  }
  writeFileSync(path, content, { flag: 'wx' })
}
