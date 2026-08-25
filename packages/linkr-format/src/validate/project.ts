/**
 * `project.json` and the project tree as a whole.
 *
 * Order matters: datasets are validated first so dashboards can be checked
 * against real column ids rather than reporting every reference as unknown.
 */
import { checkLocalized, checkString, isObject } from '../check.js'
import { IssueBag, type Issue } from '../issue.js'
import { readJson, type EntityTree } from '../tree.js'
import { validateDashboards } from './dashboards.js'
import { validateDatasets } from './datasets.js'
import { validateScripts } from './scripts.js'

/** Validate a whole project tree. Returns every issue found, errors and warnings. */
export function validateProject(tree: EntityTree): Issue[] {
  const bag = new IssueBag()

  validateProjectFile(tree, bag)
  const datasets = validateDatasets(tree, bag)
  validateDashboards(tree, bag, datasets)
  validateScripts(tree, bag)

  return bag.all()
}

function validateProjectFile(tree: EntityTree, bag: IssueBag): void {
  const path = 'project.json'
  const parsed = readJson(tree, path)

  if (!parsed.ok) {
    if (parsed.error === 'missing') {
      bag.error(path, '', 'missing-file', 'project.json is required at the tree root.')
    } else {
      bag.error(path, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
    }
    return
  }

  const project = parsed.value
  if (!isObject(project)) {
    bag.error(path, '', 'wrong-type', 'project.json must be an object.')
    return
  }

  checkLocalized(bag, path, '/name', project.name, { required: true })
  if (project.description != null) {
    checkLocalized(bag, path, '/description', project.description)
  }
  checkString(bag, path, '/projectId', project.projectId, { label: 'projectId' })

  // Stamped by the exporter and read on import to interpret the tree. Absent, the
  // app still reads the project, so this is a warning rather than an error.
  if (project.appVersion == null) {
    bag.warn(path, '/appVersion', 'missing-field',
      'No appVersion; the tree does not record which format version wrote it.')
  } else {
    checkString(bag, path, '/appVersion', project.appVersion, { label: 'appVersion' })
  }

  // `uid` is the exporting instance's local primary key. It is deliberately
  // dropped on export (a delete+reimport regenerates it), so a tree carrying one
  // was hand-authored or came from an older exporter, and it churns the git diff.
  if (project.uid != null) {
    bag.warn(path, '/uid', 'legacy-format',
      'project.json carries a local `uid`; exports omit it so re-imports stay stable.',
      'remove the `uid` field')
  }
  if (project.ownerId != null) {
    bag.warn(path, '/ownerId', 'legacy-format',
      'project.json carries `ownerId`, which is specific to the exporting instance.',
      'remove the `ownerId` field')
  }
}
