/**
 * The `_tree.json` + files pattern, shared by SQL collections, ETL pipelines and
 * project scripts.
 *
 * All three are a metadata JSON plus a path-keyed tree plus the files themselves.
 * Keyed by path with no ids — ids are derived from (ownerId, path) on import — so
 * the checks that matter are the tree and the disk agreeing: a listed file that
 * is absent imports as empty, and a present file that is unlisted never appears
 * in the app at all.
 */
import { checkArray, checkString, isObject } from '../check.js'
import type { IssueBag } from '../issue.js'
import { listHint } from '../issue.js'
import { readJson, type EntityTree } from '../tree.js'

export interface FileTreeOptions {
  /** Path of the tree file, e.g. `_tree.json` or `scripts/_tree.json`. */
  treePath: string
  /** Prefix the tree's paths are relative to; `''` when the tree is at the root. */
  filePrefix: string
  /** Files that are part of the entity but never listed in the tree. */
  ignore?: (path: string) => boolean
}

/**
 * Docs and metadata live alongside the tree without being part of it.
 *
 * `_<kebab>.json` covers the underscore-prefixed manifests and sidecars;
 * `entity.json` is the shared manifest name every kind is moving to. Leaving it
 * out would report a perfectly good new-format tree as carrying an unlisted file.
 */
const ALWAYS_IGNORED = /^(README(\.[a-z-]+)?\.md|LICENSE\.md|entity\.json|_[a-z-]+\.json|\.gitignore|\.gitattributes)$/

export function validateFileTree(
  tree: EntityTree,
  bag: IssueBag,
  { treePath, filePrefix, ignore }: FileTreeOptions,
): void {
  const parsed = readJson(tree, treePath)

  const present = tree
    .paths()
    .filter((p) => (filePrefix ? p.startsWith(filePrefix) : true))
    .map((p) => p.slice(filePrefix.length))
    .filter((p) => p && !ALWAYS_IGNORED.test(p) && !p.includes('/.git/'))
    .filter((p) => !ignore?.(p))

  if (!parsed.ok) {
    if (parsed.error === 'missing') {
      if (present.length > 0) {
        bag.error(treePath, '', 'missing-file',
          `${present.length} file(s) present but no ${treePath}; they would not be imported.`,
          listHint('files', present))
      }
      return
    }
    bag.error(treePath, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
    return
  }

  const entries = parsed.value
  if (!checkArray(bag, treePath, '', entries, { required: true, label: 'The file tree' })) return

  const listed = new Set<string>()
  const folders = new Set<string>()

  entries.forEach((entry, i) => {
    const pointer = `/${i}`
    if (!isObject(entry)) {
      bag.error(treePath, pointer, 'wrong-type', 'Each tree entry must be an object.')
      return
    }
    if (!checkString(bag, treePath, `${pointer}/path`, entry.path, {
      required: true,
      label: 'path',
    })) return

    const p = entry.path as string
    if (listed.has(p) || folders.has(p)) {
      bag.error(treePath, `${pointer}/path`, 'duplicate-key', `Duplicate path "${p}".`)
      return
    }

    if (entry.type === 'folder') {
      folders.add(p)
      return
    }
    listed.add(p)

    if (tree.read(`${filePrefix}${p}`) == null) {
      bag.error(treePath, `${pointer}/path`, 'missing-file',
        `"${p}" is listed in the tree but the file is absent.`)
    }
  })

  // A file's parent folder must be declared, or the import reparents it to the
  // root and the layout the author built silently flattens.
  for (const p of listed) {
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null
    if (parent && !folders.has(parent)) {
      bag.error(treePath, '', 'orphan-record',
        `"${p}" sits in folder "${parent}", which the tree does not declare.`,
        `add {"path": "${parent}", "type": "folder"}`)
    }
  }

  for (const p of present) {
    if (!listed.has(p)) {
      bag.warn(`${filePrefix}${p}`, '', 'orphan-record',
        'File is not listed in the tree and would not be imported.',
        `add {"path": "${p}", "type": "file"} to ${treePath}`)
    }
  }
}
