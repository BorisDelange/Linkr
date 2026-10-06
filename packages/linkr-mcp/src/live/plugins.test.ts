import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listPatientPlugins } from './lab-extra'
import { findPlugin } from './plugins'

const APP_PLUGINS = fileURLToPath(new URL('../../../../apps/web/src/lib/plugins/', import.meta.url))
const DEFAULT_PLUGINS = fileURLToPath(new URL('../../../default-plugins/', import.meta.url))
const appSource = ['default-plugins.ts', 'builtin-widget-plugins.ts']
  .map((f) => readFileSync(`${APP_PLUGINS}${f}`, 'utf8'))
  .join('\n')

describe('built-in plugins the app registers', () => {
  it('are all known to the MCP when their manifest is a plugin.json', () => {
    const imported = [...appSource.matchAll(/@default-plugins\/(analyses|patient-data)\/([^/]+)\/plugin\.json/g)]
    expect(imported.length).toBeGreaterThan(10)
    for (const [, kind, folder] of imported) {
      const { id } = JSON.parse(readFileSync(`${DEFAULT_PLUGINS}${kind}/${folder}/plugin.json`, 'utf8'))
      const known = kind === 'analyses' ? findPlugin(id) : listPatientPlugins().find((p) => p.id === id)
      expect(known?.id, id).toBe(id)
    }
  })

  it('declare no new manifest inline in TypeScript, which the MCP cannot read', () => {
    const inline = [...appSource.matchAll(/manifest:\s*\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])
    expect(inline).toEqual([])
  })
})
