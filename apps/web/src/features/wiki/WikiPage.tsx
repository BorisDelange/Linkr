import { useTranslation } from 'react-i18next'
import { BookOpen } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function WikiPage() {
  const { t } = useTranslation()
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">{t('wiki.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('wiki.description')}</p>
        <Card className="mt-6">
          <div className="flex flex-col items-center py-12">
            <BookOpen size={40} className="text-muted-foreground" />
            <div className="mt-4 flex items-center gap-2">
              <p className="text-sm font-medium text-foreground">{t('wiki.title')}</p>
              <Badge variant="secondary" className="text-[10px]">{t('wiki.coming_soon')}</Badge>
            </div>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">{t('wiki.coming_soon_description')}</p>
          </div>
        </Card>
      </div>
    </div>
  )
}
