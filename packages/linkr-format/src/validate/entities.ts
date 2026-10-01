/**
 * Standalone entities: SQL collection, ETL pipeline, schema preset.
 *
 * Each is its own export tree — a metadata JSON at the root, plus whatever that
 * kind carries. They are what the `linkr-public-content` repos hold (one repo per
 * entity), so validating them is what keeps those repos importable.
 */
import { VERSION_PATTERN } from '../app-version.js'
import { checkLocalized, checkString, isObject } from '../check.js'
import { canonicalSchemaMapping, canonicalSchemaOverrides } from '../schema-mapping.js'
import { IssueBag, type Issue } from '../issue.js'
import {
  CONTENT_FILE, ENTITY_MANIFEST, MANIFEST, ROOT_FILE, SCRIPTS_DIR, SIDECAR, isEntityType,
  type LayoutKind,
} from '../layout.js'
import { readJson, type EntityTree } from '../tree.js'
import { validateFileTree } from './file-tree.js'
import { validateCohortBoardFiles, validateCohortFiles, validateDataCatalog, validateDqRuleSet, validateMappingProject } from './records.js'

/** Entity kinds that have their own tree, beyond `project`. */
export type EntityKind =
  | 'sql-collection'
  | 'etl-pipeline'
  | 'schema-preset'
  | 'dq-rule-set'
  | 'data-catalog'
  | 'mapping-project'
  | 'database'

/**
 * Metadata file that identifies each kind, projected from the shared layout table.
 *
 * Order matters: a mapping project's `project.json` is the same filename a
 * regular project uses, so `mappings.json` is what distinguishes it — MANIFEST
 * lists it first for exactly that reason. `detectEntityKind` is additionally
 * never reached for a plain project — callers test `project.json` +
 * `mappings.json` first.
 */
const METADATA_FILE: Record<EntityKind, string> = {
  'mapping-project': MANIFEST['mapping-project'],
  'sql-collection': MANIFEST['sql-collection'],
  'etl-pipeline': MANIFEST['etl-pipeline'],
  'schema-preset': MANIFEST['schema-preset'],
  'dq-rule-set': MANIFEST['dq-rule-set'],
  'data-catalog': MANIFEST['data-catalog'],
  'database': MANIFEST['database'],
}

/**
 * Identify an entity tree from the metadata file it carries.
 *
 * Lets a caller validate a directory without being told what is in it — which is
 * what CI over a repo of mixed entities needs.
 */
export function detectEntityKind(tree: EntityTree): EntityKind | null {
  const declared = declaredType(tree)
  if (declared != null && declared in METADATA_FILE) return declared as EntityKind
  for (const [kind, file] of Object.entries(METADATA_FILE) as [EntityKind, string][]) {
    if (tree.read(file) != null) return kind
  }
  return null
}

/**
 * The `type` an `entity.json` declares, if the tree has one.
 *
 * Once a tree says what it is, nothing has to be inferred from filenames — which
 * is what makes a single shared manifest name possible. Returns null for a tree
 * with no `entity.json`, an unparseable one, or a `type` outside the vocabulary,
 * so every caller falls back to the filename heuristic unchanged.
 */
function declaredType(tree: EntityTree): LayoutKind | null {
  const raw = tree.read(ENTITY_MANIFEST)
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as { type?: unknown }
    return isEntityType(parsed?.type) ? parsed.type : null
  } catch {
    return null
  }
}

/**
 * The kind of any entity tree, including a plain project.
 *
 * A mapping project and a regular project both carry `project.json`; what tells
 * them apart is `mappings.json`. Getting this backwards would validate a mapping
 * project against the project schema and report a pile of nonsense, so the
 * discrimination lives here rather than in each caller.
 */
export function detectTreeKind(tree: EntityTree): EntityKind | 'project' | null {
  const declared = declaredType(tree)
  if (declared === 'project') return 'project'
  if (declared != null && declared in METADATA_FILE) return declared as EntityKind
  if (tree.read(MANIFEST['mapping-project']) != null) return 'mapping-project'
  if (tree.read(MANIFEST.project) != null) return 'project'
  return detectEntityKind(tree)
}

/**
 * The manifest path a tree actually uses for `kind`.
 *
 * A tree may carry the new shared `entity.json` or the kind's historical name.
 * Resolving once here keeps every validator, and every error message, pointing
 * at the file the user really has. Falls back to the historical name so a
 * missing-manifest error names something concrete.
 */
export function manifestPath(tree: EntityTree, kind: LayoutKind): string {
  return tree.read(ENTITY_MANIFEST) != null ? ENTITY_MANIFEST : MANIFEST[kind]
}

/**
 * Report a tree still written in the pre-harmonization layout.
 *
 * Warnings, not errors: these trees import fine — every reader accepts the old
 * names — so failing them would block the published repos that have not been
 * re-exported yet. But staying silent is worse than tolerant: an author who
 * validates an old tree and is told "no issues found" has no reason to migrate,
 * and the whole point of one manifest name is lost one repo at a time.
 *
 * Only the manifest-level facts are checked here, the ones true for every kind.
 * Per-kind payload moves (a preset's inline `mapping`) belong to that kind's
 * validator, which knows what its payload is.
 */
function checkLegacyLayout(tree: EntityTree, kind: LayoutKind, bag: IssueBag): void {
  // `MANIFEST['mapping-project']` is `mappings.json` — that kind's PAYLOAD, which
  // is what tells it apart from a plain project. Its manifest is the project one,
  // so naming MANIFEST[kind] here told the author to rename their mappings file.
  const legacyName = kind === 'mapping-project' ? MANIFEST.project : MANIFEST[kind]
  const usesLegacyName = tree.read(ENTITY_MANIFEST) == null && tree.read(legacyName) != null
  if (usesLegacyName) {
    bag.warn(legacyName, '', 'legacy-format',
      `Legacy manifest name: every entity now writes "${ENTITY_MANIFEST}". `
      + `Rename ${legacyName} → ${ENTITY_MANIFEST} and add "type": "${kind}".`)
    return
  }
  // Present under the shared name but not declaring what it is: the kind then
  // has to be sniffed from which files are around, which is what `type` exists
  // to stop.
  const parsed = readJson(tree, ENTITY_MANIFEST)
  if (parsed.ok && isObject(parsed.value) && parsed.value.type == null) {
    bag.warn(ENTITY_MANIFEST, '/type', 'legacy-format',
      `Missing "type": "${kind}". The manifest declares what it is rather than `
      + 'leaving the kind to be inferred from the surrounding files.')
  }
  if (parsed.ok) checkEmptyBadges(bag, ENTITY_MANIFEST, parsed.value)
}

/**
 * `badges: []` in a manifest.
 *
 * The app writes no `badges` key at all when there are none (its
 * `stripInstanceFields`): a row carries `[]` or nothing depending only on
 * whether it was last created or updated, and both mean the same. An authored
 * `[]` is therefore deleted on the first export after an install — a diff nobody
 * wrote, on a line nobody typed.
 */
export function checkEmptyBadges(bag: IssueBag, path: string, manifest: unknown): void {
  if (!isObject(manifest)) return
  if (Array.isArray(manifest.badges) && manifest.badges.length === 0) {
    bag.warn(path, '/badges', 'non-canonical',
      'Empty "badges": the app omits the key entirely when there are none, so '
      + 'this line is removed on the first export.',
      'delete the "badges" key')
  }
}

/**
 * `minAppVersion`, when present, must be an `X.Y.Z` the importer can compare: a
 * malformed one would never refuse anything, which is the silent failure the
 * field exists to prevent.
 */
export function checkMinAppVersion(tree: EntityTree, kind: LayoutKind, bag: IssueBag): void {
  const path = manifestPath(tree, kind)
  const parsed = readJson(tree, path)
  if (!parsed.ok || !isObject(parsed.value) || !('minAppVersion' in parsed.value)) return
  const min = parsed.value.minAppVersion
  if (typeof min !== 'string' || !VERSION_PATTERN.test(min.trim())) {
    bag.error(path, '/minAppVersion', 'wrong-type',
      '"minAppVersion" must be a version such as "2.4.3".',
      'let the app stamp it on export rather than writing it by hand')
  }
}

export function validateEntity(tree: EntityTree, kind: EntityKind): Issue[] {
  const bag = new IssueBag()
  checkLegacyLayout(tree, kind, bag)
  checkMinAppVersion(tree, kind, bag)
  switch (kind) {
    case 'sql-collection':
      validateScriptCollection(tree, bag, manifestPath(tree, kind), 'SQL collection')
      break
    case 'etl-pipeline':
      validateScriptCollection(tree, bag, manifestPath(tree, kind), 'ETL pipeline')
      break
    case 'schema-preset':
      validateSchemaPreset(tree, bag)
      break
    case 'dq-rule-set':
      validateDqRuleSet(tree, bag)
      break
    case 'data-catalog':
      validateDataCatalog(tree, bag)
      break
    case 'mapping-project':
      validateMappingProject(tree, bag)
      break
    case 'database':
      validateDatabase(tree, bag)
      break
  }
  return bag.all()
}

/**
 * A database tree: metadata, its mapping (`mapping.json` + `schema.ddl`, the
 * same split a schema preset uses), `data/<table>.parquet`, its own cohorts
 * under `cohorts/` and their boards under `cohort-boards/` (validated as a
 * project's are).
 *
 * Two things this checks that nothing else can. First, every declared table has
 * its file and every file is declared — a mismatch imports as a database whose
 * tables silently do not exist. Second, **no connection config**: a database
 * repo is public, and a host, a user or a token in it is a credential leak that
 * no later validation would catch.
 */
function validateDatabase(tree: EntityTree, bag: IssueBag): void {
  const path = manifestPath(tree, 'database')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? '_database.json is required at the root of a database.'
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  const db = parsed.value
  if (!isObject(db)) {
    bag.error(path, '', 'wrong-type', '_database.json must be an object.')
    return
  }

  checkString(bag, path, '/id', db.id, { required: true, label: 'id' })
  checkString(bag, path, '/alias', db.alias, { required: true, label: 'alias' })
  checkLocalized(bag, path, '/name', db.name, { required: true, label: 'name' })
  checkInstanceFields(bag, path, db)

  // A public repo carrying a host, a username or a token is a credential leak.
  // The app's own export strips this down to `engine` for exactly this reason.
  if (db.connectionConfig != null) {
    bag.error(path, '/connectionConfig', 'wrong-type',
      'A database repo must not carry a connection config — it would publish host and credentials.',
      'remove `connectionConfig`; the importing instance supplies its own')
  }

  // The mapping is its own file since the split — `entity.json` carries identity
  // and provenance, the payload lives beside it, exactly as a schema preset does.
  // A tree published before that has it inline under `schema`, and still validates.
  const mappingFile = readJson(tree, CONTENT_FILE.schemaMapping)
  if (mappingFile.ok) {
    if (!isObject(mappingFile.value)) {
      bag.error(CONTENT_FILE.schemaMapping, '', 'wrong-type',
        `${CONTENT_FILE.schemaMapping} must be a mapping object.`)
    }
    if (db.schema != null) {
      bag.warn(path, '/schema', 'legacy-format',
        `The mapping is in ${CONTENT_FILE.schemaMapping}; \`schema\` in the manifest is the older `
        + 'form and is ignored when both are present.',
        'drop `schema` from the manifest')
    }
  } else if (db.schema == null) {
    bag.error(CONTENT_FILE.schemaMapping, '', 'missing-file',
      `A database needs its mapping — as ${CONTENT_FILE.schemaMapping} beside the manifest.`,
      'copy the mapping from the schema preset repo, recording its identity in `schemaSource`')
  } else if (typeof db.schema === 'string') {
    // A name only resolves against presets installed on the importing instance,
    // and the built-in preset table that used to answer these lookups is being
    // retired — schemas are installed from the catalog now. A repo naming its
    // schema is therefore not self-contained.
    bag.error(path, '/schema', 'wrong-type',
      `\`schema\` is the name "${db.schema}", not a mapping. A name only resolves if that `
      + 'preset happens to be installed.',
      `copy the full mapping from the schema preset repo into ${CONTENT_FILE.schemaMapping}, `
      + 'and record its identity in `schemaSource`')
  } else if (!isObject(db.schema)) {
    bag.error(path, '/schema', 'wrong-type', '`schema` must be a mapping object.')
  } else {
    bag.warn(path, '/schema', 'legacy-format',
      `The mapping belongs in ${CONTENT_FILE.schemaMapping} beside the manifest, not inline.`,
      `move \`schema\` to ${CONTENT_FILE.schemaMapping}`)
  }

  // Whichever form carries it, the mapping gets the same two checks a preset's
  // does: the DDL is a file, and the order is what the next export would write.
  const mapping = mappingFile.ok ? mappingFile.value : db.schema
  if (isObject(mapping)) {
    const mappingPath = mappingFile.ok ? CONTENT_FILE.schemaMapping : path
    const at = (pointer: string) => (mappingFile.ok ? pointer : `/schema${pointer}`)
    if (mapping.ddl != null) {
      bag.warn(mappingPath, at('/ddl'), 'legacy-format',
        `The DDL is inline in the mapping; exports write it to ${CONTENT_FILE.schemaDdl}.`,
        `move the value to a ${CONTENT_FILE.schemaDdl} file and drop this field`)
    }
    if (mapping.formatVersion === 2) checkMappingV2(bag, mappingPath, mapping, (p) => at(p.replace(/^\/mapping/, '')))
    if (JSON.stringify(mapping) !== JSON.stringify(canonicalSchemaMapping(mapping))) {
      bag.warn(mappingPath, at(''), 'legacy-format',
        'The mapping is not in canonical order; the next export will rewrite it.',
        'reorder it as `canonicalSchemaMapping` does, or re-export from Linkr')
    }
  }

  // The database's overrides on top of its preset: an object, in canonical order,
  // whose relations follow the same rules as a v2 mapping's.
  const overridesFile = readJson(tree, CONTENT_FILE.schemaOverrides)
  if (overridesFile.ok) {
    const o = overridesFile.value
    if (!isObject(o)) {
      bag.error(CONTENT_FILE.schemaOverrides, '', 'wrong-type', `${CONTENT_FILE.schemaOverrides} must be an object.`)
    } else {
      if (o.relations != null && !isObject(o.relations)) {
        bag.error(CONTENT_FILE.schemaOverrides, '/relations', 'wrong-type', '`relations` maps relation keys to relations.')
      } else if (isObject(o.relations)) {
        for (const [key, rel] of Object.entries(o.relations)) {
          if (!OVERRIDE_KEY.test(key)) {
            bag.error(CONTENT_FILE.schemaOverrides, `/relations/${key}`, 'wrong-type',
              'An override key is `patient`, `visit`, `visitDetail`, `note`, or `concepts.<key>` / `events.<label>` / `drugs.<label>`.')
          }
          checkRelation(bag, CONTENT_FILE.schemaOverrides, rel, `/relations/${key}`, (p) => p)
        }
      }
      if (o.removed != null && !Array.isArray(o.removed)) {
        bag.error(CONTENT_FILE.schemaOverrides, '/removed', 'wrong-type', '`removed` lists the base relation keys this database drops.')
      } else if (Array.isArray(o.removed)) {
        for (const [i, key] of o.removed.entries()) {
          if (typeof key !== 'string' || !OVERRIDE_KEY.test(key)) {
            bag.error(CONTENT_FILE.schemaOverrides, `/removed/${i}`, 'wrong-type',
              'A removed key is `patient`, `visit`, `visitDetail`, `note`, or `concepts.<key>` / `events.<label>` / `drugs.<label>`.')
          }
        }
      }
      if (JSON.stringify(o) !== JSON.stringify(canonicalSchemaOverrides(o))) {
        bag.warn(CONTENT_FILE.schemaOverrides, '', 'legacy-format',
          'The overrides are not in canonical order; the next export will rewrite them.',
          'reorder them as `canonicalSchemaOverrides` does, or re-export from Linkr')
      }
    }
  }

  // Provenance is what lets the app name the schema when the preset is not
  // installed locally, and recognize two copies of the same one across
  // instances. Absent, the database still works — hence a warning.
  const source = db.schemaSource
  if (source == null) {
    bag.warn(path, '/schemaSource', 'missing-field',
      'No `schemaSource`: nothing records which published schema this mapping came from.',
      'add { lineageId, label } from the schema preset repo')
  } else if (!isObject(source)) {
    bag.error(path, '/schemaSource', 'wrong-type', '`schemaSource` must be an object.')
  } else {
    // A preset's own `presetId` is a local primary key, regenerated on import —
    // it identifies nothing on another instance. `lineageId` is the identity.
    checkString(bag, path, '/schemaSource/lineageId', source.lineageId, {
      required: true,
      label: 'lineageId',
    })
    if (source.label == null) {
      bag.warn(path, '/schemaSource/label', 'missing-field',
        'No `label`: the schema has no name wherever it is not installed.',
        'copy `presetLabel` from the schema preset')
    }
  }

  // A derived database names its parent by portable pointer and snapshots the
  // cohort it was built from — a new work, not a fork (so no parentLineageId).
  const derived = db.derivedFrom
  if (derived != null) {
    if (!isObject(derived)) {
      bag.error(path, '/derivedFrom', 'wrong-type', '`derivedFrom` must be an object.')
    } else {
      if (!isObject(derived.database)) {
        bag.error(path, '/derivedFrom/database', 'wrong-type',
          '`derivedFrom.database` must be a database pointer ({ lineageId, entityId, label }).')
      }
      if (!isObject(derived.cohort)) {
        bag.error(path, '/derivedFrom/cohort', 'wrong-type',
          '`derivedFrom.cohort` must be an object ({ key, name }).')
      }
      if (!isObject(derived.criteriaTree)) {
        bag.warn(path, '/derivedFrom/criteriaTree', 'missing-field',
          'No `criteriaTree`: the derived database no longer says which criteria built it.')
      }
    }
  }

  // The database's own cohorts and their boards: same files, same checks as a project's.
  validateCohortFiles(tree, bag)
  validateCohortBoardFiles(tree, bag)

  const declared = db.tables
  const inMemory = db.inMemory === true
  if (declared != null && !Array.isArray(declared)) {
    bag.error(path, '/tables', 'wrong-type', '`tables` must be an array of table names.')
    return
  }

  const names = Array.isArray(declared) ? declared.filter((t): t is string => typeof t === 'string') : []
  const present = new Set(
    tree.paths()
      .filter((p) => p.startsWith('data/') && p.endsWith('.parquet'))
      .map((p) => p.slice('data/'.length, -'.parquet'.length)),
  )

  if (!inMemory && names.length === 0) {
    bag.error(path, '/tables', 'missing-field',
      'A database declares no tables. Set `inMemory: true` if it is meant to start empty.')
  }

  for (const [i, name] of names.entries()) {
    if (!present.has(name)) {
      // Data files are gitignored in many trees, so this is a warning: the repo
      // may legitimately ship metadata while the Parquet arrives via LFS or CI.
      bag.warn(path, `/tables/${i}`, 'missing-file',
        `Table "${name}" is declared but data/${name}.parquet is absent.`,
        'add the Parquet file, or drop the table from `tables`')
    }
  }
  for (const name of present) {
    if (!names.includes(name)) {
      bag.warn('data', '', 'legacy-format',
        `data/${name}.parquet is present but "${name}" is not in \`tables\` — it will not be loaded.`,
        'add it to `tables`')
    }
  }

  // Parquet in normal git history bloats every clone forever; the app's export
  // and the server's clone both assume the LFS filter is declared.
  if (present.size > 0 && tree.read(ROOT_FILE.gitattributes) == null) {
    bag.warn(ROOT_FILE.gitattributes, '', 'legacy-format',
      'Parquet files are present but .gitattributes does not track them with LFS.',
      'add: *.parquet filter=lfs diff=lfs merge=lfs -text')
  }
}

/**
 * SQL collections and ETL pipelines are the same shape: metadata + a path-keyed
 * tree of script files at the root.
 */
function validateScriptCollection(
  tree: EntityTree,
  bag: IssueBag,
  metadataPath: string,
  label: string,
): void {
  const parsed = readJson(tree, metadataPath)
  if (!parsed.ok) {
    bag.error(metadataPath, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? `${metadataPath} is required at the root of a ${label}.`
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  if (!isObject(parsed.value)) {
    bag.error(metadataPath, '', 'wrong-type', `${metadataPath} must be an object.`)
    return
  }

  checkLocalized(bag, metadataPath, '/name', parsed.value.name, { required: true })
  if (parsed.value.description != null) {
    checkLocalized(bag, metadataPath, '/description', parsed.value.description, { label: 'description' })
  }
  checkInstanceFields(bag, metadataPath, parsed.value)

  // The file tree lives under scripts/; a repo published before that keeps it at
  // the root with its files scattered beside it. Validate whichever this tree has.
  const inScripts = tree.read(`${SCRIPTS_DIR}/${SIDECAR.tree}`) != null
  validateFileTree(tree, bag, {
    treePath: inScripts ? `${SCRIPTS_DIR}/${SIDECAR.tree}` : SIDECAR.tree,
    filePrefix: inScripts ? `${SCRIPTS_DIR}/` : '',
  })
}

/**
 * A schema preset is `preset.json` (a mapping) plus an optional `schema.ddl`.
 *
 * The DDL is deliberately a separate file rather than a JSON string: it is what
 * the export splits out of `mapping.ddl`, and keeping it as a file is what makes
 * it readable and diffable in git.
 */
function validateSchemaPreset(tree: EntityTree, bag: IssueBag): void {
  const path = manifestPath(tree, 'schema-preset')
  const parsed = readJson(tree, path)
  if (!parsed.ok) {
    bag.error(path, '', parsed.error === 'missing' ? 'missing-file' : 'invalid-json',
      parsed.error === 'missing'
        ? 'preset.json is required at the root of a schema preset.'
        : `Cannot parse JSON: ${parsed.error}`)
    return
  }
  const preset = parsed.value
  if (!isObject(preset)) {
    bag.error(path, '', 'wrong-type', 'preset.json must be an object.')
    return
  }

  // Either identity satisfies the requirement: `entityId` is what the export
  // writes now (harmonised with every other entity), `presetId` is what trees
  // published before the split carry. Requiring both would flag one or the other.
  if (preset.entityId == null && preset.presetId == null) {
    bag.error(path, '/entityId', 'missing-field',
      'A schema preset needs an `entityId` (its readable identifier).')
  } else if (preset.entityId != null) {
    checkString(bag, path, '/entityId', preset.entityId, { required: true, label: 'entityId' })
  } else {
    checkString(bag, path, '/presetId', preset.presetId, { required: true, label: 'presetId' })
  }
  // No check on `lineageId` here. It matters enormously for a *published* repo —
  // the install mints a fresh uuid when the tree carries none, so two installs of
  // a lineage-less repo are never recognised as the same entity — but a tree
  // being authored has no reason to carry one yet, and the validator cannot tell
  // the two apart. Flagging it would fire on every freshly serialized tree.
  checkInstanceFields(bag, path, preset)

  // The mapping is its own file since the split — `entity.json` carries identity
  // and provenance, the payload lives beside it. A tree published before that has
  // it inline, and still validates.
  const inFile = readJson(tree, CONTENT_FILE.schemaMapping)
  const mappingPath = inFile.ok ? CONTENT_FILE.schemaMapping : path
  const at = (pointer: string) => (inFile.ok ? pointer.replace(/^\/mapping/, '') || '' : pointer)
  const mapping = inFile.ok ? inFile.value : preset.mapping
  if (!isObject(mapping)) {
    bag.error(path, '/mapping', 'missing-field',
      `A schema preset needs a mapping — as ${CONTENT_FILE.schemaMapping} beside the manifest.`)
    return
  }
  if (!inFile.ok) {
    // Measured at 88% of the published omop-cdm-5.4 manifest: inline, the payload
    // buries the identity a human (and the catalog scanner) opens the file for.
    bag.warn(path, '/mapping', 'legacy-format',
      `The mapping belongs in ${CONTENT_FILE.schemaMapping} beside the manifest, not inline.`,
      `move \`mapping\` to ${CONTENT_FILE.schemaMapping}, keeping the name at the root`)
  }
  // `presetId` is the retired identity — read on import so old trees keep working,
  // never written. Reported apart from the entityId check above, which accepts it
  // as a fallback: carrying it *alongside* entityId is the redundancy to drop.
  if (preset.presetId != null && preset.entityId != null) {
    bag.warn(path, '/presetId', 'legacy-format',
      '`presetId` is `entityId` under its former name; the export no longer writes it.')
  }
  // The exporters canonicalise the mapping before writing it. A tree that is not
  // in that order still imports, but the first re-export rewrites the file — a
  // diff that changes no data. Comparing the serialization is what catches both
  // the key order and the event-table field order in one check.
  if (JSON.stringify(mapping) !== JSON.stringify(canonicalSchemaMapping(mapping))) {
    bag.warn(mappingPath, at('/mapping'), 'legacy-format',
      'The mapping is not in canonical order; the next export will rewrite it.',
      'reorder it as `canonicalSchemaMapping` does, or re-export from Linkr')
  }
  // The export moves the DDL out of the mapping and into schema.ddl; a preset
  // still carrying it inline came from an older writer and round-trips badly.
  if (mapping.ddl != null) {
    bag.warn(mappingPath, at('/mapping/ddl'), 'legacy-format',
      'The DDL is inline in the mapping; exports write it to schema.ddl.',
      'move the value to a schema.ddl file and drop this field')
  }

  const tables = mapping.tables
  if (tables != null && !isObject(tables)) {
    bag.error(mappingPath, at('/mapping/tables'), 'wrong-type', '`tables` must be an object.')
  } else if (isObject(tables)) {
    for (const [name, table] of Object.entries(tables)) {
      if (!isObject(table)) {
        bag.error(mappingPath, at(`/mapping/tables/${name}`), 'wrong-type', 'Each table must be an object.')
        continue
      }
      if (table.columns != null && !isObject(table.columns)) {
        bag.error(mappingPath, at(`/mapping/tables/${name}/columns`), 'wrong-type',
          '`columns` must be an object mapping OMOP column → source column.')
      }
    }
  }

  if (mapping.formatVersion === 2) {
    checkMappingV2(bag, mappingPath, mapping, at)
    return
  }
  // A v1 mapping (one block per table): read, converted by the app on import, and
  // re-written as v2 by the next export.
  bag.warn(mappingPath, at('/mapping'), 'legacy-format',
    'The mapping is in format v1 (one block per table); Linkr converts it on import and exports format v2.',
    're-export the preset from Linkr')
  const eventTables = mapping.eventTables
  if (eventTables != null && !isObject(eventTables)) {
    bag.error(mappingPath, at('/mapping/eventTables'), 'wrong-type', '`eventTables` must be an object.')
  } else if (isObject(eventTables)) {
    for (const [name, event] of Object.entries(eventTables)) {
      if (!isObject(event)) {
        bag.error(mappingPath, at(`/mapping/eventTables/${name}`), 'wrong-type',
          'Each event table must be an object.')
        continue
      }
      // Without these an event table cannot be queried at all: the app needs to
      // know which table, which concept column and which date column to read.
      for (const field of ['table', 'conceptIdColumn', 'dateColumn']) {
        checkString(bag, path, `/mapping/eventTables/${name}/${field}`, event[field], {
          required: true,
          label: field,
        })
      }
    }
  }
}

/**
 * Local primary keys and instance-specific fields.
 *
 * The export strips them precisely so a re-import stays stable; a tree carrying
 * them was hand-written or came from an older writer, and they churn the git diff
 * for no gain.
 */
function checkInstanceFields(bag: IssueBag, path: string, record: Record<string, unknown>): void {
  // `id` is NOT in this list: for a standalone entity it is the portable identity
  // the export deliberately keeps (the golden fixtures carry it), unlike a
  // project's `uid`, which is a local primary key regenerated on import.
  for (const field of ['uid', 'ownerId', 'workspaceId', 'projectUid', 'updatedAt']) {
    if (record[field] != null) {
      bag.warn(path, `/${field}`, 'legacy-format',
        `\`${field}\` is specific to the exporting instance; exports omit it.`,
        `remove the \`${field}\` field`)
    }
  }
}

const RELATION_KEYS = ['patient', 'visit', 'visitDetail', 'note'] as const
const RELATION_LISTS = ['concepts', 'events', 'drugs'] as const
const COLUMN_REF = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/
const OVERRIDE_KEY = /^(?:patient|visit|visitDetail|note|(?:concepts|events|drugs)\..+)$/

/** One v2 relation, wherever it sits: a mapping's, or a database override's. */
function checkRelation(
  bag: IssueBag,
  path: string,
  rel: unknown,
  pointer: string,
  at: (pointer: string) => string,
): void {
  if (!isObject(rel)) {
    bag.error(path, at(pointer), 'wrong-type', 'A relation must be an object.')
    return
  }
  const hasSql = typeof rel.customSql === 'string' && rel.customSql.trim() !== ''
  if (rel.customSql != null) checkString(bag, path, at(`${pointer}/customSql`), rel.customSql, { label: 'customSql' })
  if (rel.from != null || !hasSql) {
    if (!isObject(rel.from)) {
      if (!('genderValues' in rel)) {
        bag.error(path, at(`${pointer}/from`), 'missing-field', 'A relation needs `from` (a table and its alias) or `customSql`.')
      }
    } else {
      checkString(bag, path, at(`${pointer}/from/table`), rel.from.table, { required: true, label: 'table' })
      checkString(bag, path, at(`${pointer}/from/alias`), rel.from.alias, { required: true, label: 'alias' })
    }
  }
  if (rel.joins != null) {
    if (!Array.isArray(rel.joins)) {
      bag.error(path, at(`${pointer}/joins`), 'wrong-type', '`joins` must be an array.')
    } else {
      rel.joins.forEach((j, i) => {
        const jp = `${pointer}/joins/${i}`
        if (!isObject(j)) return bag.error(path, at(jp), 'wrong-type', 'A join must be an object.')
        if (j.type !== 'left' && j.type !== 'inner') bag.error(path, at(`${jp}/type`), 'wrong-type', 'A join type is `left` or `inner`.')
        checkString(bag, path, at(`${jp}/table`), j.table, { required: true, label: 'table' })
        checkString(bag, path, at(`${jp}/alias`), j.alias, { required: true, label: 'alias' })
        const pairsOk = Array.isArray(j.on) && j.on.every((pair) =>
          Array.isArray(pair) && pair.length === 2 && pair.every((side) => typeof side === 'string' && COLUMN_REF.test(side)))
        if (!pairsOk) bag.error(path, at(`${jp}/on`), 'wrong-type', '`on` must be a list of [`alias.column`, `alias.column`] pairs.')
      })
    }
  }
  if (rel.fields != null) {
    if (!isObject(rel.fields)) {
      bag.error(path, at(`${pointer}/fields`), 'wrong-type', '`fields` must be an object.')
    } else {
      for (const [name, f] of Object.entries(rel.fields)) {
        const ok = typeof f === 'string'
          ? COLUMN_REF.test(f)
          : isObject(f) && (typeof f.expr === 'string' || 'value' in f)
        if (!ok) {
          bag.error(path, at(`${pointer}/fields/${name}`), 'wrong-type',
            'A field is `alias.column`, `{ "expr": "…" }` or `{ "value": … }`.')
        }
      }
    }
  }
}

/**
 * A v2 mapping: each relation is read either from a table (`from`, with `alias`)
 * or from SQL (`customSql`), and each field is a column reference, an expression
 * or a constant. Names are what the app's generator validates again; this says
 * where a hand-written tree went wrong before an import silently drops a field.
 */
function checkMappingV2(
  bag: IssueBag,
  path: string,
  mapping: Record<string, unknown>,
  at: (pointer: string) => string,
): void {
  for (const key of RELATION_KEYS) {
    if (mapping[key] != null) checkRelation(bag, path, mapping[key], `/mapping/${key}`, at)
  }
  const eventLabels = new Set<string>()
  for (const key of RELATION_LISTS) {
    const list = mapping[key]
    if (list == null) continue
    if (!Array.isArray(list)) {
      bag.error(path, at(`/mapping/${key}`), 'wrong-type', `\`${key}\` must be an array.`)
      continue
    }
    // Event and drug labels share one namespace: consumers find either by label.
    const seen = key === 'concepts' ? new Set<string>() : eventLabels
    list.forEach((rel, i) => {
      const pointer = `/mapping/${key}/${i}`
      checkRelation(bag, path, rel, pointer, at)
      if (!isObject(rel)) return
      const idField = key === 'concepts' ? 'key' : 'label'
      if (checkString(bag, path, at(`${pointer}/${idField}`), rel[idField], { required: true, label: idField })) {
        const id = rel[idField] as string
        if (seen.has(id)) {
          bag.error(path, at(`${pointer}/${idField}`), 'duplicate-key',
            key === 'concepts' ? `Two concepts share the key "${id}".` : `Two event or drug relations share the label "${id}".`)
        }
        seen.add(id)
      }
      if (key === 'drugs' && rel.drugKind !== 'administration' && rel.drugKind !== 'prescription') {
        bag.error(path, at(`${pointer}/drugKind`), 'wrong-type', '`drugKind` is `administration` or `prescription`.')
      }
    })
  }
}
