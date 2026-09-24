import { describe, expect, it } from 'vitest'
import { findPage, queryTerms, scorePage, searchDocs, snippet, type DocPage, type DocsIndex } from './docs'

const page = (over: Partial<DocPage>): DocPage => ({
  url: '/en/docs/x/', lang: 'en', title: 'X', section: 'S', description: '', text: '', ...over,
})

const index: DocsIndex = {
  generatedAt: '', baseUrl: 'https://linkr.interhop.org',
  pages: [
    page({ url: '/en/docs/concept-mapping/suggestions/', title: 'Suggestions', section: 'Concept mapping', text: 'Scores rank OMOP candidates for each source concept.' }),
    page({ url: '/en/docs/cohorts/', title: 'Cohorts', text: 'A cohort selects patients. Suggestions are not involved here.' }),
    page({ url: '/docs/concept-mapping/suggestions/', lang: 'fr', title: 'Suggestions', section: 'Alignement de concepts', text: 'Les scores classent les candidats OMOP.' }),
  ],
}

describe('queryTerms', () => {
  it('folds accents and case, drops one-letter words and repeats', () => {
    expect(queryTerms("Créer une cohorte à l'hôpital, cohorte")).toEqual(['creer', 'une', 'cohorte', 'hopital'])
  })
})

describe('scorePage / searchDocs', () => {
  it('ranks a title match over a passing mention, and pages holding every term first', () => {
    const results = searchDocs(index, 'suggestions scores', 'en', 5)
    expect(results.map((r) => r.page.url)).toEqual(['/en/docs/concept-mapping/suggestions/', '/en/docs/cohorts/'])
    expect(scorePage(index.pages[0], ['nothing'])).toBe(0)
  })

  it('filters by language, or not', () => {
    expect(searchDocs(index, 'suggestions', 'fr', 5).map((r) => r.page.lang)).toEqual(['fr'])
    expect(searchDocs(index, 'suggestions', 'any', 5)).toHaveLength(3)
  })
})

describe('snippet', () => {
  it('cuts around the first match', () => {
    const text = `${'a '.repeat(200)}the lactate criterion ${'b '.repeat(200)}`
    const s = snippet(text, ['lactate'], 20)
    expect(s).toMatch(/^….*lactate.*…$/)
    expect(s.length).toBeLessThan(50)
  })
})

describe('findPage', () => {
  it('accepts an absolute URL, a path, with or without the trailing slash', () => {
    expect(findPage(index, 'https://linkr.interhop.org/en/docs/cohorts')?.title).toBe('Cohorts')
    expect(findPage(index, 'docs/concept-mapping/suggestions/#scores')?.lang).toBe('fr')
    expect(findPage(index, '/nope/')).toBeUndefined()
  })
})
