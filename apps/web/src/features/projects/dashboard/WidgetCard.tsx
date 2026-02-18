import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Pencil, Trash2, Type } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface WidgetCardProps {
  title: string
  onRemove: () => void
  onEdit?: () => void
  onRename?: (name: string) => void
  editMode: boolean
  hideTitleBar?: boolean
  children: React.ReactNode
}

export function WidgetCard({ title, onRemove, onEdit, onRename, editMode, hideTitleBar, children }: WidgetCardProps) {
  const { t } = useTranslation()
  const showTitleBar = editMode || !hideTitleBar
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) {
      setRenameValue(title)
      // Focus after render
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [renaming, title])

  const confirmRename = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== title && onRename) {
      onRename(trimmed)
    }
    setRenaming(false)
  }

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card shadow-sm overflow-hidden">
      {showTitleBar && (
        <div className="flex items-center justify-between border-b px-3 py-2">
          {renaming ? (
            <Input
              ref={inputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={confirmRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className="h-5 text-xs font-semibold px-1 py-0 border-none shadow-none focus-visible:ring-1"
            />
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
              <DropdownMenuContent align="end">
                {onRename && (
                  <DropdownMenuItem onClick={() => setRenaming(true)}>
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
                {(onRename || onEdit) && <DropdownMenuSeparator />}
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Trash2 size={14} />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      <div className="flex-1 overflow-hidden p-1 min-h-0 min-w-0">{children}</div>
    </div>
  )
}
