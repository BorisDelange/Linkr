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
  // `||` (not `??`) so a defined-but-empty language ({ en: 'x', fr: '' }) falls
  // through to English rather than reading blank — old data stored an explicit
  // empty string for the untouched language.
  return value[lang] || value['en'] || Object.values(value).find(Boolean) || ''
}

/**
 * The raw text stored for exactly `lang`, with NO fallback to another language.
 * For edit inputs: `localized()` falls back to English when the active language
 * is blank, which makes an emptied field snap back to the English value so it
 * can never be cleared. Editing must show (and let you clear) only `lang`'s own
 * value. A legacy plain string is that value for every language.
 */
export function localizedRaw(
  value: LocalizedString | string | null | undefined,
  lang: string,
): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return value[lang] ?? ''
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

/**
 * Does a possibly-multilingual value carry any non-empty text? A plain string
 * must be non-blank; a LocalizedString must have at least one non-blank language.
 * Used to drop empty affiliation/profession from an author snapshot.
 */
export function hasLocalizedContent(value: LocalizedString | string | null | undefined): boolean {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return Object.values(value).some((v) => typeof v === 'string' && v.trim() !== '')
}

/**
 * True when a string is (the start of) the SPA index.html shell. An earlier
 * seed-loader bug fetched a missing README.<lang>.md and got index.html back;
 * this detects that pollution so it can be scrubbed from stored readmes.
 */
export function isShellHtml(value: string): boolean {
  return /^\s*<(?:!doctype|html|script|meta)\b/i.test(value)
}
