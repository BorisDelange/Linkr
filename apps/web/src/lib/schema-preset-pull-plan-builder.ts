/**
 * Turn a prepared schema-preset pull into the generic pull plan (lib/pull-plan).
 *
 * Two rows, by SUBJECT rather than by file — see SchemaPresetPullGroup:
 *   - the schema (schema.ddl + the mapping config that names its tables)
 *   - the docs (README, licence, and the preset's name and description)
 *
 * Each row is whole: its parts are one decision, and the sub-items only spell out
 * what that decision covers. A row is anchored on the file the user would look at
 * in the repo — schema.ddl for the schema, preset.json for the docs, which is
 * where the name and description live.
 *
 * There is no `conflict` state: like the ETL pull, this one has no merge base, so
 * it cannot tell "they changed it" from "we both did". `update` already warns it
 * replaces.
 */
import { buildPullFiles, type PullItem, type PullPlan } from '@/lib/pull-plan'
import { SCHEMA_PRESET_DDL_FILE } from '@/lib/entity-io'
import {
  PRESET_MANIFEST_FILE,
  type PreparedSchemaPresetPull,
} from '@/lib/schema-preset-pull'

export function buildSchemaPresetPullPlan(
  prepared: PreparedSchemaPresetPull,
  branch: string,
): PullPlan {
  const { plan, localPreset } = prepared
  const rows: { path: string; items: PullItem[]; wholeFile?: boolean }[] = []

  if (plan.schemaChanged) {
    // Both halves are listed even when only one moved, so the row says what
    // taking it will replace rather than only what differs today.
    const items: PullItem[] = []
    if (plan.ddlChanged) {
      items.push({
        key: 'ddl',
        label: SCHEMA_PRESET_DDL_FILE,
        state: localPreset?.mapping?.ddl ? 'update' : 'add',
      })
    }
    if (plan.mappingChanged) {
      items.push({ key: 'mapping', label: PRESET_MANIFEST_FILE, state: 'update' })
    }
    rows.push({ path: SCHEMA_PRESET_DDL_FILE, items, wholeFile: true })
  }

  if (plan.docs.length > 0 || plan.infoChanged) {
    const items: PullItem[] = plan.docs.map((item) => ({
      key: item.key,
      label: item.key,
      state: item.exists ? 'update' : 'add',
    }))
    if (plan.infoChanged) {
      items.push({ key: 'info', label: PRESET_MANIFEST_FILE, state: 'update' })
    }
    // Anchored on the doc FILE that changed, not on preset.json: the row opens a
    // diff of its path, and a README shown under preset.json reads as if the
    // manifest carried it — it does not, it sits in README.md beside it.
    // preset.json only anchors the row when the name/description moved alone.
    rows.push({
      path: plan.docs[0]?.key ?? PRESET_MANIFEST_FILE,
      items,
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
