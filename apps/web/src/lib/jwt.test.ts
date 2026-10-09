import { describe, expect, it } from 'vitest'
import { jwtSubject } from './jwt'

const token = (payload: object) =>
  `h.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`

describe('jwtSubject', () => {
  it('reads the subject of an unpadded base64url payload', () => {
    expect(jwtSubject(token({ sub: '42', note: '>>>???' }))).toBe('42')
  })

  it('is null for a missing or malformed token', () => {
    expect(jwtSubject(null)).toBeNull()
    expect(jwtSubject('not-a-jwt')).toBeNull()
    expect(jwtSubject('h.%%%.s')).toBeNull()
    expect(jwtSubject(token({ type: 'access' }))).toBeNull()
  })
})
