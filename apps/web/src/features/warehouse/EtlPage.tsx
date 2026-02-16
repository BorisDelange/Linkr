import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function EtlPage() {
  const { t } = useTranslation()
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Card>
          <div className="flex flex-col items-center py-12">
            <Workflow size={40} className="text-muted-foreground" />
            <div className="mt-4 flex items-center gap-2">
              <p className="text-sm font-medium text-foreground">{t('app_warehouse.etl_title')}</p>
              <Badge variant="secondary" className="text-[10px]">{t('app_warehouse.coming_soon')}</Badge>
            </div>
            <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
              {t('app_warehouse.etl_description')}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
