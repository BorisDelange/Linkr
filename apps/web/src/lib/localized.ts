import type { LocalizedString } from '@/types'

/**
 * Resolve a multilingual value for display: prefer the active language, then
 * English, then whatever first value exists. Accepts legacy plain strings and
 * nullish values so callers can pass raw data before migration has run.
 */
export function localized(
  value: LocalizedString | string | null | undefined,
  lang: string,
): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return value[lang] ?? value['en'] ?? Object.values(value)[0] ?? ''
}

/**
 * Coerce a possibly-legacy value into a LocalizedString. A plain string is
 * copied into every provided language so it shows up regardless of the active
 * language (backfill on read). Already-localized objects pass through.
 */
export function toLocalized(
  value: LocalizedString | string | null | undefined,
  langs: readonly string[] = ['en', 'fr'],
): LocalizedString {
  if (value == null) return {}
  if (typeof value === 'string') {
    return Object.fromEntries(langs.map((l) => [l, value]))
  }
  return value
}

/**
 * Return a copy of a LocalizedString with `lang` set to `text`. Used by edit
 * forms that only ever touch the active language (single visible field).
 */
export function setLocalized(
  value: LocalizedString | string | null | undefined,
  lang: string,
  text: string,
): LocalizedString {
  return { ...toLocalized(value), [lang]: text }
}
