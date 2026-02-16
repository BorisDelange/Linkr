import { useTranslation } from 'react-i18next'
import { Table2 } from 'lucide-react'
import { Card } from '@/components/ui/card'

export function DatasetsPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('datasets.title')}
        </h1>
        <Card className="mt-6">
          <div className="flex flex-col items-center py-12">
            <Table2 size={40} className="text-muted-foreground" />
            <p className="mt-4 text-sm font-medium text-foreground">
              {t('datasets.coming_soon')}
            </p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
              {t('datasets.coming_soon_description')}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
