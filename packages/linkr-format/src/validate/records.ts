/**
 * Entities that are a metadata file plus a flat array of records: DQ rule sets
 * (`checks.json`), mapping projects (`mappings.json`), and cohorts
 * (`cohorts/*.json`, in a project or a database).
 *
 * The checks here are the ones whose absence is silent in the app. A DQ check
 * with no SQL never runs; a mapping row with no target concept id maps nothing;
 * a cohort with neither criteria nor SQL selects nobody. All three import
 * without complaint and simply do not work.
 */
import { checkArray, checkEnum, checkLocalized, checkNumber, checkString, isObject } from '../check.js'
import type { IssueBag } from '../issue.js'
import { filesIn, readJson, type EntityTree } from '../tree.js'
import { CONTENT_FILE, MANIFEST, SCORES_CSV_DIR, SCORES_CSV_REQUIRED_COLUMNS, scoreMethodOfPath } from '../layout.js'
import { manifestPath } from './entities.js'

// `info` is what exports written before `notice` carry; the app reads it as `notice`.
const DQ_SEVERITIES = ['error', 'warning', 'notice', 'info'] as const
// Kahn et al. (2016), plus the pre-Kahn names the app maps onto them on read.
const DQ_CATEGORIES = ['conformance', 'completeness', 'plausibility', 'validity', 'consistency', 'uniqueness'] as const
const DQ_SUBCATEGORIES = ['value', 'relational', 'computational', 'uniqueness', 'atemporal', 'temporal'] as const
// Which subcategory each Kahn category admits; a legacy category carries its own
// (`dq_taxonomy.py` on the server refuses any other pair).
const DQ_SUBCATEGORIES_OF: Record<string, readonly string[]> = {
  conformance: ['value', 'relational', 'computational'],
  completeness: [],
  plausibility: ['uniqueness', 'atemporal', 'temporal'],
}
const DQ_ORIGINS = ['ddl', 'mapping', 'manual'] as const
const COHORT_LEVELS = ['patient', 'visit', 'visit_detail', 'event'] as const
const MAPPING_STATUSES = ['approved', 'pending', 'rejected', 'draft'] as const

const DQ_PROFILE_MODES = ['all', 'selected'] as const

/**
 * A quality profile's manifest: a name, and the rule sets it draws from as
 * portable pointers — `{ ruleSetRef, mode: 'all' | 'selected', checkKeys? }`.
 * A local `ruleSetId` must not travel: it addresses nothing on another instance.
 */
export function validateDqProfile(tree: EntityTree, bag: IssueBag): void {
  const path = manifestPath(tree, 'dq-profile')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? 'entity.json is required at the root of a quality profile.'
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  if (!isObject(parsed.value)) {
    bag.error(path, '', 'wrong-type', 'entity.json must be an object.')
    return
  }
  checkLocalized(bag, path, '/name', parsed.value.name, { required: true })
  if (parsed.value.sources == null) return
  if (!checkArray(bag, path, '/sources', parsed.value.sources, { label: 'sources' })) return
  parsed.value.sources.forEach((source, i) => {
    const pointer = `/sources/${i}`
    if (!isObject(source)) {
      bag.error(path, pointer, 'wrong-type', 'Each source must be an object.')
      return
    }
    checkEnum(bag, path, `${pointer}/mode`, source.mode, DQ_PROFILE_MODES, { label: 'mode', required: true })
    if (source.mode === 'selected') {
      checkArray(bag, path, `${pointer}/checkKeys`, source.checkKeys, { required: true, label: 'checkKeys' })
    }
    if (!isObject(source.ruleSetRef) || (source.ruleSetRef.lineageId == null && source.ruleSetRef.entityId == null)) {
      bag.error(path, `${pointer}/ruleSetRef`, 'missing-field',
        'A source names its rule set by ruleSetRef ({ lineageId?, entityId? }).',
        'Without it the import cannot tell which local rule set the checks come from.')
    }
  })
}

/**
 * The categories checks are filed under: `{ key, name, parentKey }`, a tree by
 * `parentKey`. Before categories had names the list held bare keys, which
 * still read (as a category named by its key).
 */
function validateCheckGroups(bag: IssueBag, path: string, groups: unknown): void {
  if (!checkArray(bag, path, '/checkGroups', groups, { label: 'checkGroups' })) return
  const keys = new Set<string>()
  groups.forEach((group, i) => {
    const pointer = `/checkGroups/${i}`
    if (typeof group === 'string') {
      bag.warn(path, pointer, 'legacy-format', 'A category is a bare key; the current format names it.',
        'Write {"key": "…", "name": {"en": "…", "fr": "…"}, "parentKey": null}.')
      keys.add(group)
      return
    }
    if (!isObject(group)) {
      bag.error(path, pointer, 'wrong-type', 'Each category must be an object.')
      return
    }
    if (!checkString(bag, path, `${pointer}/key`, group.key, { required: true, label: 'key' })) return
    if (keys.has(group.key)) {
      bag.error(path, `${pointer}/key`, 'duplicate-key', `Duplicate category key "${group.key}".`,
        'Checks point at their category by its key: each must be unique in the rule set.')
    }
    keys.add(group.key)
    checkLocalized(bag, path, `${pointer}/name`, group.name, { label: 'name' })
    if (group.parentKey != null) checkString(bag, path, `${pointer}/parentKey`, group.parentKey, { label: 'parentKey' })
  })
  groups.forEach((group, i) => {
    if (isObject(group) && typeof group.parentKey === 'string' && !keys.has(group.parentKey)) {
      bag.warn(path, `/checkGroups/${i}/parentKey`, 'unknown-reference',
        `parentKey "${group.parentKey}" names no category of the rule set.`, 'The category is shown at the top.')
    }
  })
}

/** `rule-set.json` + `checks.json`. */
export function validateDqRuleSet(tree: EntityTree, bag: IssueBag): void {
  const path = manifestPath(tree, 'dq-rule-set')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? 'rule-set.json is required at the root of a DQ rule set.'
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  if (!isObject(parsed.value)) {
    bag.error(path, '', 'wrong-type', 'rule-set.json must be an object.')
    return
  }
  checkLocalized(bag, path, '/name', parsed.value.name, { required: true })
  if (parsed.value.description != null) {
    checkLocalized(bag, path, '/description', parsed.value.description, { label: 'description' })
  }

  if (parsed.value.checkGroups != null) validateCheckGroups(bag, path, parsed.value.checkGroups)

  const checksPath = CONTENT_FILE.dqChecks
  const checks = readJson(tree, checksPath)
  if (!checks.ok) {
    // A rule set with no checks is legitimate — a freshly created, empty one.
    if (checks.error !== 'missing') {
      bag.error(checksPath, '', 'invalid-json', `Cannot parse JSON: ${checks.error}`)
    }
    return
  }
  if (!checkArray(bag, checksPath, '', checks.value, { required: true, label: 'checks.json' })) return

  const seen = new Set<string>()
  const seenKeys = new Set<string>()
  checks.value.forEach((check, i) => {
    const pointer = `/${i}`
    if (!isObject(check)) {
      bag.error(checksPath, pointer, 'wrong-type', 'Each check must be an object.')
      return
    }
    checkLocalized(bag, checksPath, `${pointer}/name`, check.name, { required: true, label: 'name' })
    if (check.description != null) {
      checkLocalized(bag, checksPath, `${pointer}/description`, check.description, { label: 'description' })
    }
    if (check.groupKey != null) {
      checkString(bag, checksPath, `${pointer}/groupKey`, check.groupKey, { label: 'groupKey' })
    }
    // Without SQL the check runs nothing and silently scores nothing.
    checkString(bag, checksPath, `${pointer}/sql`, check.sql, { required: true, label: 'sql' })

    if (check.severity != null) {
      checkEnum(bag, checksPath, `${pointer}/severity`, check.severity, DQ_SEVERITIES, {
        label: 'severity',
      })
    }
    if (check.category != null) {
      checkEnum(bag, checksPath, `${pointer}/category`, check.category, DQ_CATEGORIES, { label: 'category' })
    }
    if (check.subcategory != null
      && checkEnum(bag, checksPath, `${pointer}/subcategory`, check.subcategory, DQ_SUBCATEGORIES, { label: 'subcategory' })) {
      const fitting = typeof check.category === 'string' ? DQ_SUBCATEGORIES_OF[check.category] : undefined
      if (fitting && !fitting.includes(check.subcategory)) {
        bag.error(checksPath, `${pointer}/subcategory`, 'wrong-type',
          `subcategory "${check.subcategory}" does not belong to ${check.category}.`,
          fitting.length ? `One of: ${fitting.join(', ')}.` : `${check.category} has no subcategory: use null.`)
      }
    }
    if (check.origin != null) {
      checkEnum(bag, checksPath, `${pointer}/origin`, check.origin, DQ_ORIGINS, { label: 'origin' })
    }
    if (check.threshold != null
      && checkNumber(bag, checksPath, `${pointer}/threshold`, check.threshold, { label: 'threshold' })
      && (check.threshold < 0 || check.threshold > 100)) {
      bag.error(checksPath, `${pointer}/threshold`, 'wrong-type',
        `threshold ${check.threshold} is out of range.`,
        'A percentage of violated rows, between 0 and 100.')
    }

    // Optional: an export from before keys were stored derives them on import.
    if (check.checkKey != null
      && checkString(bag, checksPath, `${pointer}/checkKey`, check.checkKey, { label: 'checkKey' })) {
      if (seenKeys.has(check.checkKey)) {
        bag.error(checksPath, `${pointer}/checkKey`, 'duplicate-key', `Duplicate checkKey "${check.checkKey}".`,
          'Quality profiles point at a check by its key: each must be unique in the rule set.')
      }
      seenKeys.add(check.checkKey)
    }

    if (typeof check.id === 'string') {
      if (seen.has(check.id)) {
        bag.error(checksPath, `${pointer}/id`, 'duplicate-key', `Duplicate check id "${check.id}".`)
      }
      seen.add(check.id)
    }
  })
}

/** `project.json` + `mappings.json` — a concept-mapping project. */
export function validateMappingProject(tree: EntityTree, bag: IssueBag): void {
  // A mapping project's METADATA lives in `project.json` (or the shared
  // `entity.json`); `mappings.json` below is its content, and is what tells this
  // apart from a plain project — hence the two different paths here.
  const path = manifestPath(tree, 'project')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? `${path} is required at the root of a mapping project.`
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  if (!isObject(parsed.value)) {
    bag.error(path, '', 'wrong-type', `${path} must be an object.`)
    return
  }
  checkLocalized(bag, path, '/name', parsed.value.name, { required: true })
  validateScoreCsvs(tree, bag, path, parsed.value.versionedScoreMethods)
  validateConceptSetRefs(bag, path, parsed.value.conceptSets)

  const mappingsPath = MANIFEST['mapping-project']
  const mappings = readJson(tree, mappingsPath)
  if (!mappings.ok) {
    if (mappings.error !== 'missing') {
      bag.error(mappingsPath, '', 'invalid-json', `Cannot parse JSON: ${mappings.error}`)
    }
    return
  }
  if (!checkArray(bag, mappingsPath, '', mappings.value, {
    required: true,
    label: 'mappings.json',
  })) return

  mappings.value.forEach((mapping, i) => {
    const pointer = `/${i}`
    if (!isObject(mapping)) {
      bag.error(mappingsPath, pointer, 'wrong-type', 'Each mapping must be an object.')
      return
    }
    // The source code is the row's identity; without it nothing can be matched
    // back to the local vocabulary.
    checkString(bag, mappingsPath, `${pointer}/sourceConceptCode`, mapping.sourceConceptCode, {
      required: true,
      label: 'sourceConceptCode',
    })
    // A row with no target concept id maps to nothing — it imports and the
    // alignment silently does not exist.
    if (mapping.targetConceptId != null) {
      checkNumber(bag, mappingsPath, `${pointer}/targetConceptId`, mapping.targetConceptId, {
        label: 'targetConceptId',
        integer: true,
      })
    } else if (mapping.status === 'approved') {
      bag.error(mappingsPath, `${pointer}/targetConceptId`, 'missing-field',
        'An approved mapping needs a targetConceptId; without one it maps nothing.')
    }
    if (mapping.status != null) {
      checkEnum(bag, mappingsPath, `${pointer}/status`, mapping.status, MAPPING_STATUSES, {
        label: 'status',
      })
    }
  })
}

/**
 * `conceptSets` — the concept sets the project uses, named portably: by the
 * set's `uniqueId` (+ the dictionary `sourceRepo`), or by `name` for a
 * hand-made set without one. A ref with neither resolves to nothing.
 */
function validateConceptSetRefs(bag: IssueBag, manifest: string, refs: unknown): void {
  if (!checkArray(bag, manifest, '/conceptSets', refs, { label: 'conceptSets' })) return
  refs.forEach((ref, i) => {
    const pointer = `/conceptSets/${i}`
    if (!isObject(ref)) {
      bag.error(manifest, pointer, 'wrong-type', 'Each concept set ref must be an object.')
      return
    }
    if (ref.uniqueId == null && ref.name == null) {
      bag.error(manifest, pointer, 'missing-field', 'A concept set ref needs a uniqueId (or, for a hand-made set, a name).')
      return
    }
    if (ref.uniqueId != null) checkString(bag, manifest, `${pointer}/uniqueId`, ref.uniqueId, { label: 'uniqueId' })
    if (ref.sourceRepo != null) checkString(bag, manifest, `${pointer}/sourceRepo`, ref.sourceRepo, { label: 'sourceRepo' })
    if (ref.name != null) checkString(bag, manifest, `${pointer}/name`, ref.name, { label: 'name' })
  })
}

/**
 * `similarity-scores/<method>.csv` — the versioned methods' suggestions.
 *
 * A CSV missing a key column imports as nothing, and one whose method the entity
 * does not list is dropped by the next export from the app (only listed methods
 * are written), so both are worth saying.
 */
function validateScoreCsvs(tree: EntityTree, bag: IssueBag, manifest: string, listed: unknown): void {
  let versioned = new Set<string>()
  if (checkArray(bag, manifest, '/versionedScoreMethods', listed, { label: 'versionedScoreMethods' })) {
    listed.forEach((m, i) => {
      checkString(bag, manifest, `/versionedScoreMethods/${i}`, m, { required: true, label: 'versionedScoreMethods item' })
    })
    versioned = new Set(listed.filter((m): m is string => typeof m === 'string'))
  }
  for (const path of tree.paths().filter((p) => p.startsWith(`${SCORES_CSV_DIR}/`))) {
    const method = scoreMethodOfPath(path)
    if (!method) {
      if (path.endsWith('.csv')) {
        bag.warn(path, '', 'orphan-record', 'This path is not a score method the app can read; it is ignored.')
      }
      continue
    }
    const header = (tree.read(path) ?? '').split('\n', 1)[0].replace(/\r$/, '').split(',')
    const missing = SCORES_CSV_REQUIRED_COLUMNS.filter((c) => !header.includes(c))
    if (missing.length > 0) {
      bag.error(path, '', 'csv-header-mismatch', `Missing columns: ${missing.join(', ')}.`,
        `Expected at least: ${SCORES_CSV_REQUIRED_COLUMNS.join(', ')}.`)
    }
    if (!versioned.has(method)) {
      bag.warn(path, '', 'orphan-record',
        `"${method}" is not in versionedScoreMethods: it imports, but the next export drops it.`)
    }
  }
}

/**
 * `cohorts/*.json` — one JSON per cohort, in a project tree or a database tree
 * (a database's own cohorts). Absent is legitimate.
 */
export function validateCohortFiles(tree: EntityTree, bag: IssueBag): void {
  for (const path of filesIn(tree, 'cohorts', '.json')) {
    const parsed = readJson(tree, path)
    if (!parsed.ok) {
      bag.error(path, '', 'invalid-json', `Cannot parse JSON: ${parsed.error}`)
      continue
    }
    validateCohort(bag, path, parsed.value)
  }
}

/** Where a project or a database keeps its cohorts' boards: `<cohort key>.json`, one per cohort. */
const COHORT_BOARDS_DIR = 'cohort-boards'

/**
 * `cohort-boards/*.json` — each cohort's own board, in the shape of a project's
 * `patient-dashboards/*.json`, named for the cohort it belongs to. Absent is
 * legitimate: a board is created the first time someone configures it.
 */
export function validateCohortBoardFiles(tree: EntityTree, bag: IssueBag): void {
  for (const path of filesIn(tree, COHORT_BOARDS_DIR, '.json')) {
    const board = readJson(tree, path)
    if (!board.ok) {
      bag.error(path, '', 'invalid-json', `Cannot parse JSON: ${board.error}`)
      continue
    }
    if (!isObject(board.value) || !isObject(board.value.patientDashboard)) {
      bag.error(path, '', 'wrong-type',
        `${path} must be an object with a \`patientDashboard\`, \`tabs\` and \`widgets\`.`)
      continue
    }
    checkLocalized(bag, path, '/patientDashboard/name', board.value.patientDashboard.name, { required: true })
    const cohortFile = `cohorts/${path.slice(COHORT_BOARDS_DIR.length + 1)}`
    if (tree.read(cohortFile) === null) {
      bag.warn(path, '', 'orphan-record',
        `No ${cohortFile}: a board belongs to the cohort of the same key, and this one has none — it is not imported.`,
        `rename it after an existing cohort file, or remove it`)
    }
  }
}

/** One cohort file. */
export function validateCohort(
  bag: IssueBag,
  path: string,
  cohort: unknown,
): void {
  if (!isObject(cohort)) {
    bag.error(path, '', 'wrong-type', 'A cohort file must be an object.')
    return
  }
  checkLocalized(bag, path, '/name', cohort.name, { required: true })
  checkLocalized(bag, path, '/description', cohort.description, { label: 'description' })

  if (cohort.level != null) {
    checkEnum(bag, path, '/level', cohort.level, COHORT_LEVELS, { label: 'level' })
  }

  // A cohort selects patients either through the criteria builder or through
  // hand-written SQL. With neither it imports fine and returns nobody.
  const tree = cohort.criteriaTree
  const hasSql = typeof cohort.customSql === 'string' && cohort.customSql.trim().length > 0
  if (!hasEnabledCriterion(tree) && !hasSql) {
    bag.warn(path, '', 'empty-value',
      'This cohort has neither criteria nor custom SQL; it would select nothing.',
      'add criteria to criteriaTree.children, or set customSql')
  }

  if (tree != null && !isObject(tree)) {
    bag.error(path, '/criteriaTree', 'wrong-type', 'criteriaTree must be an object.')
  } else if (isObject(tree) && tree.children != null && !Array.isArray(tree.children)) {
    bag.error(path, '/criteriaTree/children', 'wrong-type',
      'criteriaTree.children must be an array.')
  }
}

/** Does the tree hold at least one criterion that SQL generation would emit?
 *
 * The tree is recursive — groups nest groups — and a node with `enabled: false`
 * is skipped when the SQL is built, so a tree of disabled criteria selects
 * everyone just as an empty one does. */
function hasEnabledCriterion(node: unknown): boolean {
  if (!isObject(node) || node.enabled === false) return false
  if (node.kind === 'criterion') return true
  return Array.isArray(node.children) && node.children.some(hasEnabledCriterion)
}

/** `catalog.json` — a data catalog. */
export function validateDataCatalog(tree: EntityTree, bag: IssueBag): void {
  const path = manifestPath(tree, 'data-catalog')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? 'catalog.json is required at the root of a data catalog.'
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  const catalog = parsed.value
  if (!isObject(catalog)) {
    bag.error(path, '', 'wrong-type', 'catalog.json must be an object.')
    return
  }

  checkLocalized(bag, path, '/name', catalog.name, { required: true })
  if (catalog.description != null) {
    checkLocalized(bag, path, '/description', catalog.description, { label: 'description' })
  }

  // GitLab/GitHub Pages deployment. The rendered site/ and CI file travel only in
  // the catalog's own repo (not in its workspace-export folder), so their absence
  // is not an error here.
  if (catalog.pagesDeployment != null) {
    const pages = catalog.pagesDeployment
    if (!isObject(pages)) {
      bag.error(path, '/pagesDeployment', 'wrong-type', 'pagesDeployment must be an object.')
    } else {
      checkEnum(bag, path, '/pagesDeployment/provider', pages.provider, ['gitlab', 'github'] as const,
        { required: true, label: 'pagesDeployment.provider' })
      if (pages.updatedAt != null) {
        checkString(bag, path, '/pagesDeployment/updatedAt', pages.updatedAt, { label: 'pagesDeployment.updatedAt' })
      }
    }
  }

  // What cells count beside patients; absent = hospital stays only.
  if (catalog.counts != null) {
    if (!isObject(catalog.counts)) {
      bag.error(path, '/counts', 'wrong-type', 'counts must be an object.')
    } else {
      for (const key of ['visits', 'unitStays'] as const) {
        const value = catalog.counts[key]
        if (value != null && typeof value !== 'boolean') {
          bag.error(path, `/counts/${key}`, 'wrong-type', `counts.${key} must be a boolean.`)
        }
      }
    }
  }

  // Variables are what the catalog breaks its counts down by, crossings which
  // of them are counted together.
  if (catalog.variables == null) {
    if (catalog.dimensions != null || catalog.periodConfig != null) {
      bag.warn(path, '/variables', 'legacy-format',
        'Catalog written before variables and crossings; Linkr converts it on import.')
    }
    return
  }
  if (!isObject(catalog.variables)) {
    bag.error(path, '/variables', 'wrong-type', 'variables must be an object.')
    return
  }
  const variables = catalog.variables
  for (const [id, config] of Object.entries(variables)) {
    if (!(CATALOG_VARIABLES as readonly string[]).includes(id)) {
      bag.warn(path, `/variables/${id}`, 'unknown-reference', `Unknown catalog variable "${id}".`)
      continue
    }
    if (!isObject(config)) {
      bag.error(path, `/variables/${id}`, 'wrong-type', `variables.${id} must be an object.`)
      continue
    }
    if (typeof config.enabled !== 'boolean') {
      bag.error(path, `/variables/${id}/enabled`, 'wrong-type', `variables.${id}.enabled must be a boolean.`)
    }
  }
  if (!Object.values(variables).some((c) => isObject(c) && c.enabled === true)) {
    bag.warn(path, '/variables', 'empty-value', 'No variable enabled; this catalog would count only its concept list.')
  }
  if (catalog.crossings != null) {
    if (!checkArray(bag, path, '/crossings', catalog.crossings, { label: 'crossings' })) return
    catalog.crossings.forEach((crossing, i) => {
      const at = `/crossings/${i}`
      if (!Array.isArray(crossing) || crossing.length < 1 || crossing.length > 3) {
        bag.error(path, at, 'wrong-type', 'A crossing is a list of 1 to 3 variable ids.')
        return
      }
      for (const id of crossing) {
        if (!(CATALOG_VARIABLES as readonly string[]).includes(id as string)) {
          bag.error(path, at, 'unknown-reference', `Unknown catalog variable "${String(id)}" in a crossing.`)
        } else if (!isObject(variables[id as string])) {
          bag.warn(path, at, 'unknown-reference', `Crossing names "${String(id)}", which has no configuration.`)
        }
      }
    })
  }
}

const CATALOG_VARIABLES = ['concept', 'period', 'service', 'age', 'sex'] as const
