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
