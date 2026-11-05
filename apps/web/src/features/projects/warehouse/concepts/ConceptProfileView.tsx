import { useTranslation } from 'react-i18next'
import { SectionRenderer, extractSections } from '@/features/warehouse/concept-mapping/components/ConceptDetailView'
import { DEFAULT_PROFILE_OPTIONS } from '@/lib/concept-mapping/concept-profile'
import { SECTION_KEYS, exactOptions, filterProfile, sectionSet, type StoredProfile } from '@/lib/concept-profiles/profile-store'

/** Everything the store holds: the database's own view has no threshold. */
const SHOW_ALL = exactOptions(DEFAULT_PROFILE_OPTIONS, sectionSet(SECTION_KEYS))

/**
 * A concept's stored profile, drawn as a mapping project draws its source
 * concepts' (the same sections), exact.
 */
export function ConceptProfileView({ profile }: { profile: StoredProfile }) {
  const { t, i18n } = useTranslation()
  // The heading already names the concept and its dictionary.
  const { full_name: _name, data_source: _source, ...info } = filterProfile(profile, SHOW_ALL).json ?? {}
  const sections = extractSections(info, t, {
    record_count: profile.rowsCount,
    ...(profile.patientsCount != null ? { patient_count: profile.patientsCount } : {}),
  })
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium">{t('concepts.profiles_title')}</h4>
        <span className="text-[10px] text-muted-foreground">
          {t('concepts.profile_computed', {
            date: new Date(profile.computedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        </span>
      </div>
      {sections.map((section, i) => <SectionRenderer key={i} section={section} />)}
    </div>
  )
}
