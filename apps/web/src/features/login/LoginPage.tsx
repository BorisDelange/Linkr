import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { Sun, Moon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function LoginPage() {
  const { t } = useTranslation()
  const { darkMode, toggleDarkMode, language, setLanguage } = useAppStore()
  const { i18n } = useTranslation()
  const login = useAppStore((s) => s.login)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleLanguageToggle = () => {
    const newLang = language === 'en' ? 'fr' : 'en'
    setLanguage(newLang)
    i18n.changeLanguage(newLang)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(false)
    setLoading(true)

    // TODO: Replace with real API call
    await new Promise((resolve) => setTimeout(resolve, 500))

    if (username === 'admin' && password === 'admin') {
      login({ id: 1, username: 'admin', email: 'admin@linkr.org', role: 'admin' })
    } else {
      setError(true)
    }
    setLoading(false)
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      <div className="flex justify-end gap-1 p-3">
        <Button variant="ghost" size="sm" onClick={handleLanguageToggle}>
          {language.toUpperCase()}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={toggleDarkMode}>
          {darkMode ? <Sun size={16} /> : <Moon size={16} />}
        </Button>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold text-primary">
              Linkr
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Healthcare Data Platform
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-center text-lg">
                {t('login.title')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="username"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t('login.username')}
                  </label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="password"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t('login.password')}
                  </label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error && (
                  <p className="text-xs text-destructive">{t('login.error')}</p>
                )}

                <Button
                  type="submit"
                  disabled={loading || !username || !password}
                  className="mt-1"
                >
                  {loading ? t('common.loading') : t('login.submit')}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Linkr v2.0 &middot; InterHop
          </p>
        </div>
      </div>
    </div>
  )
}
