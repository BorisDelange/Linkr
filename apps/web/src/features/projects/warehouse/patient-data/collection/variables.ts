/**
 * Resolving a collection's variables against the dataset it is bound to.
 *
 * A variable is a REFERENCE to a column, so the two can drift: a column named by
 * the config may have been renamed or dropped in the Datasets page since. This is
 * the one place that reconciles them, shared by the sidebar (which renders the
 * fields) and the setup dialog (which edits them), so they can never disagree
 * about what is collected.
 */
import type { DatasetColumn, PatientCollectionVariable } from '@/types'

/**
 * The variables actually collectable right now, in config order.
 *
 * An absent list means "everything the dataset has", so binding a dataset
 * collects its columns rather than nothing — configuring is then a matter of
 * removing what you don't want. Identity columns are never variables: they carry
 * the patient's identity, not data about them.
 *
 * A variable whose column has since disappeared is dropped rather than rendered
 * as an empty field, and dropping it here means the config is only rewritten when
 * the user next saves — a missing column is not a reason to mutate the board.
 */
export function resolveVariables(
  configured: PatientCollectionVariable[] | undefined,
  columns: readonly DatasetColumn[],
  identityColumns: readonly (string | undefined)[],
): PatientCollectionVariable[] {
  const identity = new Set(identityColumns.filter(Boolean) as string[])
  const byId = new Map(columns.map((c) => [c.id, c]))

  if (!configured) {
    return columns
      .filter((c) => !identity.has(c.id))
      .map((c) => ({ columnId: c.id, origin: 'existing' as const }))
  }

  return configured.filter((v) => byId.has(v.columnId) && !identity.has(v.columnId))
}
