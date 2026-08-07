import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { FolderCog } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * The resolved server folder a page is bound to (IDE working dir / datasets dir),
 * shown as a compact path bar. The folder icon is a button that deep-links to the
 * project's Settings → Folders tab, where the binding can be changed. Server mode
 * only (front-only has no server folder to show). Must render inside a
 * TooltipProvider (both host pages already wrap their content in one).
 */
export function FolderPathBar({ path }: { path: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  // Derive the project's Settings URL from the current path: everything up to and
  // including `.../projects/:uid`, then `/settings/folders`.
  const goToFolderSettings = () => {
    const m = location.pathname.match(/^(.*\/projects\/[^/]+)/)
    if (!m) return
    navigate(`${m[1]}/settings/folders`)
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={goToFolderSettings}
            className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
          >
            <FolderCog size={12} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('project_folders.change_in_settings')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 truncate font-mono">{path}</span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-md break-all font-mono text-xs">
          {path}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
