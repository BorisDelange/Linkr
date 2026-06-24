import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, FolderInput, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface MoveTarget {
  id: string
  /** Tab's own name. */
  name: string
  /** Ancestor names from root down to (but excluding) this tab, for the breadcrumb. */
  path: string[]
}

interface MoveWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  widgetName: string
  /** Current tab of the widget — shown as disabled so it's clear where it lives now. */
  currentTabId: string
  targets: MoveTarget[]
  onMove: (tabId: string) => void
}

export function MoveWidgetDialog({ open, onOpenChange, widgetName, currentTabId, targets, onMove }: MoveWidgetDialogProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const filtered = useMemo(
    () => (q
      ? targets.filter((tb) => [tb.name, ...tb.path].some((s) => s.toLowerCase().includes(q)))
      : targets),
    [targets, q],
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setSearch(''); onOpenChange(o) }}>
      <DialogContent className="flex max-h-[80vh] max-w-md flex-col">
        <DialogHeader>
          <DialogTitle>{t('dashboard.move_widget')}</DialogTitle>
          <DialogDescription className="truncate">
            {t('dashboard.move_widget_description', { name: widgetName })}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common.search')}
            className="h-8 pl-8 text-xs"
            autoFocus
          />
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {filtered.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t('dashboard.move_widget_no_targets')}
            </p>
          )}
          {filtered.map((tb) => {
            const isCurrent = tb.id === currentTabId
            return (
              <button
                key={tb.id}
                type="button"
                disabled={isCurrent}
                onClick={() => { onMove(tb.id); onOpenChange(false); setSearch('') }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                  isCurrent ? 'cursor-default opacity-50' : 'hover:bg-accent',
                )}
              >
                <FolderInput size={13} className="shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {tb.path.map((p, i) => (
                    <span key={i} className="flex min-w-0 items-center gap-1 text-muted-foreground">
                      <span className="max-w-28 truncate">{p}</span>
                      <ChevronRight size={11} className="shrink-0 opacity-50" />
                    </span>
                  ))}
                  <span className="truncate font-medium text-foreground">{tb.name}</span>
                </span>
                {isCurrent && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{t('dashboard.move_widget_current')}</span>
                )}
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
