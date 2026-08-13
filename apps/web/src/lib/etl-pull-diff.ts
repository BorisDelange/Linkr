/**
 * Build the two sides of an ETL pull diff, from data already in memory.
 *
 * Unlike a mapping project — where the diff is a projection of a 3-way merge —
 * an ETL file is taken or left whole, so the diff is the plain before/after of
 * its content: what we hold on the left, what the remote would write on the
 * right. That is still worth showing: these are SQL scripts, and "23 lines
 * changed in the middle of a query" is exactly what decides whether to accept.
 *
 * Everything here is synchronous and local — `prepareEtlPull` already carries
 * both sides (remote nodes + `localByPath`), so opening a diff costs no network.
 */
import type { PullFile } from '@/lib/pull-plan'
import type { PreparedEtlPull } from '@/lib/etl-pull'
import { ETL_SETTINGS_FILE } from '@/lib/etl-pull-plan-builder'
import { monacoLanguageFor } from '@/lib/monaco-language'
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

/** The pipeline settings a pull may write — mirrors `etlSettingsChanged`. */
function settingsBody(p: { name?: unknown; description?: unknown; config?: unknown } | null | undefined) {
  if (!p) return {}
  return { name: p.name ?? null, description: p.description ?? null, config: p.config ?? null }
}

export function buildEtlPullDiff(file: PullFile, prepared: PreparedEtlPull): PullDiffText {
  if (file.path === ETL_SETTINGS_FILE) {
    return {
      oldContent: stable(settingsBody(prepared.localPipeline)),
      newContent: stable(settingsBody(prepared.remotePipeline)),
      language: 'json',
    }
  }

  const remote = prepared.nodes.find((n) => n.type === 'file' && n.path === file.path)
  const local = prepared.localByPath.get(file.path)

  // A file that exists on neither side should never have reached a row; treat it
  // as empty rather than throw, so a plan bug degrades to a blank diff.
  return {
    oldContent: local?.content ?? '',
    newContent: remote?.content ?? '',
    language: monacoLanguageFor(file.path),
  }
}
