import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Lock } from 'lucide-react'
import { PasswordInput } from '@/components/ui/password-input'
import { FormField } from '@/components/ui/form-field'
import { FieldError } from '@/components/ui/field-error'
import { DialogShell } from '@/components/ui/dialog-shell'
import { NewPasswordFields, newPasswordReady } from '@/components/ui/new-password-fields'
import { apiFetch } from '@/lib/api-client'
import { passwordErrorFromApi, type PasswordRuleError } from '@/lib/password-policy'
import { useAuthStore } from '@/stores/auth-store'

const isServerMode = !!import.meta.env.VITE_API_URL

interface ChangePasswordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [currentWrong, setCurrentWrong] = useState(false)
  const [policyError, setPolicyError] = useState<PasswordRuleError | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const username = useAuthStore((s) => s.user?.username ?? '')

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm('')
    setCurrentWrong(false); setPolicyError(null); setError(null); setSubmitting(false)
  }

  const handleOpenChange = (o: boolean) => {
    if (!o) reset()
    onOpenChange(o)
  }

  const canSubmit = current.length > 0 && !policyError && !submitting
    && newPasswordReady(next, confirm, { username, current })

  const handleSubmit = async () => {
    setError(null)
    setCurrentWrong(false)
    setSubmitting(true)
    try {
      const res = await apiFetch('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      if (!res.ok) {
        const policy = res.status === 422 ? passwordErrorFromApi(await res.json().catch(() => null)) : null
        if (res.status === 403) setCurrentWrong(true)
        else if (policy) setPolicyError(policy)
        else setError(t('profile.password_change_error'))
        setSubmitting(false)
        return
      }
      // The change ends every session issued before it, this one included.
      const data = await res.json()
      useAuthStore.getState().setTokens(data.access_token, data.refresh_token, data.user)
      handleOpenChange(false)
    } catch {
      setError(t('profile.password_change_error'))
      setSubmitting(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title={
        <span className="flex items-center gap-2">
          <Lock size={16} />
          {t('profile.change_password')}
        </span>
      }
      description={t('profile.change_password_description')}
      onConfirm={handleSubmit}
      confirmLabel={t('common.save')}
      confirmDisabled={!canSubmit}
      busy={submitting}
      hideFooter={!isServerMode}
      contentClassName={isServerMode ? undefined : 'space-y-0'}
    >
      {isServerMode ? (
        <>
          <FormField label={t('profile.current_password')}>
            {({ id }) => (
              <>
                <PasswordInput
                  id={id}
                  value={current}
                  onChange={(e) => { setCurrent(e.target.value); setCurrentWrong(false) }}
                  autoComplete="current-password"
                  aria-invalid={currentWrong || undefined}
                />
                <FieldError message={currentWrong ? t('profile.password_current_wrong') : null} />
              </>
            )}
          </FormField>
          <NewPasswordFields
            password={next}
            confirm={confirm}
            onPasswordChange={(v) => { setNext(v); setPolicyError(null) }}
            onConfirmChange={setConfirm}
            username={username}
            current={current}
            serverError={policyError}
            passwordLabel={t('profile.new_password')}
            confirmLabel={t('profile.confirm_password')}
          />
          <FieldError message={error} />
        </>
      ) : (
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
      )}
    </DialogShell>
  )
}
