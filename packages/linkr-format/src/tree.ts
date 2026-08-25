/**
 * A Linkr entity tree, decoupled from where its bytes live.
 *
 * The validator runs against this interface, never against `fs` — so the exact
 * same checks serve the MCP server (files on disk), the app's import path (a
 * parsed ZIP in the browser) and CI (a cloned repo). A Node-only or
 * browser-only validator would have forced a second implementation, which is
 * the duplication this package exists to end.
 */

export interface EntityTree {
  /** Every file path in the tree, relative to its root, `/`-separated. */
  paths(): string[]
  /** UTF-8 text, or null when the path does not exist. */
  read(path: string): string | null
}

/** In-memory tree — used by tests, and by any caller that already holds the files. */
export class MemoryTree implements EntityTree {
  private readonly files: Record<string, string>

  constructor(files: Record<string, string>) {
    this.files = files
  }

  paths(): string[] {
    return Object.keys(this.files)
  }

  read(path: string): string | null {
    return this.files[path] ?? null
  }
}

export interface ParsedFile<T = unknown> {
  ok: boolean
  value?: T
  /** Parse error message, when `ok` is false. */
  error?: string
}

/** Read + JSON.parse one file, reporting a missing file and a syntax error apart. */
export function readJson<T = unknown>(tree: EntityTree, path: string): ParsedFile<T> {
  const raw = tree.read(path)
  if (raw == null) return { ok: false, error: 'missing' }
  try {
    return { ok: true, value: JSON.parse(raw) as T }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Files directly under `dir/`, non-recursive, excluding `_`-prefixed metadata. */
export function filesIn(tree: EntityTree, dir: string, extension?: string): string[] {
  const prefix = `${dir}/`
  return tree
    .paths()
    .filter((p) => p.startsWith(prefix))
    .filter((p) => !p.slice(prefix.length).includes('/'))
    .filter((p) => !p.slice(prefix.length).startsWith('_'))
    .filter((p) => (extension ? p.endsWith(extension) : true))
    .sort()
}
