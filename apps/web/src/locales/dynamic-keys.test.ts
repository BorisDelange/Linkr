import { describe, it, expect } from 'vitest'
import en from './en.json'
import fr from './fr.json'
import { cardsForScope } from '@/lib/pull-quick-actions'
import { GIT_FILE_CATEGORIES } from '@/lib/git-file-meta'
import type { GitScope } from '@/lib/api/git'

/**
 * Keys built at runtime (`t(\`versioning.pull_change_${type}\`)`) are invisible to
 * a grep for literal key names — which is exactly how three of them were deleted
 * as "orphans" and shipped as raw `versioning.pull_change_add` on screen.
 *
 * So assert them from the SAME sources the code interpolates: the change-type
 * union, the card ids, the file categories. A new variant with no translation
 * fails here rather than in the UI.
 */
const versioning = (locale: typeof en) => locale.versioning as unknown as Record<string, string>

const LOCALES: [string, typeof en][] = [['en', en], ['fr', fr as unknown as typeof en]]

// The four states in PullItemState / MappingChangeType, rendered by
// PullMappingsTable, PullConceptsDialog and PullFileRow.
const CHANGE_TYPES = ['add', 'update', 'delete', 'conflict']

const SCOPES: GitScope[] = [
  'projects', 'workspaces', 'mapping-projects', 'sql-script-collections',
  'etl-pipelines', 'data-catalogs', 'dq-rule-sets', 'schema-presets',
  'user-plugins', 'settings',
]

describe('dynamically built i18n keys resolve', () => {
  for (const [name, locale] of LOCALES) {
    it(`${name}: every change type has a pull_change_* label`, () => {
      const keys = versioning(locale)
      for (const type of CHANGE_TYPES) {
        expect(keys[`pull_change_${type}`], `pull_change_${type}`).toBeTruthy()
      }
    })

    it(`${name}: every change type has a pull_filter_* label`, () => {
      // PullMappingsTable's type filter, which adds an "all" alongside the four.
      const keys = versioning(locale)
      for (const type of ['all', ...CHANGE_TYPES]) {
        expect(keys[`pull_filter_${type}`], `pull_filter_${type}`).toBeTruthy()
      }
    })

    it(`${name}: every pull card id has a pull_card_* title`, () => {
      const keys = versioning(locale)
      const ids = new Set(SCOPES.flatMap((s) => cardsForScope(s).map((c) => c.id)))
      for (const id of ids) {
        expect(keys[`pull_card_${id}`], `pull_card_${id}`).toBeTruthy()
      }
    })

    it(`${name}: every file category has a file_cat_* label`, () => {
      const keys = versioning(locale)
      for (const category of GIT_FILE_CATEGORIES) {
        expect(keys[`file_cat_${category}`], `file_cat_${category}`).toBeTruthy()
      }
    })
  }
})

/**
 * en.json and fr.json must hold exactly the same keys.
 *
 * English is the fallback language, so a key present only in French does not
 * degrade — it renders the raw key id on screen. That shipped: the `_plural`
 * suffix (dead in i18next v4 JSON) was converted to `_one`/`_other` in fr.json
 * only, and English users read "versioning.pull_count_add" in the pull panel.
 * Nothing else in the gate compares the two files.
 */
describe('locale parity', () => {
  const flatten = (value: unknown, prefix = ''): string[] =>
    Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? flatten(v, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    )

  it('en and fr declare the same keys', () => {
    const enKeys = new Set(flatten(en))
    const frKeys = new Set(flatten(fr))
    expect([...enKeys].filter((k) => !frKeys.has(k))).toEqual([])
    expect([...frKeys].filter((k) => !enKeys.has(k))).toEqual([])
  })
})
