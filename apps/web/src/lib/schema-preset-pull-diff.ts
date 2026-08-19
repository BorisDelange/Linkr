/**
 * Build the two sides of a schema-preset pull diff, from data already in memory.
 *
 * A preset row is taken or left whole, so the diff is the plain before/after of
 * what it covers: what we hold on the left, what the remote would write on the
 * right. Worth showing — the schema row carries a DDL, and "this CREATE TABLE
 * gained a column" is exactly what decides whether to accept.
 *
 * Everything here is synchronous and local: `prepareSchemaPresetPull` already
 * carries both sides, so opening a diff costs no network.
 */
import type { PullFile } from '@/lib/pull-plan'
import type { PreparedSchemaPresetPull } from '@/lib/schema-preset-pull'
import { presetInfoOf, stripInstancePresetMapping } from '@/lib/schema-preset-pull'
import { SCHEMA_PRESET_DDL_FILE } from '@/lib/entity-io'
import { README_FILE_RE } from '@/lib/entity-tree'
import { presentReadme } from '@/lib/entity-docs-pull'
import type { PullDiffText } from '@/lib/concept-mapping/pull-diff'

/** Stable JSON so key order never shows up as a difference. Sorts recursively —
 *  a replacer array would filter NESTED keys too, silently emptying a localized
 *  `{en: …}` value down to `{}`. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>).sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value), null, 2)
}

/**
 * The schema row's diff is the DDL, which is what a reader actually compares.
 *
 * The mapping config travels in the same row, but showing both in one pane would
 * mean diffing two languages at once; the DDL is the larger and the one whose
 * changes are hard to spot. The config's own diff is available through the docs
 * row's sibling when it moves alone.
 */
export function buildSchemaPresetPullDiff(
  file: PullFile,
  prepared: PreparedSchemaPresetPull,
): PullDiffText {
  const { localPreset, remoteDdl, remoteMapping, remoteInfo, remoteDocs, plan } = prepared

  if (file.path === SCHEMA_PRESET_DDL_FILE) {
    // When only the config moved, the DDL sides are identical and a DDL diff
    // would render as "no change" on a row that IS changed — show the config.
    if (!plan.ddlChanged && plan.mappingChanged) {
      return {
        oldContent: stable(localPreset?.mapping ? stripInstancePresetMapping(localPreset.mapping) : {}),
        newContent: stable(remoteMapping ?? {}),
        language: 'json',
      }
    }
    return {
      oldContent: localPreset?.mapping?.ddl ?? '',
      newContent: remoteDdl ?? '',
      language: 'sql',
    }
  }

  // The docs row is anchored on the doc file that changed, so the diff shows THAT
  // file's text — markdown as markdown. Rendering the whole descriptive block as
  // one JSON object instead put a README under a `preset.json` heading, escaped
  // newlines and all, as if the manifest carried it.
  const readmeLang = README_FILE_RE.exec(file.path)?.[1] ?? 'en'
  if (README_FILE_RE.test(file.path)) {
    return {
      oldContent: presentReadme(localPreset?.readme)?.[readmeLang] ?? '',
      newContent: presentReadme(remoteDocs.readme)?.[readmeLang] ?? '',
      language: 'markdown',
    }
  }
  if (/^LICENSE\.md$/i.test(file.path)) {
    return {
      oldContent: localPreset?.license?.text ?? '',
      newContent: remoteDocs.license?.text ?? '',
      language: 'markdown',
    }
  }

  // preset.json: the name and description, which is all this row writes there.
  return {
    oldContent: stable(presetInfoOf(localPreset?.mapping)),
    newContent: stable(remoteInfo),
    language: 'json',
  }
}
