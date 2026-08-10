import { describe, expect, it } from 'vitest'
import {
  buildEtlPullPlan,
  ETL_PULL_GROUPS,
  etlDocItems,
  etlDocTarget,
  etlFilesByPath,
  etlPullGroupOf,
  etlRecordPaths,
  etlSettingsChanged,
  isEtlManifest,
  stripInstancePipelineFields,
} from './etl-pull'
import { attachTreeIds } from './entity-io'
import { readEntityDocsFrom } from './entity-docs-pull'
import type { EtlFile, EtlPipeline } from '@/types'
import type { TreeImportNode } from './entity-io'

const file = (id: string, name: string, parentId: string | null, content = ''): EtlFile => ({
  id, pipelineId: 'p1', name, type: 'file', parentId, content, order: 0, createdAt: '2026-01-01',
})
const folder = (id: string, name: string, parentId: string | null = null): EtlFile => ({
  id, pipelineId: 'p1', name, type: 'folder', parentId, order: 0, createdAt: '2026-01-01',
})

const node = (path: string, content?: string): TreeImportNode => ({ path, type: 'file', content })

describe('etlPullGroupOf', () => {
  it('classifies with the push-side vocabulary', () => {
    // The point of delegating to gitFileMeta: one path, one category, both screens.
    expect(etlPullGroupOf('10_src_code.sql')).toBe('scripts')
    expect(etlPullGroupOf('transform.py')).toBe('scripts')
    expect(etlPullGroupOf('stats.R')).toBe('scripts')
    expect(etlPullGroupOf('mapping/source_to_concept_map.csv')).toBe('mappings')
  })

  it('puts anything unrecognised in "other"', () => {
    expect(etlPullGroupOf('notes.txt')).toBe('other')
  })

  it('classifies the docs files into their own group', () => {
    for (const p of ['README.md', 'README.fr.md', 'LICENSE.md']) {
      expect(etlPullGroupOf(p)).toBe('docs')
    }
    // They are still excluded from the TREE walk: the entity owns them as fields,
    // so their rows come from etlDocItems rather than from _tree.json.
    expect(isEtlManifest('README.md')).toBe(true)
  })

  it('does not mistake a CSV outside mapping/ for a dictionary', () => {
    expect(etlPullGroupOf('data/extract.csv')).toBe('other')
  })
})

describe('isEtlManifest', () => {
  it('covers the manifests and git config', () => {
    expect(isEtlManifest('_pipeline.json')).toBe(true)
    expect(isEtlManifest('_tree.json')).toBe(true)
    expect(isEtlManifest('.gitignore')).toBe(true)
    expect(isEtlManifest('.gitattributes')).toBe(true)
    expect(isEtlManifest('10_src.sql')).toBe(false)
  })
})

describe('etlFilesByPath', () => {
  it('derives nested paths by walking parentId', () => {
    const files = [folder('f1', 'mapping'), file('a', 'stcm.csv', 'f1'), file('b', '00_vocab.sql', null)]
    const map = etlFilesByPath(files)
    expect([...map.keys()].sort()).toEqual(['00_vocab.sql', 'mapping/stcm.csv'])
  })

  it('omits folders — only files are pullable items', () => {
    expect(etlFilesByPath([folder('f1', 'mapping')]).size).toBe(0)
  })
})

describe('buildEtlPullPlan', () => {
  const REMOTE = [
    node('00_vocabulary.sql', 'TRUNCATE;'),
    node('10_src_code.sql', 'INSERT;'),
    node('mapping/stcm.csv', 'a,b\n1,2'),
    node('notes.txt', 'free text'),
    node('README.md', '# doc'),
    node('_tree.json', '[]'),
    node('.gitignore', '*.csv'),
  ]

  it('groups by category and drops the manifests', () => {
    const plan = buildEtlPullPlan(REMOTE, [], false)
    expect(plan.groups.scripts.map((i) => i.key)).toEqual(['00_vocabulary.sql', '10_src_code.sql'])
    expect(plan.groups.mappings.map((i) => i.key)).toEqual(['mapping/stcm.csv'])
    // README.md is absent: it travels as the docs block, not as a file item.
    expect(plan.groups.other.map((i) => i.key)).toEqual(['notes.txt'])
  })

  it('marks everything new when there is nothing local', () => {
    const plan = buildEtlPullPlan(REMOTE, [], false)
    expect(plan.groups.scripts.every((i) => !i.exists)).toBe(true)
  })

  it('marks a path that exists locally as an overwrite', () => {
    const local = [file('x', '10_src_code.sql', null, 'MY OWN EDIT')]
    const plan = buildEtlPullPlan(REMOTE, local, false)
    const item = plan.groups.scripts.find((i) => i.key === '10_src_code.sql')
    expect(item).toMatchObject({ exists: true })
  })

  it('OMITS a byte-identical file: the list is only what you can act on', () => {
    // A re-clone otherwise listed every script, burying the one real change and
    // pushing the dialog past its own footer.
    const local = [file('x', '10_src_code.sql', null, 'INSERT;')]
    const plan = buildEtlPullPlan(REMOTE, local, false)
    expect(plan.groups.scripts.map((i) => i.key)).toEqual(['00_vocabulary.sql'])
  })

  it('is empty when everything matches, which is what "up to date" means', () => {
    const local = [
      file('a', '00_vocabulary.sql', null, 'TRUNCATE;'),
      file('b', '10_src_code.sql', null, 'INSERT;'),
      file('c', 'notes.txt', null, 'free text'),
      folder('f1', 'mapping'),
      file('d', 'stcm.csv', 'f1', 'a,b\n1,2'),
    ]
    const plan = buildEtlPullPlan(REMOTE, local, false)
    expect(ETL_PULL_GROUPS.every((g) => plan.groups[g].length === 0)).toBe(true)
  })

  it('compares nested paths, not bare names', () => {
    // Same path AND same content → nothing to do, so it drops out entirely.
    const local = [folder('f1', 'mapping'), file('x', 'stcm.csv', 'f1', 'a,b\n1,2')]
    expect(buildEtlPullPlan(REMOTE, local, false).groups.mappings).toEqual([])
    // Same path, different content → an overwrite the user can choose.
    const edited = [folder('f1', 'mapping'), file('x', 'stcm.csv', 'f1', 'CHANGED')]
    expect(buildEtlPullPlan(REMOTE, edited, false).groups.mappings[0])
      .toMatchObject({ key: 'mapping/stcm.csv', exists: true })
  })

  it('treats a missing content field as empty rather than undefined', () => {
    // ('' vs undefined) must not read as a difference, or an empty file would be
    // offered on every pull.
    const local = [file('x', 'notes.txt', null, '')]
    expect(buildEtlPullPlan([node('notes.txt')], local, false).groups.other).toEqual([])
  })

  it('sorts each group by path, so the list order is stable', () => {
    const shuffled = [node('z.sql'), node('a.sql'), node('m.sql')]
    expect(buildEtlPullPlan(shuffled, [], false).groups.scripts.map((i) => i.key))
      .toEqual(['a.sql', 'm.sql', 'z.sql'])
  })

  it('carries the settings flag through', () => {
    expect(buildEtlPullPlan([], [], true).settingsChanged).toBe(true)
  })
})

describe('etlSettingsChanged', () => {
  const local = {
    id: 'p1', name: { en: 'Pipeline' }, description: { en: 'd' }, config: { excludedFiles: [] },
  } as unknown as EtlPipeline
  /** The remote record as it would arrive, with one field overridden per case. */
  const remote = (over: Partial<EtlPipeline> = {}): Partial<EtlPipeline> => ({
    name: { en: 'Pipeline' }, description: { en: 'd' }, config: { excludedFiles: [] }, ...over,
  })

  it('is false with no remote record', () => {
    expect(etlSettingsChanged(local, null)).toBe(false)
  })

  it('is false when the pullable fields all match', () => {
    expect(etlSettingsChanged(local, remote())).toBe(false)
  })

  it('notices a changed name, description or config', () => {
    expect(etlSettingsChanged(local, remote({ name: { en: 'Other' } }))).toBe(true)
    expect(etlSettingsChanged(local, remote({ description: { en: 'x' } }))).toBe(true)
    expect(etlSettingsChanged(local, remote({ config: { excludedFiles: ['a.sql'] } }))).toBe(true)
  })

  it('notices a name changed in ONE locale only', () => {
    // Names are LocalizedString, so a shallow !== on the object would miss this.
    expect(etlSettingsChanged(local, remote({ name: { en: 'Pipeline', fr: 'Renommée' } }))).toBe(true)
  })

  it('ignores timestamps, which would otherwise light the toggle on every fetch', () => {
    expect(etlSettingsChanged(local, remote({ updatedAt: '2030-01-01' }))).toBe(false)
  })
})

describe('stripInstancePipelineFields', () => {
  /** Every key a REAL exported _pipeline.json carries (read off the mimic-iv-to-omop
   *  repo), so this test fails if the export starts emitting something new that a
   *  pull must not take. */
  const REAL_EXPORT = {
    badges: [], config: { excludedFiles: [] }, createdAt: '2026-08-06T10:00:00Z',
    createdBy: 7, createdByDetails: { name: 'Someone' }, description: { en: 'd' },
    entityId: 'mimic-iv-to-omop', id: 'remote-uuid', lastRunAt: '2026-08-09T17:00:00Z',
    lastRunDurationMs: 421_000, lineageId: 'lin-1', mappingProjectId: 'mp-theirs',
    name: { en: 'MIMIC-IV to OMOP' }, organization: { id: 'org-theirs' },
    parentLineageId: null, sourceDataSourceId: 'ds-theirs',
    status: 'ready', targetDataSourceId: 'ds-theirs-2', version: 3,
    workspaceId: 'ws-theirs', gitRemoteConfig: { url: 'x', branch: 'main' },
  } as unknown as EtlPipeline

  it('drops the ids that name databases and mapping projects on THIS instance', () => {
    // Taking a collaborator's would repoint the pipeline at things that do not
    // exist here.
    const out = stripInstancePipelineFields(REAL_EXPORT) as Record<string, unknown>
    for (const k of ['sourceDataSourceId', 'targetDataSourceId', 'mappingProjectId', 'workspaceId', 'gitRemoteConfig']) {
      expect(out).not.toHaveProperty(k)
    }
  })

  it('drops OUR run state, which describes runs that never happened here', () => {
    // The quality cache keys on the last run, so importing a foreign lastRunAt
    // would also invalidate it against a target that never changed.
    const out = stripInstancePipelineFields(REAL_EXPORT) as Record<string, unknown>
    for (const k of ['lastRunAt', 'lastRunDurationMs', 'status']) {
      expect(out).not.toHaveProperty(k)
    }
  })

  it('drops identity, which is resolved locally', () => {
    const out = stripInstancePipelineFields(REAL_EXPORT) as Record<string, unknown>
    for (const k of ['id', 'entityId', 'createdAt', 'organization']) {
      expect(out).not.toHaveProperty(k)
    }
  })

  it('keeps what the repo legitimately owns', () => {
    const out = stripInstancePipelineFields(REAL_EXPORT) as Record<string, unknown>
    expect(out.name).toEqual({ en: 'MIMIC-IV to OMOP' })
    expect(out.description).toEqual({ en: 'd' })
    expect(out.config).toEqual({ excludedFiles: [] })
  })
})

describe('etlRecordPaths', () => {
  it('recovers each record path, which attachTreeIds strips', () => {
    // The apply step matches remote records to local rows by PATH; this is the
    // half that makes that possible.
    const records = attachTreeIds<EtlFile>(
      [{ path: 'mapping/stcm.csv', type: 'file', content: 'a' }],
      'p1',
      'pipelineId',
    )
    const paths = [...etlRecordPaths(records).values()].sort()
    // The folder is synthesized from the path, so both rows come back.
    expect(paths).toEqual(['mapping', 'mapping/stcm.csv'])
  })

  it('agrees with etlFilesByPath on the same tree, which is what makes them comparable', () => {
    const records = attachTreeIds<EtlFile>(
      [{ path: 'a/b/c.sql', type: 'file', content: 'x' }],
      'p1',
      'pipelineId',
    )
    const viaRecords = [...etlRecordPaths(records).values()]
    const viaLocal = [...etlFilesByPath(records).keys()]
    expect(viaLocal).toEqual(['a/b/c.sql'])
    expect(viaRecords).toContain('a/b/c.sql')
  })
})

describe('README and LICENSE are docs, not tree files', () => {
  // The bug this covers, found on the real mimic-iv-to-omop repo: a remote commit
  // added README.md, but the file is deliberately ABSENT from _tree.json (the
  // entity owns its readme). Planning only from the manifest saw nothing, so the
  // dialog said "nothing to pull" while the remote was genuinely ahead.

  it('never offers a docs file as an individual item', () => {
    for (const p of ['README.md', 'README.fr.md', 'LICENSE.md', 'attachments/_meta.json']) {
      expect(isEtlManifest(p)).toBe(true)
    }
    const plan = buildEtlPullPlan(
      [node('README.md', '# doc'), node('LICENSE.md', 'MIT'), node('10_src.sql', 'X')],
      [],
      false,
    )
    expect(plan.groups.other).toEqual([])
    expect(plan.groups.scripts.map((i) => i.key)).toEqual(['10_src.sql'])
  })

  it('lists each readme language and the licence as their own FILE rows', () => {
    // The user picks files, the way the repository presents them — not an opaque
    // "readme" block. A French-only change is then one row, not "replace docs".
    const remote = readEntityDocsFrom(
      { 'README.md': '# EN', 'README.fr.md': '# FR', 'LICENSE.md': 'MIT' },
      { license: { id: 'mit' } },
    )
    const items = etlDocItems(remote, undefined)
    expect(items.map((i) => i.key)).toEqual(['README.md', 'README.fr.md', 'LICENSE.md'])
    expect(items.every((i) => !i.exists)).toBe(true)
  })

  it('marks a docs file the entity already has as an overwrite', () => {
    const remote = readEntityDocsFrom({ 'README.md': 'v2' }, null)
    expect(etlDocItems(remote, { readme: { en: 'v1' } })).toEqual([
      { key: 'README.md', exists: true },
    ])
  })

  it('omits a docs file whose content already matches', () => {
    const remote = readEntityDocsFrom({ 'README.md': 'same', 'README.fr.md': 'neuf' }, null)
    // Only the French one differs, so only it is offered.
    expect(etlDocItems(remote, { readme: { en: 'same', fr: 'vieux' } }).map((i) => i.key))
      .toEqual(['README.fr.md'])
  })

  it('offers nothing when the remote carries no docs', () => {
    expect(etlDocItems({}, { readme: { en: 'mine' } })).toEqual([])
  })

  it('puts the docs rows in their own group, ahead of the scripts', () => {
    const remote = readEntityDocsFrom({ 'README.md': '# doc' }, null)
    const plan = buildEtlPullPlan([node('10_src.sql', 'X')], [], false, etlDocItems(remote, undefined))
    expect(plan.groups.docs.map((i) => i.key)).toEqual(['README.md'])
    expect(ETL_PULL_GROUPS.indexOf('docs')).toBeLessThan(ETL_PULL_GROUPS.indexOf('scripts'))
  })

  it('maps a chosen docs path back to the field it writes', () => {
    expect(etlDocTarget('README.md')).toEqual({ readmeLang: 'en' })
    expect(etlDocTarget('README.fr.md')).toEqual({ readmeLang: 'fr' })
    expect(etlDocTarget('LICENSE.md')).toBe('license')
    expect(etlDocTarget('10_src.sql')).toBeNull()
  })
})
