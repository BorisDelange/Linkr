import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'

export function DataQualityPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('data_quality.title')}
        </h1>
        <Card className="mt-6">
          <div className="flex flex-col items-center py-12">
            <ShieldCheck size={40} className="text-muted-foreground" />
            <p className="mt-4 text-sm font-medium text-foreground">
              {t('data_quality.coming_soon')}
            </p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              {t('data_quality.coming_soon_description')}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
