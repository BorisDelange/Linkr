import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { localized, setLocalized } from '@/lib/localized'
import { LangHint } from '@/components/ui/lang-hint'
import type { LocalizedString } from '@/types'
import { useSaveForm } from '@/hooks/use-save-form'
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
import { ChangePasswordDialog } from './ChangePasswordDialog'
import { Info, Lock } from 'lucide-react'

interface AccountDraft {
  firstName: string
  lastName: string
  email: string
  /** Multilingual: kept as a LocalizedString so switching the app language edits
   *  the matching language without clobbering the other. */
  affiliation: LocalizedString | string
  profession: LocalizedString | string
  orcid: string
}

function accountDraftFrom(user: { firstName?: string; lastName?: string; email?: string; affiliation?: LocalizedString | string; profession?: LocalizedString | string; orcid?: string } | null): AccountDraft {
  return {
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    affiliation: user?.affiliation ?? '',
    profession: user?.profession ?? '',
    orcid: user?.orcid ?? '',
  }
}

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

  const [draft, setDraft] = useState<AccountDraft>(() => accountDraftFrom(user))
  const [passwordOpen, setPasswordOpen] = useState(false)
  // Re-sync the draft if the stored user changes from elsewhere.
  useEffect(() => { setDraft(accountDraftFrom(user)) }, [user?.firstName, user?.lastName, user?.email, user?.affiliation, user?.profession, user?.orcid])

  const setField = (key: 'firstName' | 'lastName' | 'email' | 'orcid', value: string) => setDraft((d) => ({ ...d, [key]: value }))
  // affiliation/profession are multilingual: edit only the active app language,
  // preserving the other language's stored value (same pattern as entity forms).
  const setLocalizedField = (key: 'affiliation' | 'profession', value: string) =>
    setDraft((d) => ({ ...d, [key]: setLocalized(d[key], language, value) }))
  const saveAccount = () => updateUser({ ...draft })

  const account = useSaveForm({
    current: draft,
    baseline: accountDraftFrom(user),
    onSave: saveAccount,
  })

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
        <h1 className="text-2xl font-bold text-foreground text-center">
          {t('profile.title')}
        </h1>

        <Tabs
          value={currentTab}
          onValueChange={handleTabChange}
          className="mt-6"
        >
          <TabsList className="mx-auto">
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
            <Card className="gap-2">
              <CardHeader>
                <CardTitle className="text-sm">
                  {t('profile.account')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
                  <Info size={14} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
                  <p className="text-xs text-blue-700 dark:text-blue-300">{t('profile.account_provenance_info')}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t('profile.username')}</Label>
                  <Input value={user?.username ?? ''} disabled />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>{t('profile.first_name')}</Label>
                    <Input
                      value={draft.firstName}
                      placeholder={t('profile.first_name')}
                      onChange={(e) => setField('firstName', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('profile.last_name')}</Label>
                    <Input
                      value={draft.lastName}
                      placeholder={t('profile.last_name')}
                      onChange={(e) => setField('lastName', e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>{t('profile.email')}</Label>
                  <Input
                    type="email"
                    value={draft.email}
                    placeholder={t('profile.email_placeholder')}
                    onChange={(e) => setField('email', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label>{t('profile.affiliation')}</Label>
                    <LangHint lang={language} />
                  </div>
                  <Input
                    value={localized(draft.affiliation, language)}
                    placeholder={t('profile.affiliation_placeholder')}
                    onChange={(e) => setLocalizedField('affiliation', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>{t('profile.profession')}</Label>
                      <LangHint lang={language} />
                    </div>
                    <Input
                      value={localized(draft.profession, language)}
                      placeholder={t('profile.profession_placeholder')}
                      onChange={(e) => setLocalizedField('profession', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('profile.orcid')}</Label>
                    <Input
                      value={draft.orcid}
                      placeholder="0000-0000-0000-0000"
                      onChange={(e) => setField('orcid', e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between border-t pt-4">
                  <Button
                    variant="outline"
                    onClick={() => setPasswordOpen(true)}
                  >
                    <Lock size={14} />
                    {t('profile.change_password')}
                  </Button>
                  <Button onClick={account.save} disabled={!account.canSaveNow}>
                    {t('common.save')}
                  </Button>
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

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  )
}
