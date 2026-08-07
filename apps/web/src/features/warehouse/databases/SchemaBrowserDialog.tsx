import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SchemaBrowser } from './SchemaBrowser'

/**
 * Modal wrapper around the shared {@link SchemaBrowser}. Rendered very wide so
 * the three regions (tables / columns / distribution) all have room to breathe.
 */
export function SchemaBrowserDialog({
  open,
  onOpenChange,
  dataSourceId,
  tableQualifier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  dataSourceId: string
  /** Forwarded to SchemaBrowser — see its `tableQualifier` prop. */
  tableQualifier?: string
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] max-w-[92vw] flex-col gap-0 p-0 sm:max-w-[92vw]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t('etl.browse_schema')}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <SchemaBrowser dataSourceId={dataSourceId} tableQualifier={tableQualifier} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
