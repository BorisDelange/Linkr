/** Cohorts, continued: freezing the membership, and importing an ATLAS definition. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { buildCohortMembershipSql } from '@/lib/duckdb/cohort-query'
import type { CohortLevel } from '@/types'
import { COHORT_LEVELS, normalizeCriteria } from './cohorts.js'
import { convertAtlas, describeFreeze, freezeBlocker, readAtlasInput } from './cohorts-extra.js'
import { WRITE, api, failure, guard, loc, mappingOf, projectDatabases, text, type Server } from './shared.js'
import { cohortDatabase, describeCohort } from './tools-warehouse.js'

export function registerCohortExtraTools(server: Server): void {
  server.registerTool('freeze_cohort', {
    description:
      'Freeze (materialize) a project cohort, as the app\'s Materialize button does: run its full membership on '
      + 'its database and store the list of ids, which the project\'s Patient data then reads — it stops following '
      + 'data changes until frozen again. Re-freezing replaces the previous snapshot. Not for event-level or '
      + 'database-owned cohorts. Returns the frozen count.',
    annotations: { ...WRITE, idempotentHint: true },
    inputSchema: fromJsonSchema<{ cohort_id: string }>({
      type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id }) => {
    const cohort = await api.getCohort(cohort_id)
    const blocker = freezeBlocker(cohort)
    if (blocker) return failure(blocker)
    const dbId = await cohortDatabase(cohort)
    const sql = buildCohortMembershipSql(cohort, await mappingOf(dbId))
    if (!sql) return failure('The criteria produce no runnable membership query (empty group, or a level table missing from the mapping).')
    const saved = await api.materializeCohort(cohort_id, { membershipSql: sql, dataSourceId: dbId })
    if (!saved.materialization) return failure('The server stored no frozen membership.')
    return text(describeFreeze(loc(cohort.name), saved.materialization, cohort.materialization, !!cohort.customSql))
  }))

  server.registerTool('unfreeze_cohort', {
    description:
      'Drop a cohort\'s frozen membership: Patient data goes back to its live definition. The user can undo it '
      + 'from Linkr\'s notifications.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ cohort_id: string }>({
      type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id }) => {
    const cohort = await api.getCohort(cohort_id)
    if (!cohort.materialization) return text(`"${loc(cohort.name)}" is not frozen: nothing to do.`)
    await api.clearCohortMaterialization(cohort_id)
    return text(`Unfroze "${loc(cohort.name)}" (its snapshot of ${cohort.materialization.materializedAt}, `
      + `${cohort.materialization.count}, is gone). Patient data now follows its live definition.`)
  }))

  server.registerTool('import_atlas_cohort', {
    description:
      'Create a project cohort from an OHDSI ATLAS cohort definition (the JSON ATLAS exports), with the same '
      + 'conversion as the app\'s Import ATLAS dialog: concept sets become concept criteria (listed concepts only), '
      + 'inclusion rules become groups, "at most 0" rules become exclusions, age and gender become criteria. '
      + 'Much of ATLAS has no equivalent (time windows, event limits, end strategy, descendants…): the result lists '
      + 'everything dropped, and whether the criteria fit this database\'s mapping. Check it, fix with '
      + 'update_cohort, then run_cohort.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; name: string; atlas_json: unknown; description?: string; level?: CohortLevel; database_id?: string
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        name: { type: 'string' },
        atlas_json: {
          description: 'The ATLAS cohort definition: the object (ConceptSets, PrimaryCriteria, InclusionRules…) or it as a JSON string.',
        },
        description: { type: 'string' },
        level: { type: 'string', enum: COHORT_LEVELS, description: 'Default patient.' },
        database_id: { type: 'string', description: 'Which linked database it runs on. Default: the project\'s first usable one.' },
      },
      required: ['project_uid', 'name', 'atlas_json'],
    }),
  }, guard(async ({ project_uid, name, atlas_json, description, level = 'patient', database_id }) => {
    const input = readAtlasInput(atlas_json)
    if ('error' in input) return failure(input.error)
    const converted = convertAtlas(input.definition)
    const dropped = converted.warnings.length
      ? `\n\nNot carried over from ATLAS (${converted.warnings.length}):\n- ${converted.warnings.join('\n- ')}`
      : '\n\nEverything in the ATLAS definition was carried over.'
    if (converted.criteria === 0) return failure(`Not created: no criterion could be converted.${dropped}`)

    const dbs = await projectDatabases(project_uid)
    const db = database_id
      ? dbs.find((d) => d.id === database_id)
      : dbs.find((d) => d.status === 'connected' && d.schemaMapping?.patientTable)
    if (!db) return failure(database_id ? `Database ${database_id} is not linked to this project.` : 'No usable database in this project.')
    const pointer = db.lineageId || db.entityId
      ? { ...(db.lineageId ? { lineageId: db.lineageId } : {}), ...(db.entityId ? { entityId: db.entityId } : {}), label: db.name }
      : undefined
    const cohort = await api.createCohort({
      id: randomUUID(),
      projectUid: project_uid,
      name: { en: name },
      description: { en: description ?? '' },
      dataSourceId: db.id,
      ...(pointer ? { dataSourceRef: pointer } : {}),
      level,
      criteriaTree: converted.tree,
      schemaVersion: 5,
    })

    const mapping = db.schemaMapping ?? undefined
    const fit = mapping ? normalizeCriteria(converted.tree, mapping) : null
    const issues = fit
      ? [...fit.errors, ...fit.warnings]
      : ['This database has no schema mapping: the criteria cannot run on it.']
    const fitText = issues.length
      ? `\n\nDoes not run as is on "${loc(db.name)}" — fix with update_cohort (ATLAS uses OMOP table names and gender concept ids):\n- ${issues.join('\n- ')}`
      : ''
    return text(`Created from ATLAS (${converted.criteria} criteria).\n\n${describeCohort(cohort, mapping)}${dropped}${fitText}`)
  }))
}
