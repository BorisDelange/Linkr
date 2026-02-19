import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, BookOpen, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCatalogStore } from '@/stores/catalog-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CatalogConfigTab } from './CatalogConfigTab'
import { CatalogDataTab } from './CatalogDataTab'
import { CatalogAnonymizationTab } from './CatalogAnonymizationTab'
import { CatalogDcatTab } from './CatalogDcatTab'
import { CatalogExportTab } from './CatalogExportTab'
import type { CatalogStatus } from '@/types'

const STATUS_BADGE: Record<CatalogStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  draft: { variant: 'secondary', label: 'data_catalog.status_draft' },
  computing: { variant: 'default', label: 'data_catalog.status_computing' },
  ready: { variant: 'default', label: 'data_catalog.status_ready' },
  error: { variant: 'destructive', label: 'data_catalog.status_error' },
}

interface Props {
  catalogId: string
}

export function CatalogDetailPage({ catalogId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { catalogs, catalogsLoaded, loadCatalogs, activeResultCache, loadResultCache } = useCatalogStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { activeWorkspaceId } = useWorkspaceStore()
  const catalogListPath = `/workspaces/${activeWorkspaceId}/warehouse/catalog`

  useEffect(() => {
    if (!catalogsLoaded) loadCatalogs()
  }, [catalogsLoaded, loadCatalogs])

  // Load cached results on mount
  useEffect(() => {
    loadResultCache(catalogId)
  }, [catalogId, loadResultCache])

  const catalog = catalogs.find((c) => c.id === catalogId)

  if (!catalog) {
    return (
      <div className="h-full overflow-auto">
        <div className="px-6 py-6">
          <Button variant="ghost" size="sm" onClick={() => navigate(catalogListPath)}>
            <ArrowLeft size={14} />
            {t('data_catalog.back_to_list')}
          </Button>
          <Card className="mt-4">
            <div className="flex flex-col items-center py-12">
              <BookOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium">{t('data_catalog.not_found')}</p>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  const statusInfo = STATUS_BADGE[catalog.status]
  const sourceName = dataSources.find((ds) => ds.id === catalog.dataSourceId)?.name ?? '—'

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(catalogListPath)}>
            <ArrowLeft size={14} />
          </Button>
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/10">
            <BookOpen size={20} className="text-teal-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-bold">{catalog.name}</h1>
              {catalog.status === 'error' && catalog.lastError ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant={statusInfo.variant} className="cursor-help text-[10px]">
                        {t(statusInfo.label)}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-sm">
                      <p className="text-xs">{catalog.lastError}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <Badge variant={statusInfo.variant} className="text-[10px]">
                  {t(statusInfo.label)}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database size={12} />
              <span>{sourceName}</span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="config" className="mt-6">
          <TabsList>
            <TabsTrigger value="config">{t('data_catalog.tab_config')}</TabsTrigger>
            <TabsTrigger value="data">{t('data_catalog.tab_data')}</TabsTrigger>
            <TabsTrigger value="anonymization">{t('data_catalog.tab_anonymization')}</TabsTrigger>
            <TabsTrigger value="dcat">{t('data_catalog.tab_dcat')}</TabsTrigger>
            <TabsTrigger value="export">{t('data_catalog.tab_export')}</TabsTrigger>
          </TabsList>

          <TabsContent value="config" className="mt-4">
            <CatalogConfigTab catalog={catalog} />
          </TabsContent>

          <TabsContent value="data" className="mt-4">
            {activeResultCache ? (
              <CatalogDataTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="anonymization" className="mt-4">
            {activeResultCache ? (
              <CatalogAnonymizationTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="dcat" className="mt-4">
            <CatalogDcatTab catalog={catalog} cache={activeResultCache} />
          </TabsContent>

          <TabsContent value="export" className="mt-4">
            {activeResultCache ? (
              <CatalogExportTab catalog={catalog} cache={activeResultCache} />
            ) : (
              <Card>
                <div className="flex flex-col items-center py-12">
                  <BookOpen size={40} className="text-muted-foreground" />
                  <p className="mt-4 text-sm font-medium">{t('data_catalog.no_data')}</p>
                  <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                    {t('data_catalog.no_data_description')}
                  </p>
                </div>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
