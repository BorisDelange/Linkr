import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { PluginConfigField } from '@/types/plugin'

interface ConceptSelectFieldProps {
  field: PluginConfigField
  conceptCount: number
  onOpenPicker: () => void
}

/** The `concept-select` row of a patient widget's config: a solid primary button, because picking
 *  concepts is the one action that makes such a widget render anything at all. Shared by the add
 *  dialog and the editor sheet so both read identically. */
export function ConceptSelectField({ field, conceptCount, onOpenPicker }: ConceptSelectFieldProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'

  return (
    <div className="space-y-1.5">
      <Label>{field.label[lang] ?? field.label.en}</Label>
      {field.description && (
        <p className="text-[10px] text-muted-foreground">
          {field.description[lang] ?? field.description.en}
        </p>
      )}
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
    </div>
  )
}
