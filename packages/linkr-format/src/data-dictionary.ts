/**
 * A data dictionary repository (INDICATE layout): `concept_sets/*.json`,
 * `units/unit_conversions.json`, `units/recommended_units.json` and an optional
 * `config.json`. A workspace export clones one at `data-dictionaries/<entityId>/`
 * and lists it in `data-dictionaries/_dictionaries.json`.
 */
export const CONCEPT_SETS_DIR = 'concept_sets'
export const UNIT_CONVERSIONS_FILE = 'units/unit_conversions.json'
export const RECOMMENDED_UNITS_FILE = 'units/recommended_units.json'

export const DICTIONARIES_DIR = 'data-dictionaries'
export const DICTIONARIES_INDEX = `${DICTIONARIES_DIR}/_dictionaries.json`

/** Is `path` (from the repository root) part of what a dictionary sync reads?
 *  Everything else in the repo — the app, resolved snapshots, CI — is left out. */
export function isDictionaryFile(path: string): boolean {
  const parts = path.split('/')
  return (parts.length === 2 && parts[0] === CONCEPT_SETS_DIR && parts[1].endsWith('.json'))
    || path === UNIT_CONVERSIONS_FILE || path === RECOMMENDED_UNITS_FILE || path === 'config.json'
}

/** Is `path` (from a workspace tree's root) the dictionary index or a file a
 *  cloned dictionary's sync reads? */
export function isWorkspaceDictionaryFile(path: string): boolean {
  if (path === DICTIONARIES_INDEX) return true
  const prefix = `${DICTIONARIES_DIR}/`
  if (!path.startsWith(prefix)) return false
  const rest = path.slice(prefix.length)
  const slash = rest.indexOf('/')
  return slash > 0 && isDictionaryFile(rest.slice(slash + 1))
}
