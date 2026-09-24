import { foldAccents } from '@/lib/fold-accents'

/**
 * Generate a DuckDB-safe alias (slug) from a human-readable name.
 * E.g. "MIMIC-IV Demo (raw)" → "mimic_iv_demo_raw"
 */
export function generateAlias(name: string): string {
  return foldAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'db'
}

/**
 * Ensure alias is unique among existing aliases by appending _2, _3, etc.
 */
export function ensureUniqueAlias(alias: string, existingAliases: string[]): string {
  if (!existingAliases.includes(alias)) return alias
  let i = 2
  while (existingAliases.includes(`${alias}_${i}`)) i++
  return `${alias}_${i}`
}
