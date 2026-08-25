/**
 * Validate an incoming project ZIP before it is imported.
 *
 * The import path reads tolerantly on purpose, so a malformed tree does not fail
 * — it lands as a project that is subtly wrong: a widget in no tab, a filter
 * controlling nothing, a dataset that shows up empty. Those are painful to
 * diagnose from the UI because nothing reports them. This surfaces them instead.
 *
 * Warn, never block: the reads stay tolerant, and a legacy-but-working export
 * must keep importing. Only the report changes.
 */
import type JSZip from 'jszip'
import { MemoryTree, formatIssues, validateProject, type Issue } from '@linkr/format'
import type { FormattedError } from '@/lib/api-client'

/** Files the validator reads. Anything else in the ZIP is irrelevant to it. */
function isValidationInput(path: string): boolean {
  if (path.endsWith('/')) return false
  return (
    path === 'project.json'
    || path.endsWith('.json')
    || path.endsWith('.csv')
  )
}

/**
 * `EntityTree` over a parsed ZIP.
 *
 * JSZip reads asynchronously while the validator is synchronous, so the relevant
 * files are decoded up front. Only JSON and CSV are read, and a CSV is truncated
 * to its header — the only part the validator looks at — so a 50 MB dataset does
 * not get decoded into memory to check a column list.
 */
export async function treeFromZip(zip: JSZip): Promise<MemoryTree> {
  const files: Record<string, string> = {}
  await Promise.all(
    Object.entries(zip.files)
      .filter(([path, entry]) => !entry.dir && isValidationInput(path))
      .map(async ([path, entry]) => {
        const text = await entry.async('string')
        files[path] = path.endsWith('.csv') ? text.slice(0, text.indexOf('\n') + 1 || undefined) : text
      }),
  )
  return new MemoryTree(files)
}

export interface ImportValidation {
  issues: Issue[]
  errors: number
  warnings: number
}

export async function validateImportZip(zip: JSZip): Promise<ImportValidation> {
  const issues = validateProject(await treeFromZip(zip))
  const errors = issues.filter((i) => i.severity === 'error').length
  return { issues, errors, warnings: issues.length - errors }
}

/**
 * Render issues for the import dialog: a counted one-liner, with the full report
 * behind the "show details" toggle the dialog already has.
 *
 * The detail is deliberately the same text the CLI prints — one rendering of an
 * issue, wherever it surfaces, so a report pasted from the app and one from CI
 * are comparable.
 */
export function formatValidationIssues(
  issues: Issue[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): FormattedError {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  return {
    summary: errors > 0
      ? t('projects.import_validation_errors', { errors, warnings })
      : t('projects.import_validation_warnings', { warnings }),
    detail: formatIssues(issues),
  }
}
