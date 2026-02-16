import { useTranslation } from 'react-i18next'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'

interface WidgetCardProps {
  title: string
  onRemove: () => void
  editMode: boolean
  children: React.ReactNode
}

export function WidgetCard({ title, onRemove, editMode, children }: WidgetCardProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h3 className="text-xs font-semibold text-card-foreground truncate">
          {title}
        </h3>
        {editMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="shrink-0">
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2 size={14} />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="flex-1 overflow-hidden p-3 min-h-0 min-w-0">{children}</div>
    </div>
  )
}
