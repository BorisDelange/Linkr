import type { CohortLevel, CriteriaConfig, CriteriaType } from '@/types'

/** The config a criterion starts with, when added or when its type is changed. */
export function defaultCriterionConfig(
  type: CriteriaType,
  context: { cohortLevel?: CohortLevel; visitDateRange?: { minDate: string; maxDate: string } } = {},
): CriteriaConfig {
  switch (type) {
    case 'age':
      return { ageReference: 'admission', min: undefined, max: undefined }
    case 'sex':
      return { values: [] }
    case 'death':
      return { isDead: true }
    case 'period':
      return context.visitDateRange
        ? { startDate: context.visitDateRange.minDate, endDate: context.visitDateRange.maxDate }
        : { startDate: undefined, endDate: undefined }
    case 'duration':
      return { durationLevel: 'visit', minDays: undefined, maxDays: undefined }
    case 'care_site':
      return { careSiteLevel: 'visit_detail', values: [] }
    case 'concept':
      return { eventTableLabel: '', conceptIds: [], conceptNames: {} }
    case 'text':
      return { description: '' }
    case 'id_list': {
      const level = context.cohortLevel
      return { idLevel: level && level !== 'event' ? level : 'patient', ids: [] }
    }
  }
}
