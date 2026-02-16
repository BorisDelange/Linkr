import { useTranslation } from 'react-i18next'
import { UsersTab } from './UsersTab'

export function SettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('settings.title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('settings.description')}
        </p>

        <div className="mt-6">
          <UsersTab />
        </div>
      </div>
    </div>
  )
}
