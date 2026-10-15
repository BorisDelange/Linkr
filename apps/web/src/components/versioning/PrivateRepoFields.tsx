import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { isServerMode } from '@/lib/api-client'
import { GitTokenHelp } from './GitTokenHelp'

interface PrivateRepoFieldsProps {
  isPrivate: boolean
  onPrivateChange: (isPrivate: boolean) => void
  token: string
  onTokenChange: (token: string) => void
  /** Host of the repo, named in the hints; null while the URL is not parseable. */
  host: string | null
  /** From `useHostToken`: a stored token makes the field optional. */
  hasToken: boolean | null
}

/**
 * "Private repository" switch revealing the access-token field and how to create
 * one. The token is saved to the account per host, server-side — a client-only
 * build has no account, so it renders nothing there.
 */
export function PrivateRepoFields({
  isPrivate, onPrivateChange, token, onTokenChange, host, hasToken,
}: PrivateRepoFieldsProps) {
  const { t } = useTranslation()
  const switchId = useId()
  if (!isServerMode()) return null

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={switchId}>{t('versioning.private_repo')}</Label>
        <Switch id={switchId} checked={isPrivate} onCheckedChange={onPrivateChange} />
      </div>
      {isPrivate && (
        <>
          <FormField
            label={t('versioning.remote_token')}
            required={hasToken !== true}
            // Only the stored-token note says what to do with the field; the other is background.
            hintInTooltip={!hasToken}
            hint={
              hasToken
                ? t('versioning.private_repo_token_stored', { host })
                : t('versioning.private_repo_token_hint', { host: host ?? t('versioning.private_repo_this_host') })
            }
          >
            {({ id }) => (
              <PasswordInput
                id={id}
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder={hasToken ? '••••••••' : t('versioning.remote_token_placeholder')}
                autoComplete="off"
              />
            )}
          </FormField>
          <GitTokenHelp />
        </>
      )}
    </div>
  )
}
