import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LinkrLogo } from '@/components/ui/linkr-logo'
import { useAuthStore } from '@/stores/auth-store'

interface LoginPageProps {
  setupJustCompleted?: boolean
}

export function LoginPage({ setupJustCompleted }: LoginPageProps) {
  const { t } = useTranslation()
  const { login, loginError } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !password) return
    setLoading(true)
    await login(username, password)
    setLoading(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm px-4">
        {/* Logo + title */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <LinkrLogo size={48} />
          <h1 className="text-2xl font-bold text-foreground">Linkr</h1>
          <p className="text-sm text-muted-foreground">
            {t('login.subtitle')}
          </p>
        </div>

        {/* Setup success message */}
        {setupJustCompleted && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-center text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
            {t('login.setup_complete')}
          </div>
        )}

        <Card>
          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">{t('login.username')}</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t('login.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>

              {loginError && (
                <p className="text-sm text-destructive">{t('login.error')}</p>
              )}

              <Button type="submit" className="w-full" disabled={loading || !username || !password}>
                {loading && <Loader2 size={16} className="animate-spin" />}
                {loading ? t('login.signing_in') : t('login.submit')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
