import { useTranslation } from 'react-i18next'

/** Short how-to for creating a personal access token, GitHub and GitLab, shown
 *  in the "Edit token" tooltip. Kept compact: one bullet list per provider. */
export function GitTokenHelp() {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 text-[11px] leading-relaxed">
      <div>
        <p className="font-bold">GitHub</p>
        <ul className="mt-0.5 list-disc space-y-0.5 pl-3.5">
          <li>{t('versioning.token_help_github_1')}</li>
          <li>{t('versioning.token_help_github_2')}</li>
          <li>{t('versioning.token_help_github_3')}</li>
        </ul>
      </div>
      <div>
        <p className="font-bold">GitLab</p>
        <ul className="mt-0.5 list-disc space-y-0.5 pl-3.5">
          <li>{t('versioning.token_help_gitlab_1')}</li>
          <li>{t('versioning.token_help_gitlab_2')}</li>
          <li>{t('versioning.token_help_gitlab_3')}</li>
        </ul>
      </div>
    </div>
  )
}
