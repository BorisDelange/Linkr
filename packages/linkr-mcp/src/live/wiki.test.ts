import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { getDefaultDimensions, type CatalogResultCache, type DataCatalog } from '@/types/catalog'
import type { WikiPage } from '@/types'
import { registerWikiTools } from './tools-wiki'
import {
  breadcrumbs, catalogPatch, maskedCount, planMove, readmeIn, renderCatalogResults, renderWikiTree, subtreeIds,
  wikiSlug, withReadme,
} from './wiki'

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
  dimensions: getDefaultDimensions(), anonymization: { threshold: 10, mode: 'replace' },
  periodConfig: { granularity: 'month', serviceLevel: 'visit_detail' }, status: 'draft',
  categoryColumn: 'domain_id', createdAt: '', updatedAt: '',
})

describe('catalogPatch', () => {
  const cols = ['concept_class_id', 'domain_id']

  it('moves the admission-date dimension with the period table', () => {
    const off = catalogPatch(catalog(), { period: null }, cols)
    expect(off).toMatchObject({ patch: { periodConfig: null } })
    const dims = (off as { patch: { dimensions: DataCatalog['dimensions'] } }).patch.dimensions
    expect(dims.find((d) => d.type === 'admission_date')?.enabled).toBe(false)

    const yearly = catalogPatch(catalog(), { period: { granularity: 'year' } }, cols) as { patch: Record<string, never> }
    expect(yearly.patch.periodConfig).toEqual({ granularity: 'year', serviceLevel: 'visit_detail' })
    expect((yearly.patch.dimensions as DataCatalog['dimensions']).find((d) => d.type === 'admission_date')?.admissionDate).toEqual({ step: 'year' })
  })

  it('takes brackets or a preset, and refuses bad ones', () => {
    const p = catalogPatch(catalog(), { age_brackets: [65, 18, 18] }, cols) as { patch: { dimensions: DataCatalog['dimensions'] } }
    expect(p.patch.dimensions.find((d) => d.type === 'age_group')?.ageGroup?.brackets).toEqual([18, 65])
    expect(catalogPatch(catalog(), { age_brackets: '20y' }, cols)).not.toHaveProperty('error')
    expect(catalogPatch(catalog(), { age_brackets: 'weird' }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { age_brackets: [0] }, cols)).toHaveProperty('error')
  })

  it('keeps category and subcategory distinct, clears with null, checks names', () => {
    expect(catalogPatch(catalog(), { subcategory_column: 'domain_id' }, cols))
      .toEqual({ patch: { categoryColumn: null, subcategoryColumn: 'domain_id' } })
    expect(catalogPatch(catalog(), { category_column: null }, cols)).toEqual({ patch: { categoryColumn: null } })
    expect(catalogPatch(catalog(), { category_column: 'nope' }, cols)).toHaveProperty('error')
  })

  it('locks the period axis of a paused run, validates the threshold', () => {
    expect(catalogPatch({ ...catalog(), computedPeriods: 3 }, { period: null }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { anonymization_threshold: 0 }, cols)).toHaveProperty('error')
    expect(catalogPatch(catalog(), { anonymization_threshold: 5 }, cols))
      .toEqual({ patch: { anonymization: { threshold: 5, mode: 'replace' } } })
  })
})

describe('catalog results', () => {
  const cache: CatalogResultCache = {
    catalogId: 'c', computedAt: '2026-01-01', durationMs: 1,
    concepts: [
      { conceptId: 1, conceptName: 'Heart rate', category: 'Measurement', patientCount: 120, recordCount: 900, visitCount: 130 },
      { conceptId: 2, conceptName: 'Rare drug', category: 'Drug', patientCount: 3, recordCount: 4, visitCount: 3 },
    ],
    dimensions: [{ dimensionId: 'sex', dimensionType: 'sex', value: 'F', patientCount: 7, recordCount: 7, visitCount: 7 }],
    grandTotal: { totalPatients: 200, totalVisits: 300, totalRecords: 5000 },
    totalConcepts: 2, totalPatients: 200, totalVisits: 300,
  }

  it('masks counts below the threshold', () => {
    expect(maskedCount(9, 10)).toBe('< 10')
    expect(maskedCount(null, 10)).toBe('< 10')
    expect(maskedCount(10, 10)).toBe('10')
    const concepts = renderCatalogResults(cache, 10, 'concepts')
    expect(concepts).toContain('Rare drug · Drug · patients < 10')
    expect(concepts.indexOf('Heart rate')).toBeLessThan(concepts.indexOf('Rare drug'))
    expect(renderCatalogResults(cache, 10, 'dimensions')).toContain('sex = F · patients < 10')
  })

  it('filters concepts and summarizes', () => {
    expect(renderCatalogResults(cache, 10, 'concepts', { category: 'Drug' })).not.toContain('Heart rate')
    expect(renderCatalogResults(cache, 10, 'summary')).toContain('Measurement: 1')
    expect(renderCatalogResults(cache, 10, 'periods')).toContain('No period table')
  })
})

describe('registerWikiTools', () => {
  it('registers without schema errors', () => {
    expect(() => registerWikiTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
