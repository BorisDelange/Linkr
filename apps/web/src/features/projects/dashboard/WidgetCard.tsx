import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Pencil, Trash2, Type, Download } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ExportFormat } from './figure-export'

interface WidgetCardProps {
  title: string
  onRemove: () => void
  onEdit?: () => void
  onRename?: (name: string) => void
  onExport?: (format: ExportFormat) => void
  /** Existing widget names in the same tab (for uniqueness validation) */
  siblingNames?: Set<string>
  editMode: boolean
  hideTitleBar?: boolean
  children: React.ReactNode
}

export function WidgetCard({ title, onRemove, onEdit, onRename, onExport, siblingNames, editMode, hideTitleBar, children }: WidgetCardProps) {
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

  const menuItems = (
    <>
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
      {onExport && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Download size={14} />
            {t('dashboard.export_widget')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => onExport('png')}>PNG</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport('svg')}>SVG</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {(onRename || onEdit || onExport) && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={onRemove}>
        <Trash2 size={14} />
        {t('common.delete')}
      </DropdownMenuItem>
    </>
  )

  return (
    <div className="relative flex h-full flex-col rounded-lg border bg-card shadow-sm overflow-hidden">
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
            <h3 className="text-xs font-semibold text-card-foreground truncate">
              {title}
            </h3>
          )}
          {editMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="shrink-0">
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
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {/* Floating menu button when title bar is hidden but in edit mode */}
      {!showTitleBar && editMode && (
        <div className="absolute top-1 right-1 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="shrink-0 bg-card/80 backdrop-blur-sm">
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
