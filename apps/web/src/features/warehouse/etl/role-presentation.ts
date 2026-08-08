import type { RoleSchemas } from '@/lib/duckdb/role-prefix'

export type PipelineRole = keyof RoleSchemas

/**
 * Roles in pipeline order: data flows source -> target, with the vocabulary as
 * the reference both consult. Every database picker sorts by this so the same
 * database sits in the same place everywhere.
 */
export const ROLE_ORDER: PipelineRole[] = ['source', 'target', 'vocab']

/**
 * One colour per role, so a picker is readable at a glance. Deliberately not
 * muted-foreground: grey reads as "disabled/unset" next to the coloured ones.
 */
export const ROLE_ICON_COLOR: Record<PipelineRole, string> = {
  source: 'text-sky-500',
  target: 'text-emerald-500',
  vocab: 'text-violet-500',
}

/** Colour for a database with no pipeline role (an off-role per-file override). */
export const NO_ROLE_ICON_COLOR = 'text-amber-500'

export function roleIconColor(role: PipelineRole | undefined): string {
  return role ? ROLE_ICON_COLOR[role] : NO_ROLE_ICON_COLOR
}

/**
 * Sort databases by pipeline role. Anything without a role keeps its relative
 * order after the three roles rather than being dropped.
 */
export function compareByRole(
  a: string,
  b: string,
  roleOf: (id: string | undefined) => PipelineRole | undefined,
): number {
  const rank = (id: string) => {
    const role = roleOf(id)
    return role ? ROLE_ORDER.indexOf(role) : ROLE_ORDER.length
  }
  return rank(a) - rank(b)
}
