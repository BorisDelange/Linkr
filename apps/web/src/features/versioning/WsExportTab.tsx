import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

  const handleExport = async () => {
    if (!wsUid) return
    setExporting(true)
    try {
      await exportZip(wsUid)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      {/* Export */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
          <CardDescription>{t('app_versioning.export_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={handleExport} disabled={exporting || loading} className="gap-1.5">
            <Download size={14} />
            {t('versioning.export_download')}
          </Button>
        </CardContent>
      </Card>
    </>
  )
}
