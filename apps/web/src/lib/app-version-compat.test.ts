import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from '@/lib/version'
import { readImportedManifest } from '@/lib/entity-io'
import { MANIFEST, type LayoutKind } from '@linkr/format'
import i18n from '@/lib/i18n'
import { assertAppVersionSupported, assertEntityType, IncompatibleAppVersionError, MissingManifestError, requiredAppVersion, WrongEntityTypeError } from './app-version-compat'

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

  it('does not parse a record list sharing a manifest name', async () => {
    const list = `  [${'{"sourceCode":"x"},'.repeat(50)}{}]`
    const zip = zipOf({ 'mappings/mappings.json': list, 'entity.json': { minAppVersion: '2.4.3' } })
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(await requiredAppVersion(zip)).toBe('2.4.3')
      expect(parse.mock.calls.some(([text]) => text === list)).toBe(false)
    } finally {
      parse.mockRestore()
    }
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

describe('assertEntityType', () => {
  it('refuses a manifest declaring another kind — a schema dropped on the Projects page', () => {
    expect(() => assertEntityType({ type: 'schema-preset' }, 'project')).toThrow(WrongEntityTypeError)
  })

  it('accepts the expected kind, and a manifest that predates `type`', () => {
    expect(() => assertEntityType({ type: 'project' }, 'project')).not.toThrow()
    expect(() => assertEntityType({ entityId: 'p' }, 'project')).not.toThrow()
  })
})

describe('entity type labels', () => {
  it('has one for every kind, so a refusal never prints a raw type', () => {
    for (const kind of Object.keys(MANIFEST) as LayoutKind[]) {
      expect(i18n.exists(`catalog.type_${kind.replace(/-/g, '_')}`), kind).toBe(true)
    }
  })

  it('names the expected kind when a ZIP holds no manifest', () => {
    expect(new MissingManifestError('etl-pipeline').message).toContain(i18n.t('catalog.type_etl_pipeline'))
  })
})

describe('readImportedManifest', () => {
  it('checks the declared type', () => {
    expect(() => readImportedManifest({ 'entity.json': { type: 'project' } }, 'etl-pipeline')).toThrow(WrongEntityTypeError)
  })

  it("skips a mapping project's mappings.json, which is its mappings, not its metadata", () => {
    const parsed = { 'mappings.json': [{ id: 'm' }], 'project.json': { name: 'MP' } }
    expect(readImportedManifest(parsed, 'mapping-project', 'project.json')).toEqual({ name: 'MP' })
  })
})
