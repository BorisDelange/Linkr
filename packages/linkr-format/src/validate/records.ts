/**
 * Entities that are a metadata file plus a flat array of records: DQ rule sets
 * (`checks.json`), mapping projects (`mappings.json`), and the project-scoped
 * cohorts (`cohorts/*.json`).
 *
 * The checks here are the ones whose absence is silent in the app. A DQ check
 * with no SQL never runs; a mapping row with no target concept id maps nothing;
 * a cohort with neither criteria nor SQL selects nobody. All three import
 * without complaint and simply do not work.
 */
import { checkArray, checkEnum, checkLocalized, checkNumber, checkString, isObject } from '../check.js'
import type { IssueBag } from '../issue.js'
import { readJson, type EntityTree } from '../tree.js'
import { CONTENT_FILE, MANIFEST } from '../layout.js'
import { manifestPath } from './entities.js'

const DQ_SEVERITIES = ['error', 'warning', 'info'] as const
const COHORT_LEVELS = ['patient', 'visit', 'visit_detail'] as const
const MAPPING_STATUSES = ['approved', 'pending', 'rejected', 'draft'] as const

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
  checks.value.forEach((check, i) => {
    const pointer = `/${i}`
    if (!isObject(check)) {
      bag.error(checksPath, pointer, 'wrong-type', 'Each check must be an object.')
      return
    }
    checkString(bag, checksPath, `${pointer}/name`, check.name, { required: true, label: 'name' })
    // Without SQL the check runs nothing and silently scores nothing.
    checkString(bag, checksPath, `${pointer}/sql`, check.sql, { required: true, label: 'sql' })

    if (check.severity != null) {
      checkEnum(bag, checksPath, `${pointer}/severity`, check.severity, DQ_SEVERITIES, {
        label: 'severity',
      })
    }
    if (check.threshold != null) {
      checkNumber(bag, checksPath, `${pointer}/threshold`, check.threshold, { label: 'threshold' })
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

/** `cohorts/*.json` inside a project tree. */
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

  if (cohort.level != null) {
    checkEnum(bag, path, '/level', cohort.level, COHORT_LEVELS, { label: 'level' })
  }

  // A cohort selects patients either through the criteria builder or through
  // hand-written SQL. With neither it imports fine and returns nobody.
  const tree = cohort.criteriaTree
  const hasCriteria = isObject(tree) && Array.isArray(tree.rules) && tree.rules.length > 0
  const hasSql = typeof cohort.customSql === 'string' && cohort.customSql.trim().length > 0
  if (!hasCriteria && !hasSql) {
    bag.warn(path, '', 'empty-value',
      'This cohort has neither criteria nor custom SQL; it would select nothing.',
      'add rules to criteriaTree, or set customSql')
  }

  if (tree != null && !isObject(tree)) {
    bag.error(path, '/criteriaTree', 'wrong-type', 'criteriaTree must be an object.')
  } else if (isObject(tree) && tree.rules != null && !Array.isArray(tree.rules)) {
    bag.error(path, '/criteriaTree/rules', 'wrong-type', 'criteriaTree.rules must be an array.')
  }
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

  // Dimensions are what the catalog counts over; an empty list produces a
  // catalog that computes nothing.
  if (catalog.dimensions != null) {
    if (!checkArray(bag, path, '/dimensions', catalog.dimensions, { label: 'dimensions' })) return
    if (catalog.dimensions.length === 0) {
      bag.warn(path, '/dimensions', 'empty-value',
        'No dimensions; this catalog would compute nothing.')
    }
  }
}
