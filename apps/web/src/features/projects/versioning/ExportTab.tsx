import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { useVersioningStore } from '@/stores/versioning-store'

export function ExportTab() {
  const { t } = useTranslation()
  const { exportZip } = useVersioningStore()
  const [includeData, setIncludeData] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('versioning.export_title')}</CardTitle>
        <CardDescription>{t('versioning.export_description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-data"
            checked={includeData}
            onCheckedChange={(v) => setIncludeData(v === true)}
          />
          <Label htmlFor="include-data" className="text-sm font-normal cursor-pointer">
            {t('versioning.export_include_data')}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('versioning.export_include_data_hint')}
        </p>
        <Button size="sm" onClick={() => exportZip({ includeDataFiles: includeData })} className="gap-1.5">
          <Download size={14} />
          {t('versioning.export_download')}
        </Button>
      </CardContent>
    </Card>
  )
}
