import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BookOpen, Database } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useCatalogStore } from '@/stores/catalog-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { ListPageTemplate } from '../ListPageTemplate'
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

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  const catalogs = activeWorkspaceId ? getWorkspaceCatalogs(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? '—'

  return (
    <ListPageTemplate<DataCatalog>
      titleKey="data_catalog.title"
      descriptionKey="data_catalog.description"
      newButtonKey="data_catalog.new_catalog"
      emptyTitleKey="data_catalog.no_catalogs"
      emptyDescriptionKey="data_catalog.no_catalogs_description"
      deleteConfirmTitleKey="data_catalog.delete_title"
      deleteConfirmDescriptionKey="data_catalog.delete_description"
      emptyIcon={BookOpen}
      items={catalogs}
      onNavigate={(id) => navigate(id)}
      onDelete={(id) => deleteCatalog(id)}
      renderCardBody={(catalog) => {
        const statusInfo = STATUS_BADGE[catalog.status]
        return (
          <>
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
              <BookOpen size={20} className="text-teal-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{catalog.name}</span>
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
          </>
        )
      }}
      renderCreateDialog={({ open, onOpenChange, onCreated }) => (
        <CreateCatalogDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      )}
      renderEditDialog={({ item, onOpenChange }) => (
        <CreateCatalogDialog open onOpenChange={onOpenChange} editingCatalog={item} />
      )}
    />
  )
}
