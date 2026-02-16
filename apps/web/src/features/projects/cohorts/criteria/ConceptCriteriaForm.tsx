import { useTranslation } from 'react-i18next'

export function ConceptCriteriaForm() {
  const { t } = useTranslation()

  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center">
      <p className="text-xs text-muted-foreground">
        {t('cohorts.criteria_concept')}
      </p>
    </div>
  )
}
