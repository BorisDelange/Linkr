import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { GatedButton } from '@/components/ui/gated-button'
import { useAppStore } from '@/stores/app-store'
import { localized } from '@/lib/localized'
import { Database, Link as LinkIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { BulkDeleteAction } from '@/components/ui/bulk-delete-action'
import { useCardSelection } from '@/components/ui/use-card-selection'
import { ListPageToolbar, type FilterGroup } from '@/components/ui/list-page-toolbar'
import { applySort, baseSortFields } from '@/lib/list-sort'
import { usePersistedSort } from '@/lib/use-persisted-sort'
import { DatabaseCard } from './databases/DatabaseCard'
import { DatabaseDetailPage } from './databases/DatabaseDetailPage'
import { LinkDatabaseDialog } from './databases/LinkDatabaseDialog'
import { useNavigate } from 'react-router-dom'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'

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
  const language = useAppStore((s) => s.language)
  const { wsUid, projectUid: uid, raw } = useResolvedParams()
  const navigate = useNavigate()
  const canEdit = useMyProjectRole(uid).atLeast('editor')
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const testConnection = useDataSourceStore((s) => s.testConnection)
  const disconnectDataSource = useDataSourceStore((s) => s.disconnectDataSource)
  const mountProjectSources = useDataSourceStore((s) => s.mountProjectSources)
  const reconnectDataSource = useDataSourceStore((s) => s.reconnectDataSource)
  const linkedIds = useAppStore((s) =>
    s._projectsRaw.find((p) => p.uid === uid)?.linkedDataSourceIds ?? EMPTY_IDS,
  )
  const unlinkDataSource = useAppStore((s) => s.unlinkDataSource)

  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [sort, setSort] = usePersistedSort('project-databases')

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
        const haystack = `${localized(ds.name, language)} ${localized(ds.description, language)}`.toLowerCase()
        if (!words.every((w) => haystack.includes(w))) return false
      }
      if (statusFilter.length && !statusFilter.includes(ds.status)) return false
      return true
    })
    return applySort(filtered, sort, {
      name: (ds) => localized(ds.name, language),
      createdAt: (ds) => ds.createdAt,
      updatedAt: (ds) => ds.updatedAt,
    })
  }, [sources, searchQuery, statusFilter, sort, language])

  const selection = useCardSelection(useMemo(() => filteredSources.map((ds) => ds.id), [filteredSources]))

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

  // Ids are shortened in the URL, so resolve the prefix against the project's
  // own linked list — the same way every other detail route does.
  const siblingIds = sources.map((ds) => ds.id)
  if (raw.dbId) {
    return (
      <DatabaseDetailPage
        source={resolveByIdPrefix(sources, raw.dbId, (ds) => ds.id)}
        onBack={() => navigate(paths.databases(wsUid ?? '', uid ?? ''))}
        readOnly
      />
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('databases.title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('databases.list_description')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {selection.active ? (
              <BulkDeleteAction
                selection={selection}
                canDelete={canEdit}
                names={(id) => {
                  const ds = filteredSources.find((s) => s.id === id)
                  return ds ? localized(ds.name, language) : id
                }}
                onDeleteMany={async (ids) => { for (const id of ids) unlinkDataSource(uid ?? '', id) }}
                actionLabelKey="app_warehouse.unlink_count"
                confirmTitleKey="app_warehouse.bulk_unlink_title"
                confirmDescriptionKey="app_warehouse.bulk_unlink_description"
              />
            ) : (
              <GatedButton allowed={canEdit} notAllowedReason={t('common.insufficient_permissions')} size="sm" className="gap-1 text-xs" onClick={() => setLinkDialogOpen(true)}>
                <LinkIcon size={14} />
                {t('app_warehouse.link_database')}
              </GatedButton>
            )}
          </div>
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
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {filteredSources.map((ds) => (
              <DatabaseCard
                key={ds.id}
                source={ds}
                onClick={() => navigate(paths.database(wsUid ?? '', uid ?? '', ds.id, siblingIds))}
                onTestConnection={() => testConnection(ds.id)}
                onDisconnect={() => disconnectDataSource(ds.id)}
                onReconnect={() => reconnectDataSource(ds.id)}
                onRemove={() => uid && unlinkDataSource(uid, ds.id)}
                // A project uses a database, it does not own it: editing, export
                // and versioning belong to the workspace that does. `deleteOnly`
                // leaves the single action a project actually has — unlink. The
                // database stays in the warehouse, hence "Unlink", not "Delete".
                deleteOnly
                removeLabelKey="app_warehouse.unlink"
                removeConfirmTitleKey="app_warehouse.unlink_confirm_title"
                removeConfirmDescriptionKey="app_warehouse.unlink_confirm_description"
                canEdit={canEdit}
                selected={selection.isSelected(ds.id)}
                onSelectClick={(e) => selection.onCardClick(e, ds.id)}
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

    </div>
  )
}
