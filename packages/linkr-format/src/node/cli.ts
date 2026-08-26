/**
 * `linkr-validate <path…>` — validate entity trees on disk.
 *
 * The kind is detected from the metadata file each tree carries, so a caller can
 * point at a directory of mixed entities — which is what CI over a content repo
 * needs. Exits non-zero when any tree has an error; warnings alone do not fail.
 */
import { detectTreeKind, formatIssues, hasErrors, validateEntity, validateProject } from '../index.js'
import { FsTree } from './fs-tree.js'
import { manifestList } from '../layout.js'

const targets = process.argv.slice(2)

if (targets.length === 0) {
  console.error('usage: linkr-validate <entity-dir> [<entity-dir>…]')
  process.exit(2)
}

let failed = false

for (const target of targets) {
  const tree = new FsTree(target)
  const kind = detectTreeKind(tree)

  if (kind == null) {
    console.log(`\n=== ${target}`)
    console.log(`ERROR  not a Linkr entity tree — no ${manifestList()} at its root.`)
    failed = true
    continue
  }

  const issues = kind === 'project' ? validateProject(tree) : validateEntity(tree, kind)
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  console.log(`\n=== ${target} (${kind})`)
  console.log(formatIssues(issues))
  console.log(`--- ${errors} error(s), ${warnings} warning(s)`)

  if (hasErrors(issues)) failed = true
}

process.exit(failed ? 1 : 0)
