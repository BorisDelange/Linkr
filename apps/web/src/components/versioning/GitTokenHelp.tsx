import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/** Short how-to for creating a personal access token, GitHub and GitLab. Folded
 *  away by default: it is read once, when first linking a repository, and the
 *  settings dialog is opened for other reasons every time after that. */
export function GitTokenHelp() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
        <ChevronRight size={11} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        {t('versioning.token_help_toggle')}
      </CollapsibleTrigger>
      {/* The help lists provider menu paths, which can be long — let it scroll
          rather than widen the dialog. */}
      <CollapsibleContent className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
