import type { ConceptMapping } from '@/types'

export interface ExternalMappingRef {
  mapping: ConceptMapping
  sourceProjectId: string
  sourceProjectName: string
}

export interface ExternalProjectGroup {
  projectId: string
  projectName: string
  mappings: ConceptMapping[]
  /** Mappings of this project left out by `maxPerProject`. */
  hiddenMappings: number
}

export interface ExternalMappingsSummary {
  projects: ExternalProjectGroup[]
  /** Projects left out by `maxProjects`. */
  hiddenProjects: number
  projectCount: number
  mappingCount: number
}

/**
 * Group the alignments other projects made for one source concept by project,
 * capped for a hover preview. Projects with the most alignments come first, then
 * by name; each project keeps its alignments in the order given.
 */
export function summarizeExternalMappings(
  list: readonly ExternalMappingRef[],
  { maxProjects = 4, maxPerProject = 3 }: { maxProjects?: number; maxPerProject?: number } = {},
): ExternalMappingsSummary {
  const byProject = new Map<string, { projectName: string; mappings: ConceptMapping[] }>()
  for (const info of list) {
    const group = byProject.get(info.sourceProjectId)
    if (group) group.mappings.push(info.mapping)
    else byProject.set(info.sourceProjectId, { projectName: info.sourceProjectName, mappings: [info.mapping] })
  }
  const groups = [...byProject.entries()]
    .map(([projectId, g]) => ({ projectId, ...g }))
    .sort((a, b) => b.mappings.length - a.mappings.length || a.projectName.localeCompare(b.projectName))
  const shown = groups.slice(0, Math.max(0, maxProjects))
  return {
    projects: shown.map((g) => ({
      projectId: g.projectId,
      projectName: g.projectName,
      mappings: g.mappings.slice(0, Math.max(0, maxPerProject)),
      hiddenMappings: Math.max(0, g.mappings.length - maxPerProject),
    })),
    hiddenProjects: groups.length - shown.length,
    projectCount: groups.length,
    mappingCount: list.length,
  }
}
