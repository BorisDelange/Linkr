/**
 * `scripts/_tree.json` — a project's IDE files.
 *
 * The same metadata-less, path-keyed tree that SQL collections and ETL pipelines
 * use, so it delegates to the shared checker rather than repeating it.
 */
import type { IssueBag } from '../issue.js'
import type { EntityTree } from '../tree.js'
import { validateFileTree } from './file-tree.js'

export function validateScripts(tree: EntityTree, bag: IssueBag): void {
  validateFileTree(tree, bag, {
    treePath: 'scripts/_tree.json',
    filePrefix: 'scripts/',
  })
}
