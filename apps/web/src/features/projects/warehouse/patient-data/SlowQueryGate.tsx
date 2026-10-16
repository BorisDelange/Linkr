import { useTranslation } from 'react-i18next'
import { Hourglass, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** In place of a widget whose queries the database cannot compute itself
 *  (use-slow-queries.ts): it loads only once asked. */
export function SlowQueryGate({ reason, onRun }: { reason: string | null; onRun: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <Hourglass size={20} className="text-muted-foreground" />
      <p className="text-sm font-medium">{t('patient_data.slow_query_title')}</p>
      <p className="max-w-md text-xs text-muted-foreground">{t('patient_data.slow_query_hint')}</p>
      {reason && <p className="max-w-md truncate font-mono text-[10px] text-muted-foreground" title={reason}>{reason}</p>}
      <Button size="sm" className="gap-1.5" onClick={onRun}>
        <Play size={14} />
        {t('patient_data.slow_query_run')}
      </Button>
    </div>
  )
}
