/**
 * `linkr-validate <path…>` — validate project trees on disk.
 *
 * Exits non-zero when any tree has an error (warnings alone do not fail), so it
 * drops straight into CI for the linkr-public-content repos.
 */
import { formatIssues, hasErrors, validateProject } from '../index.js'
import { FsTree } from './fs-tree.js'

const targets = process.argv.slice(2)

if (targets.length === 0) {
  console.error('usage: linkr-validate <project-dir> [<project-dir>…]')
  process.exit(2)
}

let failed = false

for (const target of targets) {
  const issues = validateProject(new FsTree(target))
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors

  console.log(`\n=== ${target}`)
  console.log(formatIssues(issues))
  console.log(`--- ${errors} error(s), ${warnings} warning(s)`)

  if (hasErrors(issues)) failed = true
}

process.exit(failed ? 1 : 0)
