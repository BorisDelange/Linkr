/**
 * A database's concept profiles: computed once, exact, and read by every view
 * that describes a concept — the database's Concepts tab, the concept panel, a
 * mapping project's extraction (docs/planning/concept-profiles-plan.md).
 *
 * What is stored is the profile with no threshold at all: every patient count,
 * every category up to STORED_TOP_N, free text included. It never leaves the
 * app's own data. A reader asks for the sections it wants under its own options
 * and gets them filtered (`filterProfile`) — a mapping project its k-anonymity
 * threshold and its categories' minimum, the Concepts tab everything. Whoever
 * asks for a section the store lacks computes it and adds it (`mergeProfile`),
 * so it is there for the next reader.
 *
 * Pure: the backends (server, IndexedDB) are in `profile-store-backend.ts`.
 */
import {
  DEFAULT_PROFILE_OPTIONS,
  type ProfileOptions,
  type ProfileOutcome,
  type ProfileSections,
} from '@/lib/concept-mapping/concept-profile'

export type SectionKey = keyof ProfileSections

/**
 * The profile blocks, in the order they are offered.
 *
 * Ordered the way you read a concept you have never seen: first how much of it
 * there is, then what its values ARE, and finally where the records came from.
 * Grouped contiguously, because the dropdown heads each run with the name of the
 * detail-view block it feeds — see SECTION_GROUPS.
 */
export const SECTION_KEYS: readonly SectionKey[] = [
  // Volume and coverage — how much of this concept there is.
  'counts',
  'missingRate',
  'perPatient',
  'frequency',
  // Values — what the records actually hold.
  'numeric',
  'histogram',
  'unit',
  'categorical',
  // Context — where and when the records came from.
  'temporal',
  'hospitalUnits',
]

/**
 * Which block of the concept detail view each option ends up in.
 *
 * The same three headings the profile is READ under, so the choice of what to
 * compute and the result it produces are described in one vocabulary. The keys
 * are i18n suffixes, resolved against `concept_mapping.extract_group_*`.
 */
export const SECTION_GROUPS: Record<SectionKey, string> = {
  counts: 'volume',
  missingRate: 'volume',
  perPatient: 'volume',
  frequency: 'volume',
  numeric: 'values',
  histogram: 'values',
  unit: 'values',
  categorical: 'values',
  temporal: 'context',
  hospitalUnits: 'context',
}

/** The profile keys each section writes. `counts` lives beside the JSON. */
const SECTION_JSON_KEYS: Record<SectionKey, readonly string[]> = {
  counts: [],
  numeric: ['numeric_data'],
  histogram: ['histogram'],
  categorical: ['categorical_data'],
  unit: ['unit'],
  frequency: ['measurement_frequency'],
  temporal: ['temporal_distribution'],
  hospitalUnits: ['hospital_units'],
  missingRate: ['missing_rate'],
  perPatient: ['records_per_patient'],
}

/** Categories and wards kept per concept: any reader's `topN` up to this is a cut. */
export const STORED_TOP_N = 200

/** How the numeric sections were computed: another choice means other numbers. */
export interface ProfileVariant {
  outlierMethod: ProfileOptions['outlierMethod']
  outlierCoef: number
  bins: ProfileOptions['bins']
}

export interface StoredProfile {
  dictKey: string
  conceptId: number
  rowsCount: number
  patientsCount: number | null
  /** The exact profile: no threshold, categories and wards up to STORED_TOP_N. */
  json: Record<string, unknown>
  /** What the JSON answers for — a section asked and found empty is listed too. */
  sections: SectionKey[]
  variant: ProfileVariant
  /** The data it was computed on (`dataFingerprint`); another one makes it stale. */
  fingerprint: string
  computedAt: string
}

export function variantOf(options: ProfileOptions): ProfileVariant {
  return { outlierMethod: options.outlierMethod, outlierCoef: options.outlierCoef, bins: options.bins }
}

const sameVariant = (a: ProfileVariant, b: ProfileVariant) =>
  a.outlierMethod === b.outlierMethod && a.outlierCoef === b.outlierCoef && a.bins === b.bins

/** The options a stored profile is computed with: the reader's sections and
 *  variant, none of its thresholds. */
export function exactOptions(options: ProfileOptions, sections: ProfileSections = options.sections): ProfileOptions {
  return {
    ...options,
    metadata: true,
    sections,
    minPatients: 0,
    minCategoryCount: 1,
    topN: STORED_TOP_N,
    maxCategoryLength: Number.MAX_SAFE_INTEGER,
  }
}

export function sectionsOf(sections: ProfileSections): SectionKey[] {
  return SECTION_KEYS.filter((k) => sections[k] ?? k === 'counts')
}

export function sectionSet(keys: readonly SectionKey[]): ProfileSections {
  const out = { counts: false } as ProfileSections
  for (const k of SECTION_KEYS) out[k] = keys.includes(k)
  return out
}

/**
 * The asked sections a stored profile cannot answer: absent, computed on other
 * data, or — for the numeric ones — under another variant. Every one when there
 * is no stored profile.
 */
export function missingSections(
  stored: StoredProfile | undefined,
  wanted: ProfileSections,
  variant: ProfileVariant,
  fingerprint: string,
): SectionKey[] {
  const asked = sectionsOf(wanted)
  if (!stored || stored.fingerprint !== fingerprint) return asked
  return asked.filter((k) =>
    !stored.sections.includes(k)
    || ((k === 'numeric' || k === 'histogram') && !sameVariant(stored.variant, variant)))
}

/**
 * A stored profile with `computed` replaced by what was just computed for them.
 * Sections not recomputed are kept — unless the data changed, which makes them
 * stale: then only the fresh ones remain.
 */
export function mergeProfile(
  stored: StoredProfile | undefined,
  fresh: ProfileOutcome,
  computed: readonly SectionKey[],
  identity: { dictKey: string; conceptId: number },
  variant: ProfileVariant,
  fingerprint: string,
  computedAt: string,
): StoredProfile {
  const keep = stored && stored.fingerprint === fingerprint ? stored : undefined
  const json: Record<string, unknown> = { ...(keep?.json ?? {}) }
  for (const k of computed) for (const key of SECTION_JSON_KEYS[k]) delete json[key]
  const freshJson = fresh.json ?? {}
  for (const [key, value] of Object.entries(freshJson)) {
    if (key === 'data_types') continue
    const section = SECTION_KEYS.find((k) => SECTION_JSON_KEYS[k].includes(key))
    // A fresh run answers for its own sections only, and for the identity keys.
    if (!section || computed.includes(section)) json[key] = value
  }
  const numericKept = !computed.includes('numeric') && keep && !sameVariant(keep.variant, variant)
  if (numericKept) {
    // The numeric sections kept describe the old variant: dropped rather than
    // stored under a variant they were not computed with.
    delete json.numeric_data
    delete json.histogram
  }
  const sections = new Set<SectionKey>([...(keep?.sections ?? []), ...computed])
  if (numericKept) {
    sections.delete('numeric')
    sections.delete('histogram')
  }
  return {
    ...identity,
    rowsCount: fresh.rowsCount,
    patientsCount: fresh.patientsCount,
    json,
    sections: SECTION_KEYS.filter((k) => sections.has(k)),
    variant,
    fingerprint,
    computedAt,
  }
}

/** Whether the "categories" are the numeric values written as text (see
 *  `categoriesMirrorNumbers` in concept-profile.ts). */
function mirrorsNumbers(categories: { category: string }[]): boolean {
  return categories.length > 0 && categories.every((row) => {
    const trimmed = String(row.category).trim()
    return trimmed !== '' && Number.isFinite(Number(trimmed))
  })
}

/**
 * The profile a reader with `options` gets from a stored one: its sections
 * only, its thresholds applied — what computing it with those options would
 * have given. Null JSON when the concept is under its patient threshold.
 */
export function filterProfile(stored: StoredProfile, options: ProfileOptions = DEFAULT_PROFILE_OPTIONS): ProfileOutcome {
  const base = { rowsCount: stored.rowsCount, patientsCount: stored.patientsCount }
  if (stored.patientsCount != null && stored.patientsCount < options.minPatients) return { ...base, json: null }
  const wanted = new Set(sectionsOf(options.sections))
  const json: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored.json)) {
    if (key === 'data_types') continue
    const section = SECTION_KEYS.find((k) => SECTION_JSON_KEYS[k].includes(key))
    if (section && !wanted.has(section)) continue
    json[key] = value
  }
  const hasNumeric = !!json.numeric_data && Object.keys(json.numeric_data as object).length > 0
  if (Array.isArray(json.categorical_data)) {
    const kept = (json.categorical_data as { category: string; count?: number }[])
      .filter((row) => (row.count ?? 0) >= options.minCategoryCount && String(row.category).length <= options.maxCategoryLength)
      .slice(0, options.topN)
    if (kept.length === 0 || (hasNumeric && mirrorsNumbers(kept))) delete json.categorical_data
    else json.categorical_data = kept
  }
  if (Array.isArray(json.hospital_units)) {
    json.hospital_units = (json.hospital_units as unknown[]).slice(0, options.topN)
  }
  const types = [hasNumeric && 'numeric', Array.isArray(json.categorical_data) && 'categorical'].filter(Boolean)
  const ordered: Record<string, unknown> = {}
  for (const key of ['full_name', 'data_source']) if (key in json) ordered[key] = json[key]
  if (types.length === 1) ordered.data_types = types[0]
  else if (types.length > 1) ordered.data_types = types
  for (const [key, value] of Object.entries(json)) if (!(key in ordered)) ordered[key] = value
  return { ...base, json: ordered }
}

/** A short, stable digest (FNV-1a) — to tell versions apart, not for security. */
export function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
