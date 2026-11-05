import { DERIVE_SCHEMA_NAME } from '@/lib/cohort-derive'
import type { DerivationOptions } from '@/types'

export type BirthPrecision = NonNullable<DerivationOptions['birthPrecision']>

export interface PseudonymSettings {
  enabled: boolean
  method: 'hmac' | 'random'
  keepKey: boolean
  /** Another derivation's id, or '' for a key of its own. */
  reuseKeyOf: string
  /** A database id, or '' to keep no correspondence table. */
  correspondenceId: string
  correspondenceSchema: string
  correspondenceTable: string
}

/** A derivation whose kept key another can draw with. */
export interface KeyedDerivation {
  derivationId: string
  label: string
}

/** Whether the settings can be sent: names the server accepts. */
export function pseudonymSettingsValid(s: PseudonymSettings): boolean {
  if (!s.enabled || !s.correspondenceId) return true
  return DERIVE_SCHEMA_NAME.test(s.correspondenceSchema) && DERIVE_SCHEMA_NAME.test(s.correspondenceTable)
}
