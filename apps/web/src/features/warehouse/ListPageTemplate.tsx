import { useState, type ReactNode, type LucideIcon } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Pencil, Download, History, MoreHorizontal, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListPageTemplateProps<T extends { id: string; name: string }> {
  /** Page title i18n key */
  titleKey: string
  /** Page description i18n key */
  descriptionKey: string
  /** Create button label i18n key */
  newButtonKey: string
  /** Empty state i18n key */
  emptyTitleKey: string
  /** Empty state description i18n key */
  emptyDescriptionKey: string
  /** Delete confirm title i18n key */
  deleteConfirmTitleKey: string
  /** Delete confirm description i18n key (receives `{ name }`) */
  deleteConfirmDescriptionKey: string

  /** Icon for the empty state */
  emptyIcon: LucideIcon

  /** Items to display */
  items: T[]
  /** Navigate to item detail */
  onNavigate: (id: string) => void
  /** Delete an item */
  onDelete: (id: string) => Promise<void>

  /** Render the card body for each item (icon + middle content). Dropdown is handled by the template. */
  renderCardBody: (item: T) => ReactNode

  /** Render the create dialog */
  renderCreateDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) => ReactNode
  /** Render the edit dialog */
  renderEditDialog: (props: { item: T; onOpenChange: (open: boolean) => void }) => ReactNode
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ListPageTemplate<T extends { id: string; name: string }>({
  titleKey,
  descriptionKey,
  newButtonKey,
  emptyTitleKey,
  emptyDescriptionKey,
  deleteConfirmTitleKey,
  deleteConfirmDescriptionKey,
  emptyIcon: EmptyIcon,
  items,
  onNavigate,
  onDelete,
  renderCardBody,
  renderCreateDialog,
  renderEditDialog,
}: ListPageTemplateProps<T>) {
  const { t } = useTranslation()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [toDelete, setToDelete] = useState<T | null>(null)
  const [toEdit, setToEdit] = useState<T | null>(null)

  const handleDelete = async () => {
    if (toDelete) {
      await onDelete(toDelete.id)
      setToDelete(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t(titleKey)}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t(descriptionKey)}</p>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button variant="outline" size="sm" disabled className="gap-1 text-xs">
                    <Upload size={14} />
                    {t('common.import')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('common.coming_soon')}</TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
              <Plus size={14} />
              {t(newButtonKey)}
            </Button>
          </div>
        </div>

        {/* Empty state / Item grid */}
        {items.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <EmptyIcon size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">{t(emptyTitleKey)}</p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t(emptyDescriptionKey)}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {items.map((item) => (
              <Card
                key={item.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => onNavigate(item.id)}
              >
                <div className="flex items-start gap-4 p-4">
                  {renderCardBody(item)}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setToEdit(item) }}>
                        <Pencil size={14} />
                        {t('common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        <Download size={14} />
                        {t('common.export')}
                        <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled>
                        <History size={14} />
                        {t('common.history')}
                        <span className="ml-auto text-[10px] text-muted-foreground">{t('common.server_only')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => { e.stopPropagation(); setToDelete(item) }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 size={14} />
                        {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      {renderCreateDialog({
        open: dialogOpen,
        onOpenChange: setDialogOpen,
        onCreated: (id) => { setDialogOpen(false); onNavigate(id) },
      })}

      {/* Edit dialog */}
      {toEdit && renderEditDialog({
        item: toEdit,
        onOpenChange: (open) => { if (!open) setToEdit(null) },
      })}

      {/* Delete confirmation */}
      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(deleteConfirmTitleKey)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(deleteConfirmDescriptionKey, { name: toDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
