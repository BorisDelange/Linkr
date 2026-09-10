import { useTranslation } from 'react-i18next'
import { localized } from '@/lib/localized'
import type { DatasetColumn } from '@/types'

/**
 * What a column's identity tooltip shows: its storage name, label and description.
 *
 * The same three rows appear on the dataset table's header, in its column-visibility
 * menu and on a collected variable in the patient chart — so a reader who has learnt
 * to hover a column name gets the same answer wherever they do it.
 */
export function ColumnMetaTooltipContent({ column }: { column: DatasetColumn }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      <span className="text-muted-foreground">{t('datasets.col_meta_col_id')}</span>
      <span className="break-all font-mono">{column.name}</span>
      <span className="text-muted-foreground">{t('datasets.col_meta_label')}</span>
      <span className="break-words">{localized(column.label, lang) || '—'}</span>
      <span className="text-muted-foreground">{t('datasets.col_meta_description')}</span>
      <span className="break-words">{localized(column.description, lang) || '—'}</span>
    </div>
  )
}
