import type { StudyProtocol } from '@/types'
import type { TFunction } from 'i18next'

export function createDefaultProtocol(): StudyProtocol {
  return {
    inclusionCriteria: [],
    nonInclusionCriteria: [],
    exclusionCriteria: [],
    variables: [],
    timelinePhases: [],
    references: [],
    customSections: [],
  }
}

export function protocolToMarkdown(protocol: StudyProtocol, t: TFunction, language: string): string {
  const lines: string[] = []
  const h2 = (key: string) => `## ${t(key)}`

  // Scientific Context
  if (protocol.scientificContext) {
    lines.push(h2('protocol.section_scientific_context'), '', protocol.scientificContext, '')
  }

  // Objectives
  if (protocol.primaryObjective || (protocol.secondaryObjectives?.length ?? 0) > 0 || protocol.hypotheses) {
    lines.push(h2('protocol.section_objectives'), '')
    if (protocol.primaryObjective) {
      lines.push(`### ${t('protocol.primary_objective')}`, '', protocol.primaryObjective, '')
    }
    if (protocol.secondaryObjectives && protocol.secondaryObjectives.length > 0) {
      lines.push(`### ${t('protocol.secondary_objectives')}`, '')
      protocol.secondaryObjectives.forEach((o, i) => lines.push(`${i + 1}. ${o}`))
      lines.push('')
    }
    if (protocol.hypotheses) {
      lines.push(`### ${t('protocol.hypotheses')}`, '', protocol.hypotheses, '')
    }
  }

  // Study Design
  if (protocol.studyType || protocol.dataSources) {
    lines.push(h2('protocol.section_study_design'), '')
    if (protocol.studyType) {
      const typeKey = protocol.studyType === 'other'
        ? protocol.studyTypeOther ?? t('protocol.study_type_other')
        : t(`protocol.study_type_${protocol.studyType}`)
      lines.push(`- **${t('protocol.study_type')}**: ${typeKey}`)
    }
    if (protocol.isMulticentric !== undefined) {
      lines.push(`- **${t('protocol.multicentric')}**: ${protocol.isMulticentric ? '✓' : '✗'}`)
    }
    if (protocol.studyPeriodStart || protocol.studyPeriodEnd) {
      lines.push(`- **${t('protocol.study_period')}**: ${protocol.studyPeriodStart ?? '?'} — ${protocol.studyPeriodEnd ?? '?'}`)
    }
    lines.push('')
    if (protocol.dataSources) {
      lines.push(`### ${t('protocol.data_sources_description')}`, '', protocol.dataSources, '')
    }
  }

  // Population
  const totalCriteria = protocol.inclusionCriteria.length + protocol.nonInclusionCriteria.length + protocol.exclusionCriteria.length
  if (totalCriteria > 0) {
    lines.push(h2('protocol.section_population'), '')
    const renderCriteria = (title: string, criteria: typeof protocol.inclusionCriteria) => {
      if (criteria.length === 0) return
      lines.push(`### ${title}`, '')
      criteria.sort((a, b) => a.order - b.order).forEach((c, i) => lines.push(`${i + 1}. ${c.text}`))
      lines.push('')
    }
    renderCriteria(t('protocol.inclusion_criteria'), protocol.inclusionCriteria)
    renderCriteria(t('protocol.non_inclusion_criteria'), protocol.nonInclusionCriteria)
    renderCriteria(t('protocol.exclusion_criteria'), protocol.exclusionCriteria)
  }

  // Variables
  if (protocol.variables.length > 0) {
    lines.push(h2('protocol.section_variables'), '')
    lines.push(`| ${t('protocol.variable_name')} | ${t('protocol.variable_role')} | ${t('protocol.temporal_anchor')} | ${t('protocol.time_window')} | ${t('protocol.aggregate_function')} | ${t('protocol.variable_data_type')} |`)
    lines.push('| --- | --- | --- | --- | --- | --- |')
    protocol.variables.sort((a, b) => a.order - b.order).forEach((v) => {
      const name = v.name[language] ?? Object.values(v.name)[0] ?? ''
      const concept = v.conceptSource === 'concept_set' ? v.conceptSetId ?? '' : v.customConceptName ?? ''
      const label = name || concept
      const role = t(`protocol.role_${v.role}`)
      const tw = `${v.timeWindow.start} → ${v.timeWindow.end}`
      const agg = t(`protocol.agg_${v.aggregateFunction}`)
      const dtype = v.dataType ? t(`protocol.dtype_${v.dataType}`) : ''
      lines.push(`| ${label}${v.unit ? ` (${v.unit})` : ''} | ${role} | ${v.temporalAnchor} | ${tw} | ${agg} | ${dtype} |`)
    })
    lines.push('')
  }

  // Statistical Analysis Plan
  const statFields: [string, string | undefined][] = [
    ['protocol.primary_analysis', protocol.primaryAnalysis],
    ['protocol.secondary_analyses', protocol.secondaryAnalyses],
    ['protocol.subgroup_analyses', protocol.subgroupAnalyses],
    ['protocol.missing_data', protocol.missingDataHandling],
    ['protocol.sample_size', protocol.sampleSizeCalculation],
  ]
  if (statFields.some(([, v]) => v)) {
    lines.push(h2('protocol.section_statistical_analysis'), '')
    statFields.forEach(([key, value]) => {
      if (value) lines.push(`### ${t(key)}`, '', value, '')
    })
  }

  // Ethics
  const ethicsFields: [string, string | undefined][] = [
    ['protocol.ethics_approval', protocol.ethicsApproval],
    ['protocol.consent', protocol.consent],
    ['protocol.data_protection', protocol.dataProtection],
    ['protocol.regulatory_references', protocol.regulatoryReferences],
  ]
  if (ethicsFields.some(([, v]) => v)) {
    lines.push(h2('protocol.section_ethics'), '')
    ethicsFields.forEach(([key, value]) => {
      if (value) lines.push(`### ${t(key)}`, '', value, '')
    })
  }

  // Timeline
  if (protocol.timelinePhases.length > 0) {
    lines.push(h2('protocol.section_timeline'), '')
    lines.push(`| ${t('protocol.phase_name')} | ${t('protocol.phase_start')} | ${t('protocol.phase_end')} | ${t('protocol.phase_description')} |`)
    lines.push('| --- | --- | --- | --- |')
    protocol.timelinePhases.sort((a, b) => a.order - b.order).forEach((p) => {
      lines.push(`| ${p.name} | ${p.startDate ?? ''} | ${p.endDate ?? ''} | ${p.description ?? ''} |`)
    })
    lines.push('')
  }

  // References
  if (protocol.references.length > 0) {
    lines.push(h2('protocol.section_references'), '')
    protocol.references.sort((a, b) => a.order - b.order).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.text}`)
    })
    lines.push('')
  }

  // Custom Sections
  protocol.customSections.sort((a, b) => a.order - b.order).forEach((s) => {
    const title = s.title[language] ?? Object.values(s.title)[0] ?? ''
    if (title || s.content) {
      lines.push(`## ${title}`, '', s.content, '')
    }
  })

  return lines.join('\n')
}
