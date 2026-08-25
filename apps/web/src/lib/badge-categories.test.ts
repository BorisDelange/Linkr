import { describe, it, expect } from 'vitest'
import {
  addBadge,
  categoryOf,
  joinLabel,
  joinLocalizedLabel,
  renameCategoryInBadges,
  splitLabel,
  valueOf,
} from './badge-categories'
import type { BadgeCategory, ProjectBadge } from '@/types'

const EN = 'en'

const source: BadgeCategory = { id: 'c1', name: { en: 'Source' }, color: 'cyan', exclusive: true }
const domain: BadgeCategory = { id: 'c2', name: { en: 'Domain' }, color: 'violet', exclusive: false }
const categories = [source, domain]

const badge = (id: string, label: string): ProjectBadge => ({ id, label: { en: label }, color: 'blue' })

describe('splitLabel', () => {
  it('splits a scoped label', () => {
    expect(splitLabel('Source::MIMIC')).toEqual({ category: 'Source', value: 'MIMIC' })
  })

  it('leaves a plain label uncategorized', () => {
    expect(splitLabel('MIMIC')).toEqual({ category: null, value: 'MIMIC' })
  })

  it('splits on the first separator, so the value may contain one', () => {
    expect(splitLabel('Source::a::b')).toEqual({ category: 'Source', value: 'a::b' })
  })

  it('treats a leading separator as part of the label, not an empty category', () => {
    expect(splitLabel('::MIMIC')).toEqual({ category: null, value: '::MIMIC' })
  })

  it('treats a trailing separator as part of the label, not an empty value', () => {
    expect(splitLabel('Source::')).toEqual({ category: null, value: 'Source::' })
  })

  it('rejects a whitespace-only value', () => {
    expect(splitLabel('Source::   ')).toEqual({ category: null, value: 'Source::   ' })
  })
})

describe('categoryOf', () => {
  it('resolves a declared category', () => {
    expect(categoryOf(badge('b', 'Source::MIMIC'), categories, EN)?.id).toBe('c1')
  })

  it('matches the category name case-insensitively', () => {
    expect(categoryOf(badge('b', 'SOURCE::MIMIC'), categories, EN)?.id).toBe('c1')
  })

  it('returns undefined for a prefix naming no declared category', () => {
    // The badge keeps its label; it just isn't scoped. This is what a badge
    // looks like after its category was deleted.
    expect(categoryOf(badge('b', 'Ghost::MIMIC'), categories, EN)).toBeUndefined()
  })

  it('returns undefined for an unscoped badge', () => {
    expect(categoryOf(badge('b', 'MIMIC'), categories, EN)).toBeUndefined()
  })
})

describe('addBadge', () => {
  it('appends an uncategorized badge', () => {
    const out = addBadge([badge('a', 'urgent')], badge('b', 'wip'), categories, EN)
    expect(out.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('replaces the existing value of an exclusive category', () => {
    const out = addBadge([badge('a', 'Source::MIMIC')], badge('b', 'Source::eICU'), categories, EN)
    expect(out.map((b) => b.id)).toEqual(['b'])
  })

  it('keeps both values of a non-exclusive category', () => {
    const out = addBadge([badge('a', 'Domain::ICU')], badge('b', 'Domain::Cardio'), categories, EN)
    expect(out.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('leaves other categories alone when replacing an exclusive one', () => {
    const before = [badge('a', 'Source::MIMIC'), badge('b', 'Domain::ICU'), badge('c', 'urgent')]
    const out = addBadge(before, badge('d', 'Source::eICU'), categories, EN)
    expect(out.map((b) => b.id)).toEqual(['b', 'c', 'd'])
  })

  it('refuses an exact duplicate', () => {
    const before = [badge('a', 'Domain::ICU')]
    expect(addBadge(before, badge('b', 'Domain::ICU'), categories, EN)).toBe(before)
  })

  it('refuses a duplicate differing only in case', () => {
    const before = [badge('a', 'urgent')]
    expect(addBadge(before, badge('b', 'URGENT'), categories, EN)).toBe(before)
  })

  it('refuses an empty label', () => {
    const before = [badge('a', 'urgent')]
    expect(addBadge(before, badge('b', '   '), categories, EN)).toBe(before)
  })

  it('does not apply exclusivity to an undeclared prefix', () => {
    // 'Ghost' names no category, so these are two ordinary badges.
    const out = addBadge([badge('a', 'Ghost::x')], badge('b', 'Ghost::y'), categories, EN)
    expect(out.map((b) => b.id)).toEqual(['a', 'b'])
  })
})

describe('renameCategoryInBadges', () => {
  const dataset: BadgeCategory = { ...source, name: { en: 'Dataset' } }

  it('rewrites the prefix of the matching badges', () => {
    const badges = [badge('a', 'Source::MIMIC'), badge('b', 'Domain::ICU')]
    const out = renameCategoryInBadges(badges, source, dataset)
    expect(out[0].label).toEqual({ en: 'Dataset::MIMIC' })
    expect(out[1].label).toEqual({ en: 'Domain::ICU' })
  })

  it('matches the old name case-insensitively', () => {
    const out = renameCategoryInBadges([badge('a', 'SOURCE::MIMIC')], source, dataset)
    expect(out[0].label).toEqual({ en: 'Dataset::MIMIC' })
  })

  it('keeps a value that contains a separator', () => {
    const out = renameCategoryInBadges([badge('a', 'Source::a::b')], source, dataset)
    expect(out[0].label).toEqual({ en: 'Dataset::a::b' })
  })

  it('rewrites every language of the category, keeping each value', () => {
    const bilingual: BadgeCategory = { ...source, name: { en: 'Source', fr: 'Origine' } }
    const renamed: BadgeCategory = { ...source, name: { en: 'Dataset', fr: 'Jeu' } }
    const badges: ProjectBadge[] = [
      { id: 'a', label: { en: 'Source::MIMIC', fr: 'Origine::MIMIC-fr' }, color: 'blue' },
    ]
    expect(renameCategoryInBadges(badges, bilingual, renamed)[0].label).toEqual({
      en: 'Dataset::MIMIC',
      fr: 'Jeu::MIMIC-fr',
    })
  })

  it('adds a prefix in a language the badge did not carry', () => {
    const renamed: BadgeCategory = { ...source, name: { en: 'Dataset', fr: 'Jeu' } }
    expect(renameCategoryInBadges([badge('a', 'Source::MIMIC')], source, renamed)[0].label).toEqual({
      en: 'Dataset::MIMIC',
      fr: 'Jeu::MIMIC',
    })
  })

  it('leaves an unrelated language of the badge untouched', () => {
    const badges: ProjectBadge[] = [
      { id: 'a', label: { en: 'Source::MIMIC', fr: 'urgent' }, color: 'blue' },
    ]
    expect(renameCategoryInBadges(badges, source, dataset)[0].label).toEqual({
      en: 'Dataset::MIMIC',
      fr: 'urgent',
    })
  })

  it('rewrites a legacy plain-string label into a localized one', () => {
    const badges: ProjectBadge[] = [{ id: 'a', label: 'Source::MIMIC', color: 'blue' }]
    expect(renameCategoryInBadges(badges, source, dataset)[0].label).toEqual({ en: 'Dataset::MIMIC' })
  })
})

describe('joinLocalizedLabel', () => {
  const bilingual: BadgeCategory = { ...source, name: { en: 'Source', fr: 'Origine' } }

  it('prefixes the value in every language the category is named in', () => {
    expect(joinLocalizedLabel(bilingual, 'MIMIC')).toEqual({
      en: 'Source::MIMIC',
      fr: 'Origine::MIMIC',
    })
  })

  it('skips a language the category leaves blank', () => {
    const partial: BadgeCategory = { ...source, name: { en: 'Source', fr: '  ' } }
    expect(joinLocalizedLabel(partial, 'MIMIC')).toEqual({ en: 'Source::MIMIC' })
  })

  it('keeps a per-language value the badge already carries', () => {
    const existing = { en: 'Source::MIMIC', fr: 'Origine::MIMIC-fr' }
    expect(joinLocalizedLabel(bilingual, 'MIMIC', existing)).toEqual(existing)
  })
})

describe('categoryOf across languages', () => {
  const bilingual: BadgeCategory = { ...source, name: { en: 'Source EN', fr: 'Source FR' } }

  it('resolves a badge whose prefix is only in the other language', () => {
    // The reported bug: a badge added in FR read `Source FR::MIMIC` in EN too,
    // matched nothing, and rendered as raw text with a visible separator.
    const b: ProjectBadge = { id: 'a', label: { fr: 'Source FR::MIMIC' }, color: 'blue' }
    expect(categoryOf(b, [bilingual], 'en')?.id).toBe(bilingual.id)
    expect(valueOf(b, [bilingual], 'en')).toBe('MIMIC')
  })

  it('prefers the active language when both carry a prefix', () => {
    const b: ProjectBadge = {
      id: 'a',
      label: { en: 'Source EN::MIMIC', fr: 'Source FR::MIMIC-fr' },
      color: 'blue',
    }
    expect(valueOf(b, [bilingual], 'fr')).toBe('MIMIC-fr')
  })

  it('leaves an undeclared prefix uncategorized, label intact', () => {
    const b: ProjectBadge = { id: 'a', label: { en: 'Ghost::x' }, color: 'blue' }
    expect(categoryOf(b, [bilingual], 'en')).toBeUndefined()
    expect(valueOf(b, [bilingual], 'en')).toBe('Ghost::x')
  })
})

describe('joinLabel', () => {
  it('builds a scoped label', () => {
    expect(joinLabel('Source', 'MIMIC')).toBe('Source::MIMIC')
  })

  it('round-trips through splitLabel', () => {
    expect(splitLabel(joinLabel('Source', 'MIMIC'))).toEqual({ category: 'Source', value: 'MIMIC' })
  })
})
