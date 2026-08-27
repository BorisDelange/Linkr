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

/**
 * Files whose CONTENT the validator inspects. Everything else in the ZIP still
 * has to appear in the tree — the validator checks that a script listed in
 * `_tree.json` exists — it just does not need the bytes.
 *
 * `.tsv` counts: the dataset validator resolves one as a data file (its
 * last-resort match accepts `.csv|.tsv`), so leaving it undecoded made it read as
 * an empty file. Binary data files are deliberately absent — the validator skips
 * their header cross-check rather than judging them by a first text line.
 */
function needsContent(path: string): boolean {
  return /\.(json|csv|tsv)$/i.test(path)
}

/**
 * `EntityTree` over a parsed ZIP.
 *
 * JSZip reads asynchronously while the validator is synchronous, so content is
 * decoded up front — but only where it is actually read. Every other file is
 * registered with an empty string, so it still *exists* for the presence checks
 * without being pulled into memory.
 *
 * Loading nothing for those files was a real bug: a `.py` script was absent from
 * the tree entirely, so a perfectly good project reported "listed in the tree but
 * the file is absent" on import. Presence and content are separate questions.
 */
export async function treeFromZip(zip: JSZip): Promise<MemoryTree> {
  const files: Record<string, string> = {}
  await Promise.all(
    Object.entries(zip.files)
      .filter(([, entry]) => !entry.dir)
      .map(async ([path, entry]) => {
        if (!needsContent(path)) {
          files[path] = ''
          return
        }
        const text = await entry.async('string')
        // A delimited file is truncated to its header — the only part the
        // validator reads — so a 50 MB dataset is not decoded to check a column
        // list.
        files[path] = /\.(csv|tsv)$/i.test(path)
          ? text.slice(0, text.indexOf('\n') + 1 || undefined)
          : text
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
