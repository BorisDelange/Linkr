/**
 * A data-quality check in an export, and its id once imported.
 *
 * `checks.json` carries no local id: a check id is a global key, re-minted by
 * every import, so writing it made every pull and push churn. Instead each check
 * has a portable key, `checkKey`, set once at creation — its template key when
 * generated from a schema, else the slug of its name, `#<n>` on a collision — and
 * never changed after, so a renamed check keeps it. Quality profiles point at
 * checks by this key. The local id is derived from (rule set id, key): the same
 * check lands on the same id on every re-import, and two copies of a rule set
 * never collide.
 *
 * Twin of `_portable_checks` in apps/api/app/services/dq_check_portable.py: both
 * builders must write the same bytes.
 */
import { dqCheckKeys as checkKeys } from '@linkr/format'
import { deterministicId } from '@/lib/deterministic-id'
import { readStoredCheck } from '@/lib/duckdb/data-quality-checks'
import type { DqCustomCheck } from '@/types'

/** Fields that belong to this instance or to the last edit, never to the check. */
const LOCAL_FIELDS = ['id', 'ruleSetId', 'updatedAt'] as const

const byOrderThenId = (a: DqCustomCheck, b: DqCustomCheck) =>
  (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The checks as `checks.json` writes them: in display order, `checkKey` first,
 *  local fields dropped. A check stored before keys existed gets one derived. */
export function portableChecks(checks: DqCustomCheck[]): Partial<DqCustomCheck>[] {
  const ordered = [...checks].sort(byOrderThenId)
  const keys = checkKeys(ordered)
  return ordered.map((c, i) => {
    const { checkKey: _key, ...rest } = c
    const out = { checkKey: keys[i], ...rest } as Record<string, unknown>
    for (const field of LOCAL_FIELDS) delete out[field]
    return out as Partial<DqCustomCheck>
  })
}

export { checkKeys }

type Keyable = Pick<DqCustomCheck, 'name' | 'templateKey'> & { checkKey?: string | null }

/** New checks keyed against the ones their rule set already holds. */
export function withCheckKeys<T extends Keyable>(checks: T[], existing: Keyable[]): (T & { checkKey: string })[] {
  const keys = checkKeys(checks, existing.map((c) => c.checkKey).filter((k): k is string => !!k))
  return checks.map((c, i) => ({ ...c, checkKey: keys[i] }))
}

/**
 * The checks of an export, ready to store under `ruleSetId` with stable ids.
 *
 * `order` is renumbered 0..n-1 after a stable sort on it (ties keep file order),
 * so two checks that shared a position cannot swap places — and keys — on the
 * next export.
 */
export function importedChecks(checks: Partial<DqCustomCheck>[], ruleSetId: string): DqCustomCheck[] {
  const ordered = [...checks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const keys = checkKeys(ordered as DqCustomCheck[])
  return ordered.map((c, i) => {
    const { id: _id, ruleSetId: _rs, ...rest } = c
    return readStoredCheck({ ...rest, checkKey: keys[i], order: i, id: deterministicId(ruleSetId, keys[i]), ruleSetId } as DqCustomCheck)
  })
}
