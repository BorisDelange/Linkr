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

export function ProfilePage() {
  const { t, i18n } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    user,
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
            <TabsTrigger value="notifications">
              {t('profile.notifications')}
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
                <div className="space-y-2">
                  <Label>{t('profile.email')}</Label>
                  <Input value={user?.email ?? ''} disabled />
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
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current-password">
                    {t('profile.current_password')}
                  </Label>
                  <Input id="current-password" type="password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-password">
                    {t('profile.new_password')}
                  </Label>
                  <Input id="new-password" type="password" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">
                    {t('profile.confirm_password')}
                  </Label>
                  <Input id="confirm-password" type="password" />
                </div>
                <Button size="sm">{t('common.save')}</Button>
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

          {/* Notifications tab */}
          <TabsContent value="notifications" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.notifications')}
                </CardTitle>
                <CardDescription>
                  {t('profile.notifications_description')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">
                      {t('profile.email_notifications')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('profile.email_notifications_description')}
                    </p>
                  </div>
                  <Switch />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">
                      {t('profile.project_updates')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('profile.project_updates_description')}
                    </p>
                  </div>
                  <Switch defaultChecked />
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
