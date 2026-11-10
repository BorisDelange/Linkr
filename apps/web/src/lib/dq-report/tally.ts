/**
 * Counting a run's results: overall, per Kahn dimension, per severity, and per
 * group of the tree the checks are filed in. Shared by the Results tab and the
 * profile report, so the two cannot disagree.
 */
import { localized } from '@/lib/localized'
import { DQ_CATEGORIES, DQ_SEVERITIES, type DqCategory, type DqSeverity } from '@/lib/dq-taxonomy'
import type { DqCheck, DqCheckResult, DqCheckStatus } from '@/lib/duckdb/data-quality-checks'

export interface DqTally {
  total: number
  passed: number
  failed: number
  errors: number
  notApplicable: number
}

export interface DqResultRow {
  check: DqCheck
  result: DqCheckResult
}

export const emptyTally = (): DqTally => ({ total: 0, passed: 0, failed: 0, errors: 0, notApplicable: 0 })

const FIELD: Record<DqCheckStatus, keyof Omit<DqTally, 'total'>> = {
  pass: 'passed',
  fail: 'failed',
  error: 'errors',
  not_applicable: 'notApplicable',
}

export function addStatus(tally: DqTally, status: DqCheckStatus): DqTally {
  tally.total++
  tally[FIELD[status]]++
  return tally
}

export function tallyOf(rows: readonly DqResultRow[]): DqTally {
  return rows.reduce((t, r) => addStatus(t, r.result.status), emptyTally())
}

/** Passed checks out of the applicable ones, in %; null when none applies. */
export function scoreOf(tally: DqTally): number | null {
  const applicable = tally.total - tally.notApplicable
  return applicable > 0 ? Math.round((tally.passed / applicable) * 100) : null
}

/** Failed or in error: what needs a look. */
export const isProblem = (status: DqCheckStatus) => status === 'fail' || status === 'error'

/** The rows of a report, in run order, each check with its result. */
export function resultRows(checks: readonly DqCheck[], results: readonly DqCheckResult[]): DqResultRow[] {
  const byId = new Map(checks.map((c) => [c.id, c]))
  return results.flatMap((result) => {
    const check = byId.get(result.checkId)
    return check ? [{ check, result }] : []
  })
}

export function tallyByCategory(rows: readonly DqResultRow[]): { key: DqCategory; tally: DqTally }[] {
  return DQ_CATEGORIES.map((key) => ({ key, tally: tallyOf(rows.filter((r) => r.check.category === key)) }))
}

export function tallyBySeverity(rows: readonly DqResultRow[]): { key: DqSeverity; tally: DqTally }[] {
  return DQ_SEVERITIES.map((key) => ({ key, tally: tallyOf(rows.filter((r) => r.check.severity === key)) }))
}

export type DqResultNodeKind = 'ruleSet' | 'group' | 'other'

/** A group of a run's results: a rule set, a group of checks, or "Other checks". */
export interface DqResultNode {
  /** Unique in the tree. */
  key: string
  kind: DqResultNodeKind
  /** Empty for "Other checks", which the caller names. */
  label: string
  children: DqResultNode[]
  rows: DqResultRow[]
  /** Everything under the node, children included. */
  tally: DqTally
}

function node(key: string, kind: DqResultNodeKind, label: string): DqResultNode {
  return { key, kind, label, children: [], rows: [], tally: emptyTally() }
}

/**
 * The results under the groups their checks were filed in at run time, nested,
 * in run order; the checks filed under none in an "Other checks" node, last.
 * A run that spans several rule sets (a quality profile's) puts each rule set
 * on top.
 */
export function resultTree(rows: readonly DqResultRow[], lang: string): DqResultNode[] {
  const bySource = new Set(rows.map((r) => r.check.ruleSetId ?? '')).size > 1
  const top: DqResultNode[] = []
  const index = new Map<string, DqResultNode>()
  const childOf = (parent: DqResultNode | null, key: string, kind: DqResultNodeKind, label: string) => {
    let n = index.get(key)
    if (!n) {
      n = node(key, kind, label)
      index.set(key, n)
      ;(parent ? parent.children : top).push(n)
    }
    return n
  }

  for (const row of rows) {
    const { check, result } = row
    const scope = bySource ? `rs:${check.ruleSetId ?? ''}` : ''
    const source = bySource ? childOf(null, scope, 'ruleSet', check.ruleSetName ?? '') : null
    const chain: DqResultNode[] = source ? [source] : []
    let parent = source
    let path = scope
    for (const step of check.groupPath) {
      path = `${path}/${step.key}`
      parent = childOf(parent, `g:${path}`, 'group', localized(step.name, lang) || step.key)
      chain.push(parent)
    }
    if (!check.groupPath.length) {
      parent = childOf(source, `other:${scope}`, 'other', '')
      chain.push(parent)
    }
    parent!.rows.push(row)
    for (const n of chain) addStatus(n.tally, result.status)
  }

  // "Other checks" last at each level it appears.
  const otherLast = (list: DqResultNode[]) => {
    list.sort((a, b) => Number(a.kind === 'other') - Number(b.kind === 'other'))
    for (const n of list) otherLast(n.children)
  }
  otherLast(top)
  return top
}

const problems = (t: DqTally) => t.failed + t.errors

/** The tree with failures first at every level (a stable sort: ties keep run order). */
export function failuresFirst(nodes: readonly DqResultNode[]): DqResultNode[] {
  return [...nodes]
    .sort((a, b) => Number(a.kind === 'other') - Number(b.kind === 'other') || problems(b.tally) - problems(a.tally))
    .map((n) => ({
      ...n,
      children: failuresFirst(n.children),
      rows: [...n.rows].sort((a, b) => Number(isProblem(b.result.status)) - Number(isProblem(a.result.status))),
    }))
}

/** The tree keeping only the rows `keep` accepts, and the nodes still holding one. Tallies stay whole. */
export function pruneTree(nodes: readonly DqResultNode[], keep: (row: DqResultRow) => boolean): DqResultNode[] {
  return nodes.flatMap((n) => {
    const children = pruneTree(n.children, keep)
    const rows = n.rows.filter(keep)
    return children.length || rows.length ? [{ ...n, children, rows }] : []
  })
}

/** Every node key of a tree, top first. */
export function nodeKeys(nodes: readonly DqResultNode[]): string[] {
  return nodes.flatMap((n) => [n.key, ...nodeKeys(n.children)])
}

/** A check's group path as one line: `Labs › Kidney`. */
export function groupPathLabel(check: DqCheck, lang: string): string {
  return check.groupPath.map((s) => localized(s.name, lang) || s.key).join(' › ')
}
