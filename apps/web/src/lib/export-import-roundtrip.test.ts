/**
 * Export → import → re-export must reproduce the same tree.
 *
 * The golden suites freeze the bytes an export WRITES; nothing checked that an
 * import could read them back. Three bugs reached published repos through that
 * gap in a single day, all the same shape — a reader still assuming something
 * the writers had stopped doing:
 *
 *   - `applyClonedEntity` refused a mapping project whose manifest had no `id`,
 *     the field exports stopped writing when identity moved to entityId +
 *     lineageId. Every current-format repo was rejected as "not a mapping
 *     project".
 *   - the preset importer's `presetId` guard, same cause.
 *   - the workspace pointer for a DQ rule set nested itself under `ruleSet`,
 *     so the flat manifest every other kind writes read as no rule set at all.
 *
 * A golden test cannot catch these: it never runs the reader. This does, and it
 * asserts the round trip is STABLE — the second export equals the first — which
 * is also what makes a git sync report "nothing to commit" after a re-import.
 */
import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { applyClonedEntity, buildSchemaPresetZip } from './entity-io'
import type { Storage } from '@/lib/storage'
import type { CustomSchemaPreset } from '@/types'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))

/** A storage double that actually REMEMBERS what is written to it, so a tree can
 *  be imported and then exported again from the resulting row. */
function makeStore(seed?: CustomSchemaPreset) {
  const presets = new Map<string, CustomSchemaPreset>()
  if (seed) presets.set(seed.id, seed)
  const store = {
    schemaPresets: {
      // Mirrors IDBSchemaPresetStorage: keyed on `id`, falling back to the
      // retired `presetId`/`entityId` so either handle resolves.
      getById: async (key: string) =>
        presets.get(key)
        ?? [...presets.values()].find((p) => p.entityId === key || p.presetId === key),
      save: async (p: CustomSchemaPreset) => { presets.set(p.id, p) },
    },
    readmeAttachments: {
      getByOwner: async () => [],
      deleteByOwner: async () => {},
      create: async () => {},
    },
    workspaces: { getById: async () => ({ id: 'ws-1' }) },
    organizations: { getById: async () => undefined },
  } as unknown as Storage
  return { store, presets }
}

const PRESET: CustomSchemaPreset = {
  id: 'local-uuid-1',
  entityId: 'omop-cdm-5-4',
  workspaceId: 'ws-1',
  lineageId: 'lin-preset-1',
  version: '1.2.0',
  createdAt: '2026-01-02T03:04:05.000Z',
  createdBy: 'Boris Delange',
  license: { id: 'CC-BY-4.0' },
  mapping: {
    presetId: 'omop-cdm-5-4',
    presetLabel: { en: 'OMOP CDM 5.4', fr: 'OMOP CDM 5.4' },
    description: { en: 'The common data model', fr: 'Le modèle commun' },
    ddl: 'CREATE TABLE person (person_id INTEGER);\n',
    patientTable: { table: 'person', idColumn: 'person_id' },
    eventTables: {
      Measurement: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_date' },
    },
  },
} as unknown as CustomSchemaPreset

/** The ZIP bytes, read once: JSZip cannot re-read a Blob it has already consumed. */
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}

/** Every file of a built ZIP, as text, so two trees can be compared directly. */
async function treeOf(bytes: ArrayBuffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[path] = await entry.async('string')
  }
  return out
}

describe('schema preset: export → import → re-export', () => {
  it('reads back a tree it just wrote, and re-exports it byte for byte', async () => {
    const source = makeStore(PRESET)
    const first = await buildSchemaPresetZip(PRESET.id, source.store)
    expect(first).not.toBeNull()
    const firstBytes = await bytesOf(first!.blob)
    const firstTree = await treeOf(firstBytes)

    // The layout the reader must cope with — identity apart from payload.
    // (No LICENSE.md: this fixture declares a licence id with no text, and the
    // export only writes the file when there is text to put in it.)
    expect(Object.keys(firstTree).sort()).toEqual(
      ['entity.json', 'mapping.json', 'schema.ddl'],
    )

    // Import into a FRESH instance: no row to inherit anything from, which is
    // what a catalog install actually does.
    const target = makeStore()
    const ok = await applyClonedEntity(
      await JSZip.loadAsync(firstBytes), 'schema-preset', 'omop-cdm-5-4', target.store, 'ws-1',
    )
    expect(ok).toBe(true)
    expect(target.presets.size).toBe(1)

    const imported = [...target.presets.values()][0]
    // Identity survives: the lineage is what makes the two installs the same
    // published entity, and losing it turns every re-import into a duplicate.
    expect(imported.lineageId).toBe('lin-preset-1')
    expect(imported.entityId).toBe('omop-cdm-5-4')
    expect(imported.version).toBe('1.2.0')
    // Payload survives the split into its own file.
    expect(imported.mapping.ddl).toBe('CREATE TABLE person (person_id INTEGER);\n')
    expect(imported.mapping.patientTable?.table).toBe('person')
    expect(imported.mapping.eventTables?.Measurement?.table).toBe('measurement')
    // presetLabel is required on a SchemaMapping and lives at the manifest root
    // in the export — the reader has to put it back or the row is unnameable.
    expect(imported.mapping.presetLabel).toEqual({ en: 'OMOP CDM 5.4', fr: 'OMOP CDM 5.4' })

    // The real assertion: re-exporting the imported row reproduces the tree. A
    // git sync straight after an install must report nothing to commit.
    const second = await buildSchemaPresetZip(imported.id, target.store)
    expect(second).not.toBeNull()
    expect(await treeOf(await bytesOf(second!.blob))).toEqual(firstTree)
  })

  it('is stable across a second round trip', async () => {
    // Once is luck; twice is a fixed point. A field that drifts by one step per
    // cycle (a re-derived id, a re-stamped date) shows up here and nowhere else.
    const source = makeStore(PRESET)
    const first = await buildSchemaPresetZip(PRESET.id, source.store)

    const second = makeStore()
    await applyClonedEntity(await JSZip.loadAsync(await bytesOf(first!.blob)), 'schema-preset', 'omop-cdm-5-4', second.store, 'ws-1')
    const secondZip = await buildSchemaPresetZip([...second.presets.values()][0].id, second.store)

    const third = makeStore()
    await applyClonedEntity(await JSZip.loadAsync(await bytesOf(secondZip!.blob)), 'schema-preset', 'omop-cdm-5-4', third.store, 'ws-1')
    const thirdZip = await buildSchemaPresetZip([...third.presets.values()][0].id, third.store)
    const secondTree = await treeOf(await bytesOf(secondZip!.blob))

    expect(await treeOf(await bytesOf(thirdZip!.blob))).toEqual(secondTree)
  })

  it('does not need the local id the export stopped writing', async () => {
    // The manifest carries no `id` — an importer mints its own or keeps the row
    // it has. A reader that gates on it rejects every current-format repo, which
    // is exactly what happened to the published mapping project.
    const source = makeStore(PRESET)
    const built = await buildSchemaPresetZip(PRESET.id, source.store)
    const builtBytes = await bytesOf(built!.blob)
    const manifest = JSON.parse((await treeOf(builtBytes))['entity.json'])
    expect(manifest.id).toBeUndefined()
    expect(manifest.entityId).toBe('omop-cdm-5-4')
    expect(manifest.type).toBe('schema-preset')

    const target = makeStore()
    expect(
      await applyClonedEntity(await JSZip.loadAsync(builtBytes), 'schema-preset', 'fresh-id', target.store, 'ws-1'),
    ).toBe(true)
  })

  it('keeps the lineage of a repo that has one, rather than minting a new one', async () => {
    // Minting here would fork the identity on every install: two sites running
    // the same published preset would never recognise it as the same entity.
    const source = makeStore(PRESET)
    const built = await buildSchemaPresetZip(PRESET.id, source.store)
    const target = makeStore()
    await applyClonedEntity(await JSZip.loadAsync(await bytesOf(built!.blob)), 'schema-preset', 'x', target.store, 'ws-1')
    expect([...target.presets.values()][0].lineageId).toBe('lin-preset-1')
  })
})
