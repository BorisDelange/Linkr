import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { CatalogResultCache, DataCatalog } from '@/types/catalog'
import { DEFAULT_CONCEPT_CONFIG, defaultCatalogVariables } from '@/lib/data-catalog/config'
import type { WikiPage } from '@/types'
import { registerWikiTools } from './tools-wiki'
import {
  breadcrumbs, catalogPatch, describeCatalogConfig, maskedCount, planMove, readmeIn, renderCatalogResults, renderWikiTree,
  wikiSlug, withReadme,
} from './wiki'
import { subtreeIds } from './helpers'

const page = (id: string, parentId: string | null, sortOrder: number, title = id): WikiPage => ({
  id, parentId, sortOrder, workspaceId: 'ws', title: { en: title }, slug: id, content: { en: 'x' },
  createdAt: '', updatedAt: '',
})

// root ─┬─ a ── a1
//       └─ b
const pages = [page('b', null, 1), page('a', null, 0), page('a1', 'a', 0), page('c', 'gone', 0)]

describe('wiki tree', () => {
  it('slugs like the store', () => {
    expect(wikiSlug('Décès & cœur — 2024')).toBe('deces-coeur-2024')
    expect(wikiSlug('!!!')).toBe('page')
  })

  it('renders by sort order, children indented, orphans kept', () => {
    const tree = renderWikiTree(pages)
    expect(tree.split('\n').map((l) => l.split(' — ')[0])).toEqual(['- a', '  - a1', '- b', '- c'])
    expect(tree).toContain('orphan (parent gone missing)')
    expect(renderWikiTree(pages, 2)).toContain('2 more page(s) not shown')
  })

  it('collects a subtree deepest first and walks breadcrumbs', () => {
    expect(subtreeIds(pages, 'a')).toEqual(['a1', 'a'])
    expect(breadcrumbs(pages, 'a1')).toEqual(['a', 'a1'])
  })

  it('plans a move with renumbered siblings and refuses cycles', () => {
    expect(planMove(pages, 'b', null, 0)).toEqual({ updates: [{ id: 'b', sortOrder: 0 }, { id: 'a', sortOrder: 1 }] })
    expect(planMove(pages, 'b', 'a')).toEqual({ updates: [{ id: 'b', parentId: 'a', sortOrder: 1 }] })
    expect(planMove(pages, 'a', 'a1')).toHaveProperty('error')
    expect(planMove(pages, 'a', 'nope')).toHaveProperty('error')
  })
})

describe('readme', () => {
  it('reads with fallback and writes one language', () => {
    expect(readmeIn({ en: 'Hello', fr: '' }, 'fr')).toEqual({ text: 'Hello', languages: ['en'] })
    expect(readmeIn('legacy', 'fr').text).toBe('legacy')
    expect(withReadme({ en: 'Hello' }, 'fr', 'Bonjour')).toEqual({ en: 'Hello', fr: 'Bonjour' })
  })
})

const catalog = (): DataCatalog => ({
  id: 'c', workspaceId: 'ws', name: { en: 'C' }, description: {}, dataSourceId: 'd',
  variables: { ...defaultCatalogVariables(), concept: { ...DEFAULT_CONCEPT_CONFIG, enabled: true, categoryColumn: 'domain_id' } },
  crossings: [['period'], ['age'], ['age', 'sex']],
  anonymization: { threshold: 10, mode: 'replace' }, status: 'draft', createdAt: '', updatedAt: '',
})

type Patched = { patch: Record<string, never> }

describe('catalogPatch', () => {
  const cols = ['concept_class_id', 'domain_id']

  it('changes one setting of a variable and keeps the others', () => {
    const p = catalogPatch(catalog(), { period_granularity: 'month', period_step: 3 }, cols) as Patched
    expect((p.patch.variables as DataCatalog['variables']).period).toEqual({ enabled: true, granularity: 'month', step: 3 })
    expect((p.patch.variables as DataCatalog['variables']).age).toEqual(catalog().variables.age)
    expect(catalogPatch(catalog(), { period_step: 0 }, cols)).toHaveProperty('error')
  })

  it('takes brackets or a preset, and refuses bad ones', () => {
    const p = catalogPatch(catalog(), { age_brackets: [65, 18, 18] }, cols) as Patched
    expect((p.patch.variables as DataCatalog['variables']).age?.brackets).toEqual([18, 65])
    expect(catalogPatch(catalog(), { age_brackets: '20y' }, cols)).not.toHaveProperty('error')
    expect(catalogPatch(catalog(), { age_brackets: 'weird' }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { age_brackets: [0] }, cols)).toHaveProperty('error')
  })

  it('keeps category and subcategory distinct, checks names, needs a column to count categories', () => {
    const p = catalogPatch(catalog(), { subcategory_column: 'domain_id' }, cols) as Patched
    const concept = (p.patch.variables as DataCatalog['variables']).concept!
    expect(concept.subcategoryColumn).toBe('domain_id')
    expect(concept.categoryColumn).toBeUndefined()
    expect(catalogPatch(catalog(), { category_column: 'nope' }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { category_column: null, concept_level: 'category' }, cols)).toHaveProperty('error')
  })

  it('stores crossings in canonical order, once each, 1 to 3 known variables', () => {
    expect(catalogPatch(catalog(), { crossings: [['sex', 'age'], ['age', 'sex'], ['period']] }, cols))
      .toEqual({ patch: { crossings: [['age', 'sex'], ['period']] } })
    expect(catalogPatch(catalog(), { crossings: [['age', 'weight']] }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { crossings: [['concept', 'period', 'age', 'sex']] }, cols)).toHaveProperty('error')
  })

  it('sets what cells count', () => {
    expect(catalogPatch(catalog(), { count_unit_stays: true }, cols))
      .toEqual({ patch: { counts: { visits: true, unitStays: true } } })
    expect(catalogPatch(catalog(), { count_stays: true }, cols)).toEqual({ patch: {} })
  })

  it('locks what a paused run counts, not its anonymization; validates the threshold', () => {
    expect(catalogPatch({ ...catalog(), computedSteps: 3 }, { sex_enabled: false }, cols)).toHaveProperty('error')
    expect(catalogPatch({ ...catalog(), computedSteps: 3 }, { anonymization_threshold: 5 }, cols)).not.toHaveProperty('error')
    expect(catalogPatch(catalog(), { anonymization_threshold: 0 }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { anonymization_threshold: 5 }, cols))
      .toEqual({ patch: { anonymization: { threshold: 5, mode: 'replace' } } })
  })

  it('describes the configuration', () => {
    const lines = describeCatalogConfig(catalog()).join('\n')
    expect(lines).toContain('age [10, 20, 30, 40, 50, 60, 70, 80, 90]')
    expect(lines).toContain('Published alone: period, age')
    expect(lines).toContain('Counts: patients, hospital stays')
  })
})

describe('catalog results', () => {
  const cache: CatalogResultCache = {
    catalogId: 'c', computedAt: '2026-01-01', durationMs: 1,
    concepts: [
      { conceptId: 1, conceptName: 'Heart rate', category: 'Measurement', patientCount: 120, recordCount: 900, visitCount: 130 },
      { conceptId: 2, conceptName: 'Rare drug', category: 'Drug', patientCount: 3, recordCount: 4, visitCount: 3 },
    ],
    crossings: [
      { id: 'age', variables: ['age'], rows: [{ values: ['[0;18['], patients: 40, stays: 50 }, { values: ['[18;+∞['], patients: 160, stays: 250 }] },
      { id: 'age-sex', variables: ['age', 'sex'], rows: [
        { values: ['[0;18[', 'male'], patients: 36, stays: 45 }, { values: ['[0;18[', 'female'], patients: 4, stays: 5 },
        { values: ['[18;+∞[', 'male'], patients: 80, stays: 120 }, { values: ['[18;+∞[', 'female'], patients: 80, stays: 130 },
      ] },
    ],
    modalities: { age: ['[0;18[', '[18;+∞['], sex: ['male', 'female'] },
    grandTotal: { totalPatients: 200, totalVisits: 300, totalRecords: 5000 },
    totalConcepts: 2, totalPatients: 200, totalVisits: 300,
  }
  const cat = { ...catalog(), variables: { ...catalog().variables, age: { enabled: true, brackets: [18] } }, crossings: [['age'], ['age', 'sex']] as DataCatalog['crossings'] }

  it('masks counts below the threshold', () => {
    expect(maskedCount(9, 10)).toBe('< 10')
    expect(maskedCount(null, 10)).toBe('< 10')
    expect(maskedCount(10, 10)).toBe('10')
    const concepts = renderCatalogResults(cat, cache, 'concepts')
    expect(concepts).toContain('Rare drug · Drug · patients < 10')
    expect(concepts.indexOf('Heart rate')).toBeLessThan(concepts.indexOf('Rare drug'))
  })

  it('leaves small concepts out in suppress mode', () => {
    expect(renderCatalogResults({ ...cat, anonymization: { threshold: 10, mode: 'suppress' } }, cache, 'concepts')).not.toContain('Rare drug')
  })

  it('masks a crossing like the page: the small cell and the one that would give it away', () => {
    const cells = renderCatalogResults(cat, cache, 'crossing', { crossing: 'age-sex' })
    expect(cells).toContain('Age group 0–17 × Gender Female: < 10')
    expect(cells).toContain('Age group 0–17 × Gender Male: masked')
    expect(cells).toContain('Age group 18+ × Gender Male: patients 80 · stays 120')
    expect(cells).not.toContain('36')
    expect(renderCatalogResults(cat, cache, 'crossing', { crossing: 'nope' })).toContain('Give crossing, one of: age, age-sex')
  })

  it('filters concepts and summarizes', () => {
    expect(renderCatalogResults(cat, cache, 'concepts', { category: 'Drug' })).not.toContain('Heart rate')
    const summary = renderCatalogResults(cat, cache, 'summary')
    expect(summary).toContain('Measurement: 1')
    expect(summary).toContain('age-sex (age × sex) — 4 cell(s), 2 masked')
  })
})

describe('registerWikiTools', () => {
  it('registers without schema errors', () => {
    expect(() => registerWikiTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
