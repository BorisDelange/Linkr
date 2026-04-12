import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onExport: (options: { includeDataFiles: boolean }) => void
}

export function ExportDialog({ open, onOpenChange, onExport }: ExportDialogProps) {
  const { t } = useTranslation()
  const [includeData, setIncludeData] = useState(false)

  const handleExport = () => {
    onExport({ includeDataFiles: includeData })
    onOpenChange(false)
    setIncludeData(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setIncludeData(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('versioning.export_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('versioning.export_description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="export-include-data"
              checked={includeData}
              onCheckedChange={(v) => setIncludeData(v === true)}
            />
            <Label htmlFor="export-include-data" className="text-sm font-normal cursor-pointer">
              {t('versioning.export_include_data')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('versioning.export_include_data_hint')}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <Button onClick={handleExport} className="gap-1.5">
            <Download size={14} />
            {t('versioning.export_download')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
