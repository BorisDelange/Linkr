/**
 * Turn a prepared schema-preset pull into the generic pull plan (lib/pull-plan).
 *
 * Every row is a whole-file row: a preset repo has no tree, just three blocks
 * that are each only meaningful entire — the DDL (half a CREATE TABLE is not a
 * schema), the mapping config, and the docs. So the row IS the decision, exactly
 * as for the ETL settings block.
 *
 * There is no `conflict` state: like the ETL pull, this one has no merge base, so
 * it cannot tell "they changed it" from "we both did". `update` already warns it
 * replaces.
 */
import { buildPullFiles, type PullItem, type PullPlan } from '@/lib/pull-plan'
import { SCHEMA_PRESET_DDL_FILE } from '@/lib/entity-io'
import {
  PRESET_DDL_KEY,
  PRESET_MANIFEST_FILE,
  PRESET_MAPPING_KEY,
  type PreparedSchemaPresetPull,
} from '@/lib/schema-preset-pull'

export function buildSchemaPresetPullPlan(
  prepared: PreparedSchemaPresetPull,
  branch: string,
): PullPlan {
  const rows: { path: string; items: PullItem[]; wholeFile?: boolean }[] = []

  // Row order here is not the display order: buildPullFiles sorts by the
  // category rank from gitFileMeta, so preset.json ('general') shows above
  // schema.ddl ('scripts') — the same order the push list uses.
  if (prepared.plan.ddlChanged) {
    rows.push({
      path: SCHEMA_PRESET_DDL_FILE,
      items: [{
        key: PRESET_DDL_KEY,
        label: SCHEMA_PRESET_DDL_FILE,
        state: prepared.localPreset?.mapping?.ddl ? 'update' : 'add',
      }],
      wholeFile: true,
    })
  }

  if (prepared.plan.mappingChanged) {
    rows.push({
      path: PRESET_MANIFEST_FILE,
      items: [{ key: PRESET_MAPPING_KEY, label: PRESET_MAPPING_KEY, state: 'update' }],
      wholeFile: true,
    })
  }

  for (const item of prepared.plan.docs) {
    rows.push({
      path: item.key,
      items: [{
        key: item.key,
        label: item.key.split('/').pop() ?? item.key,
        state: item.exists ? 'update' : 'add',
      }],
      wholeFile: true,
    })
  }

  return {
    scope: 'schema-presets',
    branch,
    remoteHead: prepared.clonedOid,
    files: buildPullFiles('schema-presets', rows),
  }
}
