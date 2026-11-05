import { describe, it, expect } from 'vitest'
import { assignToCards, cardMatches, cardsForScope } from './pull-quick-actions'
import { buildQuickActions } from './git-quick-actions'
import type { GitFileChange } from './api/git'

const change = (path: string): GitFileChange => ({ path, changeType: 'modified', size: 10 })

describe('pull cards', () => {
  it('splits an entity into its subjects, the catch-all last', () => {
    expect(cardsForScope('projects').map((c) => c.id)).toEqual([
      'info', 'dashboards', 'patient_boards', 'scripts', 'cohorts', 'datasets', 'concept_lists', 'connections', 'other',
    ])
    expect(cardsForScope('user-plugins').map((c) => c.id)).toEqual(['info', 'plugin_files', 'other'])
    expect(cardsForScope('settings').map((c) => c.id)).toEqual(['organizations', 'users', 'roles', 'other'])
  })

  it('puts each file on exactly one card, the first that claims it', () => {
    const groups = assignToCards('workspaces', ['entity.json', 'wiki/_tree.json', 'wiki/setup.md', 'projects/p/entity.json', 'odd.txt'], (p) => p)
    expect(groups.map((g) => [g.card.id, g.items])).toEqual([
      ['info', ['entity.json']],
      ['wiki', ['wiki/_tree.json', 'wiki/setup.md']],
      ['projects', ['projects/p/entity.json']],
      ['other', ['odd.txt']],
    ])
  })

  it('the catch-all covers everything', () => {
    const other = cardsForScope('dq-rule-sets').at(-1)!
    expect(cardMatches(other, 'anything/at/all.txt')).toBe(true)
  })
})

describe('push cards mirror the pull cards', () => {
  it('Sync all still carries every owned path', () => {
    const actions = buildQuickActions('mapping-projects', [
      change('project.json'), change('README.fr.md'), change('mappings.json'), change('source-concepts.csv'),
    ])
    expect(actions[0].files.map((f) => f.path)).toEqual([
      'project.json', 'README.fr.md', 'mappings.json', 'source-concepts.csv',
    ])
  })
})
