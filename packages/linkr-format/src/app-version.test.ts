import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareVersions, isAppTooOld, MIN_APP_VERSION, minAppVersionFor } from './app-version.js'

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
    expect(compareVersions('2.4.2', '2.4.3')).toBe(-1)
    expect(compareVersions('2.4.3', '2.4.3')).toBe(0)
  })

  it('reads a missing segment as 0 and ignores a suffix or a v prefix', () => {
    expect(compareVersions('2.4', '2.4.0')).toBe(0)
    expect(compareVersions('v2.4.3-rc.1', '2.4.3')).toBe(0)
  })
})

describe('compareVersions parity with the server', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const fixture = JSON.parse(readFileSync(resolve(here, 'app-version.fixture.json'), 'utf-8')) as {
    cases: { a: string; b: string; expected: number }[]
  }

  it.each(fixture.cases)('compareVersions($a, $b) = $expected', ({ a, b, expected }) => {
    expect(compareVersions(a, b)).toBe(expected)
  })
})

describe('minAppVersionFor', () => {
  it('stamps nothing for a kind with no declared minimum', () => {
    expect(minAppVersionFor('project', '9.9.9')).toBeUndefined()
  })

  it('stamps the declared minimum once the writer has reached it', () => {
    expect(minAppVersionFor('schema-preset', '9.9.9')).toBe(MIN_APP_VERSION['schema-preset'])
  })

  it('never requires more than the writer itself, so a build reads its own exports', () => {
    expect(minAppVersionFor('schema-preset', '0.0.1')).toBe('0.0.1')
  })
})

describe('isAppTooOld', () => {
  it('refuses only a strictly newer minimum', () => {
    expect(isAppTooOld('2.4.3', '2.4.2')).toBe(true)
    expect(isAppTooOld('2.4.3', '2.4.3')).toBe(false)
    expect(isAppTooOld('2.4.1', '2.4.3')).toBe(false)
  })

  it('accepts a tree that declares no minimum', () => {
    expect(isAppTooOld(undefined, '2.4.2')).toBe(false)
    expect(isAppTooOld('', '2.4.2')).toBe(false)
    expect(isAppTooOld(3, '2.4.2')).toBe(false)
  })
})

describe('MIN_APP_VERSION parity with the server', () => {
  it('declares the same minimums as apps/api/app/export_version.py', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const py = readFileSync(resolve(here, '../../../apps/api/app/export_version.py'), 'utf-8')
    const block = py.match(/MIN_APP_VERSION[^=]*=\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    const server = Object.fromEntries([...block.matchAll(/"([\w-]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]))
    expect(server).toEqual(MIN_APP_VERSION)
  })
})
