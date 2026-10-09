import { describe, it, expect } from 'vitest'
import { summarizeExternalMappings, type ExternalMappingRef } from './external-mappings'
import type { ConceptMapping } from '@/types'

const ref = (projectId: string, projectName: string, targetConceptId: number): ExternalMappingRef => ({
  mapping: { id: `${projectId}-${targetConceptId}`, targetConceptId } as ConceptMapping,
  sourceProjectId: projectId,
  sourceProjectName: projectName,
})

describe('summarizeExternalMappings', () => {
  it('groups by project, busiest first then by name, keeping each project order', () => {
    const s = summarizeExternalMappings([
      ref('b', 'Beta', 1),
      ref('a', 'Alpha', 2),
      ref('c', 'Gamma', 3),
      ref('c', 'Gamma', 4),
    ])
    expect(s.projects.map((p) => p.projectName)).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(s.projects[0].mappings.map((m) => m.targetConceptId)).toEqual([3, 4])
    expect(s.projectCount).toBe(3)
    expect(s.mappingCount).toBe(4)
    expect(s.hiddenProjects).toBe(0)
  })

  it('caps projects and alignments per project, counting what it leaves out', () => {
    const list = [
      ref('a', 'A', 1), ref('a', 'A', 2), ref('a', 'A', 3), ref('a', 'A', 4),
      ref('b', 'B', 5), ref('c', 'C', 6),
    ]
    const s = summarizeExternalMappings(list, { maxProjects: 2, maxPerProject: 2 })
    expect(s.projects.map((p) => p.projectId)).toEqual(['a', 'b'])
    expect(s.projects[0].mappings).toHaveLength(2)
    expect(s.projects[0].hiddenMappings).toBe(2)
    expect(s.projects[1].hiddenMappings).toBe(0)
    expect(s.hiddenProjects).toBe(1)
    expect(s.projectCount).toBe(3)
  })

  it('returns an empty summary for no alignment', () => {
    expect(summarizeExternalMappings([])).toEqual({
      projects: [], hiddenProjects: 0, projectCount: 0, mappingCount: 0,
    })
  })
})
