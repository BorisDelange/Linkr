import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { SquareTerminal, Plus, Trash2, Pencil, Download, History, MoreHorizontal, Upload } from 'lucide-react'
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
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CreateSqlScriptsDialog } from './CreateSqlScriptsDialog'
import type { SqlScriptCollection } from '@/types'

export function SqlScriptsListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { collectionsLoaded, loadCollections, getWorkspaceCollections, deleteCollection } = useSqlScriptsStore()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [toDelete, setToDelete] = useState<SqlScriptCollection | null>(null)
  const [toEdit, setToEdit] = useState<SqlScriptCollection | null>(null)

  useEffect(() => {
    if (!collectionsLoaded) loadCollections()
  }, [collectionsLoaded, loadCollections])

  const collections = activeWorkspaceId ? getWorkspaceCollections(activeWorkspaceId) : []

  const handleCreated = (collectionId: string) => {
    navigate(collectionId)
  }

  const handleDelete = async () => {
    if (toDelete) {
      await deleteCollection(toDelete.id)
      setToDelete(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('sql_scripts.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('sql_scripts.description')}
            </p>
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
              {t('sql_scripts.new_collection')}
            </Button>
          </div>
        </div>

        {collections.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <SquareTerminal size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('sql_scripts.no_collections')}
              </p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('sql_scripts.no_collections_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {collections.map((collection) => (
              <Card
                key={collection.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => navigate(collection.id)}
              >
                <div className="flex items-start gap-4 p-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                    <SquareTerminal size={20} className="text-teal-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm font-medium">
                      {collection.name}
                    </span>
                    {collection.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                        {collection.description}
                      </p>
                    )}
                  </div>
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
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setToEdit(collection) }}>
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
                        <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => { e.stopPropagation(); setToDelete(collection) }}
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

      <CreateSqlScriptsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />

      <CreateSqlScriptsDialog
        open={!!toEdit}
        onOpenChange={(open) => { if (!open) setToEdit(null) }}
        editingCollection={toEdit}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sql_scripts.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sql_scripts.delete_confirm_description', { name: toDelete?.name ?? '' })}
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
