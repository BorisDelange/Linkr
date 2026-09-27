import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cleanIdList } from '@/lib/duckdb/cohort-query'
import { classRelation } from '@/lib/schema-classes/relations'
import type { IdListCriteriaConfig, IdListLevel, SchemaMapping } from '@/types'

interface IdListCriteriaFormProps {
  config: IdListCriteriaConfig
  onChange: (config: IdListCriteriaConfig) => void
  schemaMapping?: SchemaMapping
}

const ID_LEVELS: IdListLevel[] = ['patient', 'visit', 'visit_detail']

/** Splits pasted text — a spreadsheet column, a comma list — into ids. */
function parseIdList(text: string): string[] {
  return cleanIdList(text.split(/[\s,;]+/).map((v) => v.replace(/^["']|["']$/g, '')))
}

export function IdListCriteriaForm({ config, onChange, schemaMapping }: IdListCriteriaFormProps) {
  const { t } = useTranslation()
  const level = config.idLevel ?? 'patient'
  const ids = cleanIdList(config.ids)
  // Edited as free text and parsed on blur: parsing on each keystroke would eat
  // the separator being typed.
  const [draft, setDraft] = useState(() => ids.join('\n'))
  const draftIds = parseIdList(draft)
  const levelMissing = !!schemaMapping && !classRelation(schemaMapping, level)

  const commit = () => {
    if (draftIds.join('\n') !== ids.join('\n')) onChange({ ...config, ids: draftIds })
  }

  return (
    <div className="space-y-2">
      <FormField label={t('cohorts.id_list_level')}>
        {() => (
          <Select value={level} onValueChange={(v) => onChange({ ...config, idLevel: v as IdListLevel })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ID_LEVELS.map((l) => (
                <SelectItem key={l} value={l} className="text-xs">
                  {t(`cohorts.level_${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      {levelMissing && <p className="text-xs text-destructive">{t('cohorts.id_list_level_missing')}</p>}
      <FormField label={t('cohorts.id_list_ids')}>
        {({ id }) => (
          <Textarea
            id={id}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            placeholder={t('cohorts.id_list_placeholder')}
            className="max-h-48 font-mono text-xs"
            spellCheck={false}
          />
        )}
      </FormField>
      <p className="text-[10px] text-muted-foreground">{t('cohorts.id_list_count', { count: draftIds.length })}</p>
    </div>
  )
}
