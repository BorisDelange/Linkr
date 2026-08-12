import { describe, it, expect } from 'vitest'
import { cardMatches, cardsForScope } from './pull-quick-actions'
import { buildQuickActions } from './git-quick-actions'
import type { GitFileChange } from './api/git'

const change = (path: string): GitFileChange => ({ path, changeType: 'modified', size: 10 })

describe('pull cards', () => {
  it('offers a single "pull all" card', () => {
    // Pulling is already element-by-element (each file's rows are ticked in its
    // picker), so a second, coarser grouping on top only asks the user to choose
    // twice — and a partial card would be misleading anyway, since `stats` in
    // project.json is derived from mappings.json.
    expect(cardsForScope('mapping-projects').map((c) => c.id)).toEqual(['all'])
    expect(cardsForScope('projects').map((c) => c.id)).toEqual(['all'])
  })

  it('falls back to a single "all" card for a scope with no definition', () => {
    expect(cardsForScope('dq-rule-sets').map((c) => c.id)).toEqual(['all'])
  })

  it('the "all" card covers everything, including unknown paths', () => {
    const all = cardsForScope('mapping-projects').find((c) => c.isAll)!
    expect(cardMatches(all, 'anything/at/all.txt')).toBe(true)
    expect(cardMatches(all, 'mappings.json')).toBe(true)
  })
})

describe('push cards mirror the pull cards', () => {
  it('mapping projects expose Sync all alone, matching the single pull card', () => {
    const labels = buildQuickActions('mapping-projects', []).map((a) => a.labelKey)
    expect(labels).toEqual(['versioning.quick_sync_all'])
    expect(cardsForScope('mapping-projects')).toHaveLength(1)
  })

  it('Sync all still carries every owned path', () => {
    const actions = buildQuickActions('mapping-projects', [
      change('project.json'), change('README.fr.md'), change('mappings.json'), change('source-concepts.csv'),
    ])
    expect(actions[0].files.map((f) => f.path)).toEqual([
      'project.json', 'README.fr.md', 'mappings.json', 'source-concepts.csv',
    ])
  })
})
