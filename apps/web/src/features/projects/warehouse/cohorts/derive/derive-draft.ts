import type { DatabaseLocation } from '@/components/ui/database-location-field'
import type { DeriveScope } from '@/lib/api/data-sources'
import type { VariableSelection } from '@/lib/cohort-derive'
import type { CohortDerivation, DerivationOptions } from '@/types'
import type { VariablesMode } from './DeriveContentTab'
import type { BirthPrecision, PseudonymSettings } from './pseudonym-settings'

/**
 * What the derive dialog was left at, per cohort: reopening it — after a
 * derivation was launched, or after closing it to check something — starts from
 * there rather than from the defaults. In memory, for the session; a cohort
 * derived before starts from what its last derivation kept (`draftFromDerivations`).
 */
export interface DeriveDraft {
  tab: string
  kind: 'new-database' | 'schema'
  name: string
  location: DatabaseLocation
  targetId: string
  schemaName: string
  register: boolean
  scope: DeriveScope
  variablesMode: VariablesMode
  variables: VariableSelection | undefined
  /** Unticked tables, by plan name. */
  excluded: string[]
  /** Ticked tables, from a recorded derivation: turned into `excluded` once the
   *  plan lists the others. */
  included?: string[]
  pseudonyms: PseudonymSettings
  birthPrecision: BirthPrecision
}

const drafts = new Map<string, DeriveDraft>()

export function deriveDraft(key: string): DeriveDraft | undefined {
  return drafts.get(key)
}

export function saveDeriveDraft(key: string, draft: DeriveDraft): void {
  drafts.set(key, draft)
}

export const DEFAULT_PSEUDONYMS: PseudonymSettings = {
  enabled: true, method: 'hmac', keepKey: true, reuseKeyOf: '',
  correspondenceId: '', correspondenceSchema: 'pseudonyms', correspondenceTable: 'linkr_pseudonyms',
}

/** The content and pseudonymisation settings a recorded derivation kept. */
export function draftFromOptions(options: DerivationOptions): Partial<DeriveDraft> {
  const p = options.pseudonymization
  return {
    scope: options.scope as DeriveScope,
    variablesMode: options.variables ? 'list' : 'all',
    variables: options.variables,
    ...(options.tables ? { included: options.tables.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table)) } : {}),
    birthPrecision: options.birthPrecision ?? 'day',
    pseudonyms: p
      ? {
          ...DEFAULT_PSEUDONYMS,
          method: p.method,
          keepKey: p.keepKey,
          reuseKeyOf: p.reuseKeyOf ?? '',
          correspondenceId: p.correspondence?.dataSourceId ?? '',
          correspondenceSchema: p.correspondence?.schemaName ?? DEFAULT_PSEUDONYMS.correspondenceSchema,
          correspondenceTable: p.correspondence?.tableName ?? DEFAULT_PSEUDONYMS.correspondenceTable,
        }
      : { ...DEFAULT_PSEUDONYMS, enabled: false },
  }
}

/** The settings of the cohort's latest derivation that recorded them. */
export function draftFromDerivations(derivations: readonly CohortDerivation[] | undefined): Partial<DeriveDraft> {
  const latest = [...(derivations ?? [])]
    .filter((d) => d.options)
    .sort((a, b) => b.builtAt.localeCompare(a.builtAt))[0]
  return latest?.options ? draftFromOptions(latest.options) : {}
}
