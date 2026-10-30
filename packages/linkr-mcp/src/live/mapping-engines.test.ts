import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import type { EmbeddingConfig, SuggestionEngines } from '@/lib/api/suggestion-engines'
import { describeEngines, describeMatch, pickConfig } from './mapping-engines'
import { registerMappingEngineTools } from './tools-mapping-engines'

const config = (over: Partial<EmbeddingConfig>): EmbeddingConfig => ({
  id: 'c1', name: 'BioLORD', slug: 'biolord', modelId: 'm1', template: 'name_class',
  filters: { onlyStandard: true, onlyValid: true, domains: ['Measurement'], vocabularies: [] },
  device: 'auto', batchSize: 256, method: 'semantic/biolord',
  index: [{ vocabularyId: 'LOINC', status: 'built', count: 10, builtAt: null }], jobId: null, ...over,
})

const engines = (configs: EmbeddingConfig[]): SuggestionEngines => ({
  runtime: { installed: true, probe: { torch: '2.5', sentenceTransformers: '3.3', devices: ['cpu'], gpu: null }, jobId: null, torchBackend: 'auto' },
  models: [{ id: 'm1', name: 'BioLORD-2023-M', source: 'huggingface', repoId: 'FremyCompany/BioLORD-2023-M', ready: true, jobId: null }],
  configs,
  vocabularies: ['LOINC'],
  conceptClasses: [],
  defaultModel: { repoId: 'FremyCompany/BioLORD-2023-M' },
  setupJobId: null,
})

describe('pickConfig', () => {
  it('takes the only configuration with an index when none is named', () => {
    const unbuilt = config({ id: 'c2', slug: 'sapbert', method: 'semantic/sapbert', index: [{ vocabularyId: 'LOINC', status: 'missing', count: null, builtAt: null }] })
    expect(pickConfig(engines([config({}), unbuilt]))).toMatchObject({ id: 'c1' })
  })

  it('asks which one when several have an index', () => {
    const other = config({ id: 'c2', slug: 'sapbert', method: 'semantic/sapbert' })
    expect(pickConfig(engines([config({}), other]))).toMatch(/give config/)
  })

  it('names a configuration by id, slug or method', () => {
    const e = engines([config({})])
    for (const name of ['c1', 'biolord', 'semantic/biolord']) expect(pickConfig(e, name)).toMatchObject({ id: 'c1' })
    expect(pickConfig(e, 'nope')).toMatch(/Known: biolord/)
  })

  it('says how to set one up when there is none', () => {
    expect(pickConfig(engines([]))).toMatch(/one click/)
  })
})

describe('describe', () => {
  it('lists the index state per configuration', () => {
    const stale = config({ index: [
      { vocabularyId: 'LOINC', status: 'built', count: 10, builtAt: null },
      { vocabularyId: 'SNOMED', status: 'stale', count: 5, builtAt: null },
    ] })
    const out = describeEngines(engines([stale]))
    expect(out).toContain('biolord → semantic/biolord')
    expect(out).toContain('Index 1/2 vocabularies built, out of date: SNOMED')
  })

  it('names the concept classes a configuration is limited to', () => {
    const drugs = config({ filters: {
      onlyStandard: true, onlyValid: true, domains: ['Drug'], vocabularies: [], conceptClasses: ['Clinical Drug', 'Ingredient'],
    } })
    expect(describeEngines(engines([drugs]))).toContain('standard, valid, Drug, Clinical Drug/Ingredient.')
  })

  it('formats a semantic match', () => {
    expect(describeMatch({ conceptId: 3027018, score: 0.91234, conceptName: 'Heart rate', vocabularyId: 'LOINC', conceptCode: '8867-4', domainId: 'Measurement', standardConcept: 'S' }))
      .toBe('3027018 — Heart rate [LOINC 8867-4] (Measurement, standard) — similarity 0.912')
  })

  it('registers its tools', () => {
    expect(() => registerMappingEngineTools(new McpServer({ name: 't', version: '0' }))).not.toThrow()
  })
})
