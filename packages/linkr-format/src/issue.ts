/**
 * What the validator reports.
 *
 * An Issue is written to be actionable by someone — or something — with no access
 * to this codebase: an agent authoring a project tree outside the app reads the
 * message, fixes the file, and validates again. That is why `hint` carries the
 * valid alternatives rather than only naming what is wrong; the same mechanism
 * already makes the in-app copilot self-correct (a rejected tool call returns the
 * list of valid ids).
 */

export type Severity = 'error' | 'warning'

export interface Issue {
  severity: Severity
  /** File the problem is in, relative to the tree root: `dashboards/overview.json`. */
  path: string
  /** JSON Pointer within that file (RFC 6901): `/widgets/2/source/config/xColumn`. */
  pointer: string
  /** Stable machine-readable code, for tests and for suppressing a class of issue. */
  code: IssueCode
  message: string
  /** Valid alternatives, when they can be enumerated. This is what closes the loop. */
  hint?: string
}

export type IssueCode =
  | 'invalid-json'
  | 'missing-file'
  | 'missing-field'
  | 'wrong-type'
  | 'empty-value'
  | 'unknown-reference'
  | 'duplicate-key'
  | 'orphan-record'
  | 'unknown-column'
  | 'column-id-mismatch'
  | 'csv-header-mismatch'
  | 'layout-out-of-grid'
  | 'legacy-format'

/** Collects issues while walking a tree, so callers never juggle arrays. */
export class IssueBag {
  private readonly issues: Issue[] = []

  add(issue: Issue): void {
    this.issues.push(issue)
  }

  error(path: string, pointer: string, code: IssueCode, message: string, hint?: string): void {
    this.add({ severity: 'error', path, pointer, code, message, ...(hint ? { hint } : {}) })
  }

  warn(path: string, pointer: string, code: IssueCode, message: string, hint?: string): void {
    this.add({ severity: 'warning', path, pointer, code, message, ...(hint ? { hint } : {}) })
  }

  all(): Issue[] {
    return this.issues
  }
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

/**
 * Human-readable report. Used by the CLI, the MCP tool result and test failures
 * alike — a single rendering keeps them consistent.
 *
 * Repeats are folded. A wholly legacy project produces one `legacy-format`
 * warning per column, per tab and per widget — 140 on a real one — and an
 * unfolded list buries the handful of issues that need a decision under a wall
 * of identical lines. Folding keeps the first few, with a count of the rest.
 */
export function formatIssues(issues: Issue[], { fold = 3 }: { fold?: number } = {}): string {
  if (issues.length === 0) return 'No issues found.'

  const groups = new Map<string, Issue[]>()
  for (const issue of issues) {
    // Grouped by code + file + pointer SHAPE, not by message: messages name the
    // offending record ("column col-3", "tab 7"), so they are all distinct —
    // which is precisely why an unfolded list is unreadable. Collapsing array
    // indices puts `/columns/0/id` and `/columns/41/id` in one bucket.
    const shape = issue.pointer.replace(/\/\d+(?=\/|$)/g, '/*')
    const key = `${issue.severity} ${issue.code} ${issue.path} ${shape}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(issue)
    else groups.set(key, [issue])
  }

  const lines: string[] = []
  for (const bucket of groups.values()) {
    for (const issue of bucket.slice(0, fold)) lines.push(renderIssue(issue))
    if (bucket.length > fold) {
      lines.push(`      … ${bucket.length - fold} more of the same, e.g. ${
        bucket.slice(fold, fold + 4).map((i) => `${i.path}${i.pointer}`).join(', ')
      }`)
    }
  }
  return lines.join('\n')
}

function renderIssue(i: Issue): string {
  const where = i.pointer ? `${i.path}${i.pointer}` : i.path
  const hint = i.hint ? `\n    hint: ${i.hint}` : ''
  return `${i.severity === 'error' ? 'ERROR' : 'warn '} ${where}\n    [${i.code}] ${i.message}${hint}`
}

/**
 * Truncated list for a `hint`. A dataset can carry 55 columns (the ICU activity
 * project does); dumping all of them into every issue would bury the message.
 */
export function listHint(label: string, values: readonly string[], max = 12): string {
  if (values.length === 0) return `${label}: none`
  const shown = values.slice(0, max).join(', ')
  const rest = values.length > max ? `, … (+${values.length - max})` : ''
  return `${label}: ${shown}${rest}`
}
