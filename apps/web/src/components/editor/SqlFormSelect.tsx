import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** The two forms every generated query is shown in: on the linkr_* relations,
 *  the same on every mapped database, or on the source database's own tables. */
export type SqlForm = 'linkr' | 'native'

/** Picks the form a generated query is shown in, named alike everywhere. */
export function SqlFormSelect({
  value,
  onChange,
  nativeDisabled,
  disabled,
  showHint = true,
}: {
  value: SqlForm
  onChange: (form: SqlForm) => void
  /** The query has no form on the database's tables. */
  nativeDisabled?: boolean
  disabled?: boolean
  /** The chosen form's explanation, beside the select. */
  showHint?: boolean
}) {
  const { t } = useTranslation()
  const select = (
    <Select value={value} onValueChange={(v) => onChange(v as SqlForm)} disabled={disabled}>
      <SelectTrigger size="sm" className="h-6 w-52 shrink-0 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="linkr" className="text-xs">{t('common.sql_form_linkr')}</SelectItem>
        <SelectItem value="native" className="text-xs" disabled={nativeDisabled}>{t('common.sql_form_native')}</SelectItem>
      </SelectContent>
    </Select>
  )
  if (!showHint) return select
  return (
    <div className="flex min-w-0 items-center gap-2">
      {select}
      <p className="min-w-0 flex-1 text-[10px] text-muted-foreground">{t(`common.sql_form_${value}_hint`)}</p>
    </div>
  )
}
