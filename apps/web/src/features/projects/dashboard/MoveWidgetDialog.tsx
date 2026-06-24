import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, FolderInput, Layers, LayoutGrid } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { DashboardTreeRow } from './dashboard-tree'

interface MoveWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  widgetName: string
  /** Current tab of the widget — shown disabled so it's clear where it lives now. */
  currentTabId: string
  /** Hierarchical tab/widget rows of the dashboard (widgets included for context). */
  rows: DashboardTreeRow[]
  onMove: (tabId: string) => void
}

export function MoveWidgetDialog({ open, onOpenChange, widgetName, currentTabId, rows, onMove }: MoveWidgetDialogProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return rows
    // Keep matching rows AND their ancestor tabs, so a match still shows where it sits in the
    // hierarchy. Rows are pre-ordered parent-before-children, so each row's ancestors are the
    // nearest preceding rows of strictly decreasing depth.
    const keep = new Set<number>()
    rows.forEach((r, i) => {
      if (!r.name.toLowerCase().includes(q)) return
      keep.add(i)
      let needDepth = r.depth - 1
      for (let j = i - 1; j >= 0 && needDepth >= 0; j--) {
        if (rows[j].depth === needDepth) { keep.add(j); needDepth-- }
      }
    })
    return rows.filter((_, i) => keep.has(i))
  }, [rows, q])

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
          {filtered.map((row) => {
            const indent = { paddingLeft: 8 + row.depth * 16 }
            // Only leaf tabs are valid destinations; containers and widgets are context only.
            if (row.kind === 'widget') {
              return (
                <div key={row.id} style={indent} className="flex items-center gap-2 py-1 pr-2.5 text-[11px] text-muted-foreground">
                  <LayoutGrid size={11} className="shrink-0 opacity-60" />
                  <span className="truncate">{row.name}</span>
                </div>
              )
            }
            if (row.isContainer) {
              return (
                <div key={row.id} style={indent} className="flex items-center gap-2 py-1.5 pr-2.5 text-xs font-medium text-muted-foreground">
                  <Layers size={12} className="shrink-0" />
                  <span className="truncate">{row.name}</span>
                </div>
              )
            }
            const isCurrent = row.id === currentTabId
            return (
              <button
                key={row.id}
                type="button"
                disabled={isCurrent}
                onClick={() => { onMove(row.id); onOpenChange(false); setSearch('') }}
                style={indent}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md py-2 pr-2.5 text-left text-xs transition-colors',
                  isCurrent ? 'cursor-default opacity-50' : 'hover:bg-accent',
                )}
              >
                <FolderInput size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
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
