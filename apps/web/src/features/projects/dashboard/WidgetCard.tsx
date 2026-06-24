import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Pencil, Trash2, Type, Download, AlertTriangle, RefreshCw, Copy, FolderInput } from 'lucide-react'
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
  onRemove: () => void
  onEdit?: () => void
  onRename?: (name: string) => void
  /** Opens the dashboard Export dialog preselected to this widget. */
  onExport?: () => void
  /** Duplicate this widget into its current tab. */
  onDuplicate?: () => void
  /** Open the "move to tab" dialog for this widget. */
  onMove?: () => void
  /** Existing widget names in the same tab (for uniqueness validation) */
  siblingNames?: Set<string>
  editMode: boolean
  hideTitleBar?: boolean
  /** The widget's plugin changed since this widget was created/last edited. */
  stale?: boolean
  /** Realign the widget with the plugin's current version (accept the change). */
  onAcceptPluginVersion?: () => void
  children: React.ReactNode
}

export function WidgetCard({ title, onRemove, onEdit, onRename, onExport, onDuplicate, onMove, siblingNames, editMode, hideTitleBar, stale, onAcceptPluginVersion, children }: WidgetCardProps) {
  const { t } = useTranslation()
  const showTitleBar = !hideTitleBar
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(title)
  const [renameError, setRenameError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // When true, the dropdown close should NOT restore focus to its trigger
  // (because we want focus to go to the rename input instead).
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

  // Actions available in view mode (non-destructive only); structural edits stay edit-mode only.
  const hasViewActions = Boolean(onExport) || Boolean(stale && onAcceptPluginVersion)
  const viewMenuItems = (
    <>
      {acceptItem}
      {onExport && (
        <DropdownMenuItem onClick={onExport}>
          <Download size={14} />
          {t('dashboard.export_widget')}
        </DropdownMenuItem>
      )}
    </>
  )

  const menuItems = (
    <>
      {acceptItem}
      {onRename && (
        <DropdownMenuItem onClick={() => { renamePendingRef.current = true; setRenaming(true) }}>
          <Type size={14} />
          {t('dashboard.rename_widget')}
        </DropdownMenuItem>
      )}
      {onEdit && (
        <DropdownMenuItem onClick={onEdit}>
          <Pencil size={14} />
          {t('dashboard.edit_widget')}
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
      {(onRename || onEdit || onExport || onDuplicate || onMove) && <DropdownMenuSeparator />}
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
              <h3 className="text-xs font-semibold text-card-foreground truncate">
                {title}
              </h3>
            </div>
          )}
          {(editMode || hasViewActions) && (
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
                  // When rename was just triggered, prevent Radix from moving
                  // focus back to the trigger button — that would steal focus
                  // from the rename input and cause an immediate blur.
                  if (renamePendingRef.current) {
                    e.preventDefault()
                    renamePendingRef.current = false
                  }
                }}
              >
                {editMode ? menuItems : viewMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {/* Floating drift warning when the title bar is hidden — surfaced regardless of edit mode.
          z-30 to stay above a widget's own sticky table header (see the menu button below). */}
      {!showTitleBar && stale && (
        <div className="absolute top-1 left-1 z-30">
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
        </div>
      )}
      {/* Floating menu button when title bar is hidden — full menu in edit mode, view actions on hover otherwise.
          z-30 keeps it above a widget's own sticky table header (thead is z-10, sticky cells z-20). */}
      {!showTitleBar && (editMode || hasViewActions) && (
        <div className="absolute top-1 right-1 z-30">
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
              {editMode ? menuItems : viewMenuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="flex-1 overflow-hidden min-h-0 min-w-0" data-widget-content>{children}</div>
    </div>
  )
}
