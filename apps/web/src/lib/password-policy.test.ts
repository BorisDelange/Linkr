import { afterEach, describe, expect, it } from 'vitest'
import {
  PASSWORD_MIN_LENGTH, passwordErrorFromApi, passwordRuleError, setPasswordMinLength,
} from './password-policy'

afterEach(() => setPasswordMinLength(PASSWORD_MIN_LENGTH))

describe('passwordRuleError', () => {
  it.each([
    ['k7#mQ2!vR9p', 'password_too_short'],
    ['k7#mQ2!vR9pL', null],
    ['x'.repeat(72), null],
    ['x'.repeat(73), 'password_too_long'],
    // é is two bytes in UTF-8: 37 of them are 74 bytes.
    ['é'.repeat(37), 'password_too_long'],
    // An emoji is two UTF-16 units but one character, as the server counts it.
    ['k7#mQ2!vR9\u{1F511}', 'password_too_short'],
    ['k7#mQ2!vR9p\u{1F511}', null],
    ['Alice.Martin', 'password_is_username'],
    [' alice.martin ', 'password_is_username'],
    ['alice.martin!', null],
  ])('%s → %s', (password, code) => {
    expect(passwordRuleError(password, { username: 'alice.martin' })?.code ?? null).toBe(code)
  })

  it('refuses the current password', () => {
    expect(passwordRuleError('k7#mQ2!vR9pL', { current: 'k7#mQ2!vR9pL' })?.code).toBe('password_same_as_current')
  })

  it('follows the instance minimum', () => {
    setPasswordMinLength(16)
    expect(passwordRuleError('k7#mQ2!vR9pL')).toEqual({ code: 'password_too_short', params: { count: 16 } })
  })
})

describe('passwordErrorFromApi', () => {
  it('reads the code from the raw body text an ApiError carries', () => {
    const err = new Error('{"detail":{"code":"password_common","message":"…"}}')
    expect(passwordErrorFromApi(err)).toEqual({ code: 'password_common' })
  })

  it('carries the server minimum', () => {
    const body = { detail: { code: 'password_too_short', minLength: 14, message: '…' } }
    expect(passwordErrorFromApi(body)).toEqual({ code: 'password_too_short', params: { count: 14 } })
  })

  it.each([
    'not json',
    '{"detail":"Username already exists"}',
    '{"detail":{"code":"something_else"}}',
    null,
  ])('ignores %s', (source) => {
    expect(passwordErrorFromApi(source)).toBeNull()
  })
})
