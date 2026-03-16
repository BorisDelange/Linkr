import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useWorkspaceVersioningStore } from '@/stores/workspace-versioning-store'

export function WsExportTab() {
  const { t } = useTranslation()
  const { wsUid } = useParams<{ wsUid: string }>()
  const { exportZip, loading } = useWorkspaceVersioningStore()
  const [exporting, setExporting] = useState(false)
  const [includeData, setIncludeData] = useState(false)

  const handleExport = async () => {
    if (!wsUid) return
    setExporting(true)
    try {
      await exportZip(wsUid, { includeDataFiles: includeData })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
        <CardDescription>{t('app_versioning.export_description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="ws-include-data"
            checked={includeData}
            onCheckedChange={(v) => setIncludeData(v === true)}
          />
          <Label htmlFor="ws-include-data" className="text-sm font-normal cursor-pointer">
            {t('versioning.export_include_data')}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('versioning.export_include_data_hint')}
        </p>
        <Button size="sm" onClick={handleExport} disabled={exporting || loading} className="gap-1.5">
          <Download size={14} />
          {t('versioning.export_download')}
        </Button>
      </CardContent>
    </Card>
  )
}
