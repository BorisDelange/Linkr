import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
import type { PluginConfigField } from '@/types/plugin'

interface ConceptSelectFieldProps {
  field: PluginConfigField
  /** How many concepts are currently picked. */
  conceptCount: number
  onOpenPicker: () => void
}

/** The concepts field of a patient widget's config: a button that opens the picker. */
export function ConceptSelectField({ field, conceptCount, onOpenPicker }: ConceptSelectFieldProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  return (
    <FormField
      label={field.label[lang] ?? field.label.en}
      hint={field.description ? (field.description[lang] ?? field.description.en) : undefined}
    >
      {() => (
        <Button
          size="sm-tight"
          className="w-full justify-start .5"
          onClick={onOpenPicker}
        >
          <ListChecks size={13} />
          {conceptCount > 0
            ? t('patient_data.concepts_selected', { count: conceptCount })
            : t('patient_data.select_concepts')}
        </Button>
      )}
    </FormField>
  )
}
