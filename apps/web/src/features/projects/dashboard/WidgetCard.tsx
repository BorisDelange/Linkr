import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Pencil, Trash2, Type, Settings2, Download, AlertTriangle, RefreshCw, Copy, FolderInput, Info } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface WidgetCardProps {
  title: string
  /** Widget description (resolved to the active language). Shown as an info bubble in the top-left rail. */
  description?: string
  onRemove: () => void
  /** Open the widget's Edit dialog (name + description). Dashboards use this. */
  onEdit?: () => void
  /** Inline-rename the widget's title in place. Patient charts use this (no description model). */
  onRename?: (name: string) => void
  /** Open the widget configuration panel (data / plugin config). */
  onConfigure?: () => void
  /** Opens the dashboard Export dialog preselected to this widget. */
  onExport?: () => void
  /** Duplicate this widget into its current tab. */
  onDuplicate?: () => void
  /** Open the "move to tab" dialog for this widget. */
  onMove?: () => void
  /** Existing sibling names (lowercased) for the inline-rename uniqueness check. */
  siblingNames?: Set<string>
  editMode: boolean
  hideTitleBar?: boolean
  /** The widget's plugin changed since this widget was created/last edited. */
  stale?: boolean
  /** Realign the widget with the plugin's current version (accept the change). */
  onAcceptPluginVersion?: () => void
  /** Extra badges (e.g. an active-filters indicator) shown in the floating top-left rail,
   *  to the right of the plugin-drift warning and info bubble, when the title bar is hidden. */
  topLeftBadges?: React.ReactNode
  children: React.ReactNode
}

export function WidgetCard({ title, description, onRemove, onEdit, onRename, onConfigure, onExport, onDuplicate, onMove, siblingNames, editMode, hideTitleBar, stale, onAcceptPluginVersion, topLeftBadges, children }: WidgetCardProps) {
  const { t } = useTranslation()
  const showTitleBar = !hideTitleBar
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(title)
  const [renameError, setRenameError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // When true, the dropdown close should NOT restore focus to its trigger (focus goes to the rename input).
  const renamePendingRef = useRef(false)

  useEffect(() => {
    if (renaming) {
      setRenameValue(title)
      setRenameError('')
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          el.select()
        }
      })
    }
  }, [renaming, title])

  const confirmRename = () => {
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenameError(t('dashboard.widget_name_required'))
      return
    }
    if (trimmed !== title && siblingNames?.has(trimmed.toLowerCase())) {
      setRenameError(t('dashboard.widget_name_taken'))
      return
    }
    if (trimmed && trimmed !== title && onRename) {
      onRename(trimmed)
    }
    setRenaming(false)
  }

  const infoBadge = description ? (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-5 items-center justify-center rounded bg-muted/80 text-muted-foreground backdrop-blur-sm">
            <Info size={11} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 whitespace-pre-wrap bg-foreground text-background">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null

  const staleIcon = (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 items-center text-amber-500">
            <AlertTriangle size={13} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('dashboard.plugin_drift_widget_tooltip')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )

  const acceptItem = stale && onAcceptPluginVersion && (
    <>
      <DropdownMenuItem onClick={onAcceptPluginVersion}>
        <RefreshCw size={14} />
        {t('dashboard.plugin_drift_accept')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )

  const menuItems = (
    <>
      {acceptItem}
      {onRename && (
        <DropdownMenuItem onClick={() => { renamePendingRef.current = true; setRenaming(true) }}>
          <Type size={14} />
          {t('common.rename')}
        </DropdownMenuItem>
      )}
      {onEdit && (
        <DropdownMenuItem onClick={onEdit}>
          <Pencil size={14} />
          {t('common.edit')}
        </DropdownMenuItem>
      )}
      {onConfigure && (
        <DropdownMenuItem onClick={onConfigure}>
          <Settings2 size={14} />
          {t('dashboard.configure_widget')}
        </DropdownMenuItem>
      )}
      {onDuplicate && (
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy size={14} />
          {t('dashboard.duplicate_widget')}
        </DropdownMenuItem>
      )}
      {onMove && (
        <DropdownMenuItem onClick={onMove}>
          <FolderInput size={14} />
          {t('dashboard.move_widget')}
        </DropdownMenuItem>
      )}
      {onExport && (
        <DropdownMenuItem onClick={onExport}>
          <Download size={14} />
          {t('dashboard.export_widget')}
        </DropdownMenuItem>
      )}
      {(onRename || onEdit || onConfigure || onExport || onDuplicate || onMove) && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={onRemove}>
        <Trash2 size={14} />
        {t('common.delete')}
      </DropdownMenuItem>
    </>
  )

  return (
    <div className="group relative flex h-full flex-col rounded-lg border bg-card shadow-sm overflow-hidden">
      {showTitleBar && (
        // min-h reserves the kebab button's height so toggling edit mode doesn't change the title-bar height.
        <div className="flex min-h-10 items-center justify-between border-b px-3 py-1">
          {renaming ? (
            <div className="flex-1 min-w-0">
              <Input
                ref={inputRef}
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); setRenameError('') }}
                onBlur={confirmRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename()
                  if (e.key === 'Escape') setRenaming(false)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                className={`h-5 text-xs font-semibold px-1 py-0 border-none shadow-none focus-visible:ring-1 ${renameError ? 'text-destructive' : ''}`}
              />
              {renameError && (
                <p className="text-[9px] text-destructive mt-0.5 px-1">{renameError}</p>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              {stale && staleIcon}
              {infoBadge}
              <h3 className="text-xs font-semibold text-card-foreground truncate">
                {title}
              </h3>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={`shrink-0 ${editMode ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'}`}
              >
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                // When rename was just triggered, keep focus on the rename input instead of the trigger.
                if (renamePendingRef.current) {
                  e.preventDefault()
                  renamePendingRef.current = false
                }
              }}
            >
              {menuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {/* Floating top-left rail when the title bar is hidden — surfaced regardless of edit mode.
          One row, left-to-right priority: plugin-drift warning, then the description info bubble,
          then any extra badges (e.g. the active-filters indicator). z-30 to stay above a widget's
          own sticky table header (see the menu button below). */}
      {!showTitleBar && (stale || infoBadge || topLeftBadges) && (
        <div className="absolute top-0.5 left-0.5 z-30 flex items-center gap-1">
          {stale && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center rounded bg-card/80 p-1 text-amber-500 backdrop-blur-sm">
                    <AlertTriangle size={12} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t('dashboard.plugin_drift_widget_tooltip')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {infoBadge}
          {topLeftBadges}
        </div>
      )}
      {/* Floating menu button when title bar is hidden — same full menu in and out of edit mode
          (hover-revealed when not editing). z-30 keeps it above a widget's own sticky table header. */}
      {!showTitleBar && (
        <div className="absolute top-0.5 right-0.5 z-30">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className={`shrink-0 bg-card/80 backdrop-blur-sm ${editMode ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'}`}
              >
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                if (renamePendingRef.current) {
                  e.preventDefault()
                  renamePendingRef.current = false
                }
              }}
            >
              {menuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="flex-1 overflow-hidden min-h-0 min-w-0" data-widget-content>{children}</div>
    </div>
  )
}
