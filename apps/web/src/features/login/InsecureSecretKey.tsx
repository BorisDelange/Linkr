import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkrLogo } from '@/components/ui/linkr-logo'
import { CopyablePath } from '@/components/ui/parquet-files-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '@/stores/auth-store'

const GENERATE_KEY = "python3 -c 'import secrets; print(secrets.token_urlsafe(48))'"
const RESTART_DOCKER = 'docker compose up -d'

/**
 * Shown in server mode when the backend runs on a LINKR_SECRET_KEY from an
 * example configuration and refuses every request (api core/example_secret.py).
 * Whoever opens Linkr may not administer it, so the page says what to do and why.
 */
export function InsecureSecretKey() {
  const { t } = useTranslation()
  const { checkSetupStatus } = useAuthStore()
  const [retrying, setRetrying] = useState(false)

  const handleRetry = async () => {
    setRetrying(true)
    await checkSetupStatus()
    setRetrying(false)
  }

  const steps = [
    { key: 'login.insecure_secret_key_step_generate', command: GENERATE_KEY },
    { key: 'login.insecure_secret_key_step_set' },
    { key: 'login.insecure_secret_key_step_restart', command: RESTART_DOCKER },
  ]

  return (
    <TooltipProvider>
      <div className="flex min-h-screen items-center justify-center bg-background py-8">
        <div className="w-full max-w-xl px-4">
          <div className="mb-6 flex justify-center">
            <LinkrLogo size={48} />
          </div>
          <Card>
            <CardHeader className="text-center">
              <div className="mb-2 flex justify-center text-destructive">
                <ShieldAlert size={32} />
              </div>
              <CardTitle>{t('login.insecure_secret_key_title')}</CardTitle>
              <CardDescription className="text-justify">{t('login.insecure_secret_key_description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <ol className="space-y-3">
                {steps.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p><Trans i18nKey={step.key} components={{ b: <strong className="font-semibold" /> }} /></p>
                      {step.command && <CopyablePath value={step.command} size="xs" />}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">{t('login.insecure_secret_key_signed_out')}</p>
              <p className="text-muted-foreground">{t('login.insecure_secret_key_not_admin')}</p>
              <Button className="w-full" onClick={handleRetry} disabled={retrying}>
                {retrying && <Loader2 size={16} className="animate-spin" />}
                {t('login.retry')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </TooltipProvider>
  )
}
