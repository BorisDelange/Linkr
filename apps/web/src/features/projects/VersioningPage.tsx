import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'

export function VersioningPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('versioning.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('versioning.description')}
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center text-center">
          <GitBranch size={48} className="text-muted-foreground/30" />
          <p className="mt-4 text-lg font-medium text-foreground">
            {t('versioning.coming_soon')}
          </p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {t('versioning.coming_soon_description')}
          </p>
        </div>
      </div>
    </div>
  )
}
