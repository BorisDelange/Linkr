import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkrLogo } from '@/components/ui/linkr-logo'
import { useAuthStore } from '@/stores/auth-store'

/**
 * Shown in server mode when the backend didn't answer the initial setup check —
 * it's down, the API URL is wrong, or it refused to boot (e.g. an insecure
 * secret_key / wildcard CORS guard). Distinct from the login page so the user
 * isn't handed a form that can only fail with a misleading "invalid credentials".
 */
export function ServerUnreachable() {
  const { t } = useTranslation()
  const { checkSetupStatus } = useAuthStore()
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    setRetrying(true)
    await checkSetupStatus()
    setRetrying(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm px-4">
        <div className="mb-6 flex justify-center">
          <LinkrLogo size={48} />
        </div>
        <Card>
          <CardHeader className="text-center">
            <div className="mb-2 flex justify-center text-muted-foreground">
              <ServerCrash size={32} />
            </div>
            <CardTitle>{t('login.server_unreachable_title')}</CardTitle>
            <CardDescription>{t('login.server_unreachable_description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={handleRetry} disabled={retrying}>
              {retrying && <Loader2 size={16} className="animate-spin" />}
              {t('login.retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
