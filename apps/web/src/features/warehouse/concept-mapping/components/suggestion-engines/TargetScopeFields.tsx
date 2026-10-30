import { useTranslation } from 'react-i18next'
import { FormField } from '@/components/ui/form-field'
import { MultiSelectFilter, MULTI_SELECT_FORM_TRIGGER } from '@/components/ui/multi-select-filter'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { TargetFilters } from '@/lib/api/suggestion-engines'

/** The OMOP domains a mapping target usually belongs to. */
const OMOP_DOMAINS = [
  'Condition', 'Device', 'Drug', 'Measurement', 'Meas Value', 'Observation', 'Procedure', 'Specimen',
  'Unit', 'Route', 'Visit', 'Spec Anatomic Site', 'Gender', 'Race', 'Ethnicity',
]

/** Which OMOP concepts are candidate targets: standard / valid, domains, vocabularies, concept classes. */
export function TargetScopeFields({
  value,
  onChange,
  vocabularies,
  conceptClasses,
  allLabel,
}: {
  value: TargetFilters
  onChange: (next: TargetFilters) => void
  vocabularies: string[]
  conceptClasses: string[]
  /** What an empty domain, vocabulary or class list means here. */
  allLabel: string
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2">
          <Switch id="scope-standard" size="sm" checked={value.onlyStandard} onCheckedChange={(v) => onChange({ ...value, onlyStandard: v })} />
          <Label htmlFor="scope-standard">{t('concept_mapping.engines_only_standard')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="scope-valid" size="sm" checked={value.onlyValid} onCheckedChange={(v) => onChange({ ...value, onlyValid: v })} />
          <Label htmlFor="scope-valid">{t('concept_mapping.engines_only_valid')}</Label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('concept_mapping.engines_domains')}>
          {() => (
            <MultiSelectFilter
              value={value.domains}
              options={OMOP_DOMAINS}
              placeholder={allLabel}
              onChange={(domains) => onChange({ ...value, domains })}
              triggerClass={MULTI_SELECT_FORM_TRIGGER}
              showChevron
              popoverWidthClass="w-64"
            />
          )}
        </FormField>
        <FormField label={t('concept_mapping.engines_vocabularies')}>
          {() => (
            <MultiSelectFilter
              value={value.vocabularies}
              options={vocabularies}
              placeholder={allLabel}
              onChange={(v) => onChange({ ...value, vocabularies: v })}
              triggerClass={MULTI_SELECT_FORM_TRIGGER}
              showChevron
              popoverWidthClass="w-64"
            />
          )}
        </FormField>
      </div>
      <FormField label={t('concept_mapping.engines_concept_classes')} hint={t('concept_mapping.engines_concept_classes_hint')} hintInTooltip>
        {() => (
          <MultiSelectFilter
            value={value.conceptClasses ?? []}
            options={conceptClasses}
            placeholder={allLabel}
            onChange={(c) => onChange({ ...value, conceptClasses: c })}
            triggerClass={MULTI_SELECT_FORM_TRIGGER}
            showChevron
            popoverWidthClass="w-72"
          />
        )}
      </FormField>
    </div>
  )
}
