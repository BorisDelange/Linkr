import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { APP_VERSION } from '@/lib/version'
import { assertAppVersionSupported, IncompatibleAppVersionError, requiredAppVersion } from './app-version-compat'

/**
 * The import-side guard of `minAppVersion`: a tree written for a newer Linkr must
 * be refused before anything is written, wherever its manifests sit.
 */

function zipOf(files: Record<string, unknown>): JSZip {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return zip
}

describe('requiredAppVersion', () => {
  it('is null when no manifest declares a minimum', async () => {
    expect(await requiredAppVersion(zipOf({ 'entity.json': { type: 'project', appVersion: '2.4.2' } }))).toBeNull()
  })

  it('reads nested manifests too — a workspace ZIP embeds its children', async () => {
    const zip = zipOf({
      'entity.json': { type: 'workspace' },
      'schemas/omop/entity.json': { type: 'schema-preset', minAppVersion: '2.4.3' },
      'projects/p/project.json': { minAppVersion: '2.10.0' },
    })
    expect(await requiredAppVersion(zip)).toBe('2.10.0')
  })

  it('ignores files that are not manifests, and manifests that do not parse', async () => {
    const zip = zipOf({
      'datasets/x/data.json': { minAppVersion: '99.0.0' },
      'entity.json': '{ not json',
    })
    expect(await requiredAppVersion(zip)).toBeNull()
  })
})

describe('assertAppVersionSupported', () => {
  it('lets through a tree this build can read', async () => {
    await expect(assertAppVersionSupported(zipOf({ 'entity.json': { minAppVersion: APP_VERSION } }))).resolves.toBeUndefined()
  })

  it('refuses a tree needing a newer Linkr, naming both versions', async () => {
    const err = await assertAppVersionSupported(zipOf({ 'entity.json': { minAppVersion: '999.0.0' } })).catch((e) => e)
    expect(err).toBeInstanceOf(IncompatibleAppVersionError)
    expect(err.required).toBe('999.0.0')
    expect(err.current).toBe(APP_VERSION)
  })
})
