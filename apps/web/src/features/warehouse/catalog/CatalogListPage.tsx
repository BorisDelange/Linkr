import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BookOpen, Plus, Trash2, Pencil, Download, History, Database, MoreHorizontal, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import { useCatalogStore } from '@/stores/catalog-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { CreateCatalogDialog } from './CreateCatalogDialog'
import type { DataCatalog, CatalogStatus } from '@/types'

const STATUS_BADGE: Record<CatalogStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'data_catalog.status_draft' },
  ready: { variant: 'outline', label: 'data_catalog.status_ready' },
  computing: { variant: 'default', label: 'data_catalog.status_computing' },
  success: { variant: 'default', label: 'data_catalog.status_success' },
  error: { variant: 'destructive', label: 'data_catalog.status_error' },
}

export function CatalogListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { catalogsLoaded, loadCatalogs, getWorkspaceCatalogs, deleteCatalog } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [toDelete, setToDelete] = useState<DataCatalog | null>(null)
  const [toEdit, setToEdit] = useState<DataCatalog | null>(null)

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  const catalogs = activeWorkspaceId ? getWorkspaceCatalogs(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  const handleCreated = (catalogId: string) => {
    navigate(catalogId)
  }

  const handleDelete = async () => {
    if (toDelete) {
      await deleteCatalog(toDelete.id)
      setToDelete(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('data_catalog.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('data_catalog.description')}
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
              {t('data_catalog.new_catalog')}
            </Button>
          </div>
        </div>

        {catalogs.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <BookOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('data_catalog.no_catalogs')}
              </p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('data_catalog.no_catalogs_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {catalogs.map((catalog) => {
              const statusInfo = STATUS_BADGE[catalog.status]
              return (
                <Card
                  key={catalog.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(catalog.id)}
                >
                  <div className="flex items-start gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
                      <BookOpen size={20} className="text-teal-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {catalog.name}
                        </span>
                        <Badge variant={statusInfo.variant} className="text-[10px]">
                          {t(statusInfo.label)}
                        </Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Database size={12} />
                        <span>{getSourceName(catalog.dataSourceId)}</span>
                      </div>
                      {catalog.lastComputedAt && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {t('data_catalog.last_computed')}: {new Date(catalog.lastComputedAt).toLocaleString()}
                          {catalog.lastComputeDurationMs != null && ` (${(catalog.lastComputeDurationMs / 1000).toFixed(1)}s)`}
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
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setToEdit(catalog) }}>
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
                          onClick={(e) => { e.stopPropagation(); setToDelete(catalog) }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateCatalogDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />

      <CreateCatalogDialog
        open={!!toEdit}
        onOpenChange={(open) => { if (!open) setToEdit(null) }}
        editingCatalog={toEdit}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_catalog.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('data_catalog.delete_description', { name: toDelete?.name ?? '' })}
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
