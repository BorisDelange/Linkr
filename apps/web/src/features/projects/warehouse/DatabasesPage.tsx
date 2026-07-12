import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { useAppStore } from '@/stores/app-store'
import type { DataSource } from '@/types'
import { Database, Link as LinkIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { ListPageToolbar, type FilterGroup, type SortState } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
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
import { DatabaseCard } from './databases/DatabaseCard'
import { DatabaseDetailSheet } from './databases/DatabaseDetailSheet'
import { LinkDatabaseDialog } from './databases/LinkDatabaseDialog'
import { useResolvedParams } from '@/hooks/use-resolved-params'

const EMPTY_IDS: string[] = []

const DATA_SOURCE_STATUSES = ['connected', 'disconnected', 'error', 'configuring'] as const
const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-slate-400',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

export function DatabasesPage() {
  const { t } = useTranslation()
  const { projectUid: uid } = useResolvedParams()
  const canEdit = useMyProjectRole(uid).atLeast('editor')
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const setActiveDataSource = useDataSourceStore((s) => s.setActiveDataSource)
  const testConnection = useDataSourceStore((s) => s.testConnection)
  const disconnectDataSource = useDataSourceStore((s) => s.disconnectDataSource)
  const mountProjectSources = useDataSourceStore((s) => s.mountProjectSources)
  const reconnectDataSource = useDataSourceStore((s) => s.reconnectDataSource)
  const activeDataSourceIds = useDataSourceStore((s) => s.activeDataSourceIds)
  const linkedIds = useAppStore((s) =>
    s._projectsRaw.find((p) => p.uid === uid)?.linkedDataSourceIds ?? EMPTY_IDS,
  )
  const unlinkDataSource = useAppStore((s) => s.unlinkDataSource)

  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [sourceToUnlink, setSourceToUnlink] = useState<DataSource | null>(null)
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [sort, setSort] = useState<SortState | null>(null)

  // Mount all data sources for this project when entering the page
  useEffect(() => {
    if (uid) {
      mountProjectSources(uid)
    }
  }, [uid, mountProjectSources])

  const sources = useMemo(() => {
    if (!uid) return []
    return dataSources.filter((ds) => linkedIds.includes(ds.id) && !ds.isVocabularyReference)
  }, [uid, dataSources, linkedIds])

  const filteredSources = useMemo(() => {
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = sources.filter((ds) => {
      if (words.length) {
        const haystack = `${ds.name} ${ds.description ?? ''}`.toLowerCase()
        if (!words.every((w) => haystack.includes(w))) return false
      }
      if (statusFilter.length && !statusFilter.includes(ds.status)) return false
      return true
    })
    return applySort(filtered, sort, {
      name: (ds) => ds.name,
      createdAt: (ds) => ds.createdAt,
      updatedAt: (ds) => ds.updatedAt,
    })
  }, [sources, searchQuery, statusFilter, sort])

  const filterGroups: FilterGroup[] = [
    {
      key: 'status',
      label: t('databases.status'),
      selected: statusFilter,
      onChange: setStatusFilter,
      options: DATA_SOURCE_STATUSES.map((s) => ({
        value: s,
        label: t(`databases.status_${s}`),
        dotClass: STATUS_DOT[s],
      })),
    },
  ]

  const activeSource = useMemo(() => {
    if (!uid) return undefined
    const activeId = activeDataSourceIds[uid]
    if (activeId) {
      const ds = dataSources.find((d) => d.id === activeId && d.status === 'connected')
      if (ds) return ds
    }
    return sources.find(
      (ds) => !!ds.schemaMapping?.patientTable && ds.status === 'connected',
    )
  }, [uid, activeDataSourceIds, dataSources, sources])

  // Auto-select first connected mapped source if none is active
  useEffect(() => {
    if (!uid || activeSource) return
    const firstMapped = sources.find(
      (ds) => ds.status === 'connected' && !!ds.schemaMapping?.patientTable,
    )
    if (firstMapped) {
      setActiveDataSource(uid, firstMapped.id)
    }
  }, [uid, activeSource, sources, setActiveDataSource])

  // Keep selectedSource in sync with store data
  const currentSelectedSource = selectedSource
    ? sources.find((ds) => ds.id === selectedSource.id) ?? null
    : null

  const handleUnlink = () => {
    if (sourceToUnlink && uid) {
      unlinkDataSource(uid, sourceToUnlink.id)
      if (selectedSource?.id === sourceToUnlink.id) {
        setSelectedSource(null)
      }
      setSourceToUnlink(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('databases.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('databases.list_description')}</p>
          </div>
          <GatedButton allowed={canEdit} notAllowedReason={t('common.insufficient_permissions')} size="sm" className="shrink-0 gap-1 text-xs" onClick={() => setLinkDialogOpen(true)}>
            <LinkIcon size={14} />
            {t('app_warehouse.link_database')}
          </GatedButton>
        </div>

        {sources.length > 0 && (
          <ListPageToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={t('databases.search_placeholder')}
            filterGroups={filterGroups}
            sort={{ options: baseSortFields(t), value: sort, onChange: setSort }}
          />
        )}

        {sources.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Database size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('databases.no_databases')}
              </p>
              <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                {t('databases.no_databases_description')}
              </p>
            </div>
          </Card>
        ) : filteredSources.length === 0 ? (
          <div className="mt-6 flex flex-col items-center py-8">
            <Database size={24} className="text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">{t('databases.no_results')}</p>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {filteredSources.map((ds) => (
              <DatabaseCard
                key={ds.id}
                source={ds}
                isActive={activeSource?.id === ds.id}
                onClick={() => setSelectedSource(ds)}
                onSetActive={() => uid && setActiveDataSource(uid, ds.id)}
                onTestConnection={() => testConnection(ds.id)}
                onDisconnect={() => disconnectDataSource(ds.id)}
                onReconnect={() => reconnectDataSource(ds.id)}
                onRemove={() => setSourceToUnlink(ds)}
                canEdit={canEdit}
              />
            ))}
          </div>
        )}
      </div>

      {uid && (
        <LinkDatabaseDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          projectUid={uid}
        />
      )}

      {/* Detail Sheet */}
      <DatabaseDetailSheet
        source={currentSelectedSource}
        open={!!currentSelectedSource}
        onOpenChange={(open) => { if (!open) setSelectedSource(null) }}
      />

      {/* Unlink confirmation dialog */}
      <AlertDialog
        open={!!sourceToUnlink}
        onOpenChange={(open) => { if (!open) setSourceToUnlink(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('app_warehouse.unlink_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_warehouse.unlink_confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={handleUnlink}>
              {t('app_warehouse.unlink')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
