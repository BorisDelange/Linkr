/**
 * Shape-checking primitives.
 *
 * Hand-written rather than schema-library-driven, deliberately: the app ships to
 * the browser (including a WASM/static build), has no validation dependency
 * today, and every check here needs to emit a Linkr-shaped `Issue` with a `hint`
 * anyway — which a generic library's error objects would have to be mapped into.
 * The checks are small, and the mapping layer they would need is not smaller than
 * the checks themselves.
 */
import type { IssueBag, IssueCode } from './issue.js'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{ en?, fr?, … }`. Linkr's translatable label type. */
export type LocalizedString = Record<string, string>

/**
 * Accepts a LocalizedString **or** a bare string.
 *
 * Older exports wrote `"name": "CLIP-MIR"` where current ones write
 * `{"en": …, "fr": …}` — both are in the wild (see the RiCDC clip-icu project),
 * and the app reads both. Flagging the bare string as an error would condemn
 * every legacy tree; it is reported as `legacy-format` at warning level instead.
 */
export function checkLocalized(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  { required = false, label = 'name' }: { required?: boolean; label?: string } = {},
): void {
  if (value == null) {
    if (required) bag.error(path, pointer, 'missing-field', `A ${label} is required.`)
    return
  }
  if (typeof value === 'string') {
    if (required && !value.trim()) {
      bag.error(path, pointer, 'empty-value', `The ${label} is empty.`)
      return
    }
    bag.warn(
      path,
      pointer,
      'legacy-format',
      `The ${label} is a bare string; the current format uses a localized object.`,
      'Write {"en": "…", "fr": "…"}.',
    )
    return
  }
  if (!isObject(value)) {
    bag.error(path, pointer, 'wrong-type', 'Expected a localized object or a string.')
    return
  }
  const entries = Object.entries(value)
  const bad = entries.find(([, v]) => typeof v !== 'string')
  if (bad) {
    bag.error(path, `${pointer}/${bad[0]}`, 'wrong-type', 'Every translation must be a string.')
    return
  }
  if (required && !entries.some(([, v]) => (v as string).trim())) {
    bag.error(path, pointer, 'empty-value', `The ${label} has no non-empty translation.`)
  }
}

/** Read a localized value as plain text, preferring `lang`. Mirrors the app's `localized()`. */
export function readLocalized(value: unknown, lang = 'en'): string {
  if (typeof value === 'string') return value
  if (!isObject(value)) return ''
  const preferred = value[lang]
  if (typeof preferred === 'string' && preferred.trim()) return preferred
  const first = Object.values(value).find((v) => typeof v === 'string' && v.trim())
  return typeof first === 'string' ? first : ''
}

export function checkString(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  { required = false, label = 'value' }: { required?: boolean; label?: string } = {},
): value is string {
  if (value == null) {
    if (required) bag.error(path, pointer, 'missing-field', `${label} is required.`)
    return false
  }
  if (typeof value !== 'string') {
    bag.error(path, pointer, 'wrong-type', `${label} must be a string.`)
    return false
  }
  if (required && !value.trim()) {
    bag.error(path, pointer, 'empty-value', `${label} is empty.`)
    return false
  }
  return true
}

export function checkNumber(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  { required = false, label = 'value', integer = false }: {
    required?: boolean
    label?: string
    integer?: boolean
  } = {},
): value is number {
  if (value == null) {
    if (required) bag.error(path, pointer, 'missing-field', `${label} is required.`)
    return false
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bag.error(path, pointer, 'wrong-type', `${label} must be a number.`)
    return false
  }
  if (integer && !Number.isInteger(value)) {
    bag.error(path, pointer, 'wrong-type', `${label} must be a whole number.`)
    return false
  }
  return true
}

export function checkArray(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  { required = false, label = 'value' }: { required?: boolean; label?: string } = {},
): value is unknown[] {
  if (value == null) {
    if (required) bag.error(path, pointer, 'missing-field', `${label} is required.`)
    return false
  }
  if (!Array.isArray(value)) {
    bag.error(path, pointer, 'wrong-type', `${label} must be an array.`)
    return false
  }
  return true
}

export function checkEnum<T extends string>(
  bag: IssueBag,
  path: string,
  pointer: string,
  value: unknown,
  allowed: readonly T[],
  { required = false, label = 'value', code = 'wrong-type' as IssueCode }: {
    required?: boolean
    label?: string
    code?: IssueCode
  } = {},
): value is T {
  if (value == null) {
    if (required) bag.error(path, pointer, 'missing-field', `${label} is required.`)
    return false
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    bag.error(path, pointer, code, `${label} is not a valid value.`, `allowed: ${allowed.join(', ')}`)
    return false
  }
  return true
}
