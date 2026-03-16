import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EditorSettingsForm } from './EditorSettingsForm'
import { Info, Lock } from 'lucide-react'

export function ProfilePage() {
  const { t, i18n } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    user,
    updateUser,
    language,
    setLanguage,
    darkMode,
    toggleDarkMode,
  } = useAppStore()

  const currentTab = searchParams.get('tab') ?? 'profile'

  const handleTabChange = (value: string) => {
    if (value === 'profile') {
      setSearchParams({}, { replace: true })
    } else {
      setSearchParams({ tab: value }, { replace: true })
    }
  }

  const handleLanguageChange = (lang: 'en' | 'fr') => {
    setLanguage(lang)
    i18n.changeLanguage(lang)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-bold text-foreground">
          {t('profile.title')}
        </h1>

        <Tabs
          value={currentTab}
          onValueChange={handleTabChange}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="profile">
              {t('profile.account')}
            </TabsTrigger>
            <TabsTrigger value="appearance">
              {t('profile.appearance')}
            </TabsTrigger>
            <TabsTrigger value="editor">
              {t('profile.editor')}
            </TabsTrigger>
          </TabsList>

          {/* Account tab */}
          <TabsContent value="profile" className="mt-6 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.account')}
                </CardTitle>
                <CardDescription>
                  {t('profile.account_description')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('profile.username')}</Label>
                  <Input value={user?.username ?? ''} disabled />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('profile.first_name')}</Label>
                    <Input
                      value={user?.firstName ?? ''}
                      placeholder={t('profile.first_name')}
                      onChange={(e) => updateUser({ firstName: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('profile.last_name')}</Label>
                    <Input
                      value={user?.lastName ?? ''}
                      placeholder={t('profile.last_name')}
                      onChange={(e) => updateUser({ lastName: e.target.value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.change_password')}
                </CardTitle>
                <CardDescription>
                  {t('profile.change_password_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col items-center py-6">
                  <Lock size={36} className="text-muted-foreground/50" />
                  <p className="mt-3 text-sm font-medium text-foreground">
                    {t('profile.change_password_requires_backend')}
                  </p>
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950 max-w-md">
                    <Info size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t('profile.change_password_requires_backend_description')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Appearance tab */}
          <TabsContent value="appearance" className="mt-6 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.language')}
                </CardTitle>
                <CardDescription>
                  {t('profile.language_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Button
                    variant={language === 'en' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handleLanguageChange('en')}
                  >
                    English
                  </Button>
                  <Button
                    variant={language === 'fr' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handleLanguageChange('fr')}
                  >
                    Français
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.dark_mode')}
                </CardTitle>
                <CardDescription>
                  {t('profile.dark_mode_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <Switch
                    id="dark-mode"
                    checked={darkMode}
                    onCheckedChange={toggleDarkMode}
                  />
                  <Label htmlFor="dark-mode" className="text-sm">
                    {t('profile.dark_mode')}
                  </Label>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Editor tab */}
          <TabsContent value="editor" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.editor')}
                </CardTitle>
                <CardDescription>
                  {t('profile.editor_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EditorSettingsForm />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
