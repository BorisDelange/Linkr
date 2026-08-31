import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
import { TruncatedText } from '@/components/ui/truncated-text'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useProjectSource } from '@/stores/data-source-store'

interface Props {
  projectUid: string
  dataSourceId?: string
}

/**
 * The database a patient board or a cohort reads, on its card.
 *
 * Shows what the entity will ACTUALLY query, fallback included — so a card whose
 * `dataSourceId` is unset (written before the field existed, or imported) still
 * names a database rather than showing nothing. The name is dimmed in that case:
 * it is where the entity lands today, not a choice anyone made, and it can move
 * when the project's links change.
 */
export function EntityDatabaseLine({ projectUid, dataSourceId }: Props) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const source = useProjectSource(projectUid, dataSourceId)

  const pinned = !!dataSourceId && source?.id === dataSourceId
  const label = source
    ? localized(source.name, language)
    : t('databases.no_linked_database')

  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Database size={12} className="shrink-0" />
      <TruncatedText
        text={label}
        readOnly
        className={`min-w-0 flex-1 ${pinned ? '' : 'italic opacity-70'}`}
      />
    </div>
  )
}
