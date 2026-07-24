import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useVersioningStore } from '@/stores/versioning-store'

export function ExportTab() {
  const { t } = useTranslation()
  const { exportZip } = useVersioningStore()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
        <CardDescription>{t('versioning.export_description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('versioning.export_data_hint')}
        </p>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => exportZip({})} className="gap-1.5">
            <Download size={14} />
            {t('versioning.export_download')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
