import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { PasswordInput } from '@/components/ui/password-input'
import { cn } from '@/lib/utils'
import {
  getPasswordMinLength, passwordRuleError, type PasswordRuleError,
} from '@/lib/password-policy'

interface NewPasswordFieldsProps {
  password: string
  confirm: string
  onPasswordChange: (value: string) => void
  onConfirmChange: (value: string) => void
  /** Whose password it is: the policy refuses the username. */
  username: string
  /** The password being replaced, when the user typed it: the new one must differ. */
  current?: string
  /** What the server refused on the last submit — the rules only it checks
   *  (common passwords). Clear it when the password changes. */
  serverError?: PasswordRuleError | null
  passwordLabel: React.ReactNode
  confirmLabel: React.ReactNode
  required?: boolean
  placeholder?: string
  /** Side by side, the hint under the pair (a wide settings dialog). */
  columns?: boolean
}

/** Whether a new password and its confirmation can be submitted. */
export function newPasswordReady(
  password: string, confirm: string, ctx: { username: string; current?: string },
): boolean {
  return password.length > 0 && password === confirm && !passwordRuleError(password, ctx)
}

/**
 * New password + confirmation, stating the policy up front and, under each
 * field, why the value would be refused — so a form never sits with its submit
 * button disabled and nothing saying why.
 */
export function NewPasswordFields({
  password, confirm, onPasswordChange, onConfirmChange, username, current, serverError,
  passwordLabel, confirmLabel, required, placeholder, columns,
}: NewPasswordFieldsProps) {
  const { t } = useTranslation()
  const [left, setLeft] = useState(false)

  const rule = password ? passwordRuleError(password, { username, current }) ?? serverError ?? null : null
  // "Too short" while still typing is noise: wait until the field is left, the
  // confirmation started, or the length reached.
  const showRule = rule && (rule.code !== 'password_too_short' || left || confirm.length > 0)
  // Likewise a confirmation still being typed is a prefix, not a mismatch.
  const mismatch = confirm.length > 0 && confirm !== password
    && (confirm.length >= password.length || !password.startsWith(confirm))
  const hint = t('password_policy.hint', { count: getPasswordMinLength() })

  return (
    <>
      <div className={cn(columns ? 'grid grid-cols-2 gap-4' : 'space-y-4')}>
        <FormField label={passwordLabel} required={required} hint={columns ? undefined : hint}>
          {({ id }) => (
            <div className="space-y-1.5">
              <PasswordInput
                id={id}
                value={password}
                placeholder={placeholder}
                autoComplete="new-password"
                onChange={(e) => onPasswordChange(e.target.value)}
                onBlur={() => setLeft(true)}
                aria-invalid={!!showRule || undefined}
              />
              <FieldError message={showRule ? t(`password_policy.${rule.code}`, rule.params) : null} />
            </div>
          )}
        </FormField>
        <FormField label={confirmLabel} required={required}>
          {({ id }) => (
            <div className="space-y-1.5">
              <PasswordInput
                id={id}
                value={confirm}
                placeholder={placeholder}
                autoComplete="new-password"
                onChange={(e) => onConfirmChange(e.target.value)}
                aria-invalid={mismatch || undefined}
              />
              <FieldError message={mismatch ? t('password_policy.mismatch') : null} />
            </div>
          )}
        </FormField>
      </div>
      {columns && <p className="-mt-2 text-xs text-muted-foreground">{hint}</p>}
    </>
  )
}
