import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { SectionLabel } from '@/components/ui/section-label'
import { localized } from '@/lib/localized'
import { effectiveMappingStatus } from '@/lib/concept-mapping/mapping-status'
import { summarizeExternalMappings } from '@/lib/concept-mapping/external-mappings'
import { useConceptMappingStore, type ExternalMappingInfo } from '@/stores/concept-mapping-store'

/** Hover preview of a blue dot: which other projects aligned this source concept, and onto what. */
export function ExternalMappingsTip({ list, canImport }: { list: ExternalMappingInfo[]; canImport: boolean }) {
  const { t, i18n } = useTranslation()
  const mappingProjects = useConceptMappingStore((s) => s.mappingProjects)
  const summary = useMemo(() => summarizeExternalMappings(list), [list])

  const projectName = (id: string, fallback: string) => {
    const project = mappingProjects.find((p) => p.id === id)
    return (project && localized(project.name, i18n.language)) || fallback
  }

  return (
    <div className="max-w-xs space-y-2">
      <SectionLabel as="p" className="font-semibold tracking-wide text-background/70">
        {t('concept_mapping.status_tip_aligned_in_projects', { count: summary.projectCount })}
      </SectionLabel>
      {summary.projects.map((group) => (
        <div key={group.projectId} className="space-y-1">
          <p className="truncate text-xs font-semibold">{projectName(group.projectId, group.projectName)}</p>
          {group.mappings.map((m) => (
            <div key={m.id} className="min-w-0 border-l-2 border-background/30 pl-2">
              <p className="truncate text-xs">→ {m.targetConceptName || `#${m.targetConceptId}`}</p>
              <p className="truncate text-[10px] opacity-70">
                {[
                  m.targetVocabularyId,
                  m.targetConceptId,
                  m.equivalence?.replace('skos:', ''),
                  t(`concept_mapping.status_${effectiveMappingStatus(m)}`),
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
          ))}
          {group.hiddenMappings > 0 && (
            <p className="pl-2 text-[10px] italic opacity-70">
              {t('concept_mapping.status_tip_more_alignments', { count: group.hiddenMappings })}
            </p>
          )}
        </div>
      ))}
      {summary.hiddenProjects > 0 && (
        <p className="text-[10px] italic opacity-70">
          {t('concept_mapping.status_tip_more_projects', { count: summary.hiddenProjects })}
        </p>
      )}
      <p className="text-[10px] opacity-70">
        {t(canImport ? 'concept_mapping.status_tip_click_to_import' : 'concept_mapping.status_tip_click_for_list')}
      </p>
    </div>
  )
}
