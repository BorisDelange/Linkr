/**
 * `scripts/_tree.json` — the IDE files.
 *
 * Keyed by path, with no ids: ids are derived from (projectUid, path) on import,
 * so the versioned tree cannot churn them. The checks that matter are therefore
 * about the tree and the files agreeing — a listed file that is absent imports as
 * an empty script, and a present file that is unlisted never appears in the IDE
 * at all.
 */
import { checkArray, checkString, isObject } from '../check.js'
import type { IssueBag } from '../issue.js'
import { listHint } from '../issue.js'
import { readJson, type EntityTree } from '../tree.js'

const TREE_PATH = 'scripts/_tree.json'

export function validateScripts(tree: EntityTree, bag: IssueBag): void {
  const parsed = readJson(tree, TREE_PATH)
  const present = tree
    .paths()
    .filter((p) => p.startsWith('scripts/') && p !== TREE_PATH)
    .map((p) => p.slice('scripts/'.length))

  if (!parsed.ok) {
    if (parsed.error === 'missing') {
      if (present.length > 0) {
        bag.error(TREE_PATH, '', 'missing-file',
          `${present.length} file(s) under scripts/ but no _tree.json; they would not be imported.`,
          listHint('files', present))
      }
      return
    }
    bag.error(TREE_PATH, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
    return
  }

  const entries = parsed.value
  if (!checkArray(bag, TREE_PATH, '', entries, { required: true, label: 'The script tree' })) return

  const listed = new Set<string>()

  entries.forEach((entry, i) => {
    const pointer = `/${i}`
    if (!isObject(entry)) {
      bag.error(TREE_PATH, pointer, 'wrong-type', 'Each tree entry must be an object.')
      return
    }
    if (!checkString(bag, TREE_PATH, `${pointer}/path`, entry.path, { required: true, label: 'path' })) {
      return
    }
    const p = entry.path as string
    if (listed.has(p)) {
      bag.error(TREE_PATH, `${pointer}/path`, 'duplicate-key', `Duplicate script path "${p}".`)
      return
    }
    listed.add(p)

    if (entry.type === 'folder') return
    if (tree.read(`scripts/${p}`) == null) {
      bag.error(TREE_PATH, `${pointer}/path`, 'missing-file',
        `Script "${p}" is listed in the tree but the file is absent.`)
    }
  })

  for (const p of present) {
    if (!listed.has(p)) {
      bag.warn(`scripts/${p}`, '', 'orphan-record',
        `File is not listed in _tree.json and would not be imported.`,
        `add {"path": "${p}", "type": "file"} to ${TREE_PATH}`)
    }
  }
}
