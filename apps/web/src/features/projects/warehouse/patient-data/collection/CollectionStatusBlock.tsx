import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientCollection } from './use-patient-collection'

interface Props {
  projectUid: string
  boardId: string | undefined
  personId: string | null
  visitId: string | null
  visitDetailId: string | null
}

/**
 * Where the patient's manual collection stands, at the foot of the patient
 * sidebar — beside age, sex and length of stay, because how much of a collection
 * is filled is patient context in the same way those are.
 *
 * Renders nothing when the board has no collection configured, so a board that
 * never collects is visually unchanged.
 */
export function CollectionStatusBlock({
  projectUid, boardId, personId, visitId, visitDetailId,
}: Props) {
  const { t } = useTranslation()
  const board = usePatientChartStore((s) => s.dashboards.find((d) => d.id === boardId))
  const config = board?.collection
  const { fields, filledCount, hasRow } = usePatientCollection(config, {
    personId, visitId, visitDetailId,
  })

  if (!config?.datasetFileId || !projectUid) return null

  const total = fields.length
  const complete = total > 0 && filledCount === total

  return (
    <div className="shrink-0 border-t px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ClipboardList size={10} className="text-muted-foreground" />
        <span>{t('patient_data.collection')}</span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t('patient_data.collection_status')}</span>
        <span
          className={cn(
            'font-medium',
            complete
              ? 'text-emerald-600 dark:text-emerald-400'
              : hasRow ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        >
          {complete
            ? t('patient_data.collection_complete')
            : hasRow
              ? t('patient_data.collection_partial')
              : t('patient_data.collection_empty')}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t('patient_data.collection_filled')}</span>
        <span className="font-medium tabular-nums">{filledCount} / {total}</span>
      </div>
    </div>
  )
}
