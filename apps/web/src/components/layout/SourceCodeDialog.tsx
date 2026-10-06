import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, GitBranch, Github, Gitlab, type LucideIcon } from 'lucide-react'
import { DialogShell } from '@/components/ui/dialog-shell'
import { cn } from '@/lib/utils'

const REPOSITORIES: { name: string; url: string; icon: LucideIcon }[] = [
  { name: 'Framagit', url: 'https://framagit.org/interhop/linkr/linkr', icon: Gitlab },
  { name: 'GitHub', url: 'https://github.com/BorisDelange/Linkr', icon: Github },
]

export function SourceCodeDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
      >
        <GitBranch size={11} />
        <span>{t('footer.source')}</span>
      </button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        kind="form"
        title={t('footer.source')}
        description={t('footer.source_hint')}
        hideFooter
      >
        <div className="space-y-2">
          {REPOSITORIES.map(({ name, url, icon: Icon }, i) => (
            <a
              key={name}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'group flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50',
                // Framagit is the first choice: it gets the emphasis.
                i === 0 && 'border-primary/40',
              )}
            >
              <Icon size={20} className="shrink-0 text-muted-foreground group-hover:text-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{name}</div>
                <div className="truncate text-xs text-muted-foreground">{url.replace(/^https:\/\//, '')}</div>
              </div>
              <ExternalLink size={14} className="shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      </DialogShell>
    </>
  )
}
