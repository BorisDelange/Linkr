import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { DatabaseConnectionConfig } from '@/types'
import { Database, Link, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchInput } from '@/components/ui/search-input'
import { AddDatabaseDialog } from './AddDatabaseDialog'
import { localized } from '@/lib/localized'

interface LinkDatabaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
}

const EMPTY_IDS: string[] = []

export function LinkDatabaseDialog({ open, onOpenChange, projectUid }: LinkDatabaseDialogProps) {
  const { t, i18n } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const linkedIds = useAppStore((s) =>
    s._projectsRaw.find((p) => p.uid === projectUid)?.linkedDataSourceIds ?? EMPTY_IDS,
  )
  const linkDataSource = useAppStore((s) => s.linkDataSource)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const projectWsId = useAppStore((s) => s._projectsRaw.find((p) => p.uid === projectUid)?.workspaceId)

  const availableSources = dataSources.filter((ds) => !linkedIds.includes(ds.id) && !ds.isVocabularyReference && (!ds.workspaceId || ds.workspaceId === projectWsId))
  const shownSources = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return availableSources
    return availableSources.filter((ds) => {
      const haystack = `${localized(ds.name, i18n.language)} ${localized(ds.description, i18n.language)} ${ds.alias}`.toLowerCase()
      return words.every((w) => haystack.includes(w))
    })
  }, [availableSources, search, i18n.language])

  const handleLink = (dataSourceId: string) => {
    linkDataSource(projectUid, dataSourceId)
    onOpenChange(false)
  }

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={(next) => {
          if (!next) setSearch('')
          onOpenChange(next)
        }}
        kind="workbench"
        title={t('app_warehouse.link_database_title')}
        description={t('app_warehouse.link_database_description')}
        footerExtra={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onOpenChange(false)
              setCreateDialogOpen(true)
            }}
            className="gap-1.5"
          >
            <Plus size={14} />
            {t('app_warehouse.create_and_link')}
          </Button>
        }
      >
        {availableSources.length === 0 ? (
          <EmptyState
            icon={Database}
            title={t('app_warehouse.no_available_databases')}
            description={t('app_warehouse.no_available_databases_description')}
          />
        ) : (
          <div className="flex h-full flex-col gap-3">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('databases.search_placeholder')}
              className="shrink-0"
              autoFocus
            />
            {shownSources.length === 0 ? (
              <EmptyState icon={Search} title={t('app_warehouse.no_matching_databases')} variant="filtered" />
            ) : (
              <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-auto pb-1 sm:grid-cols-2 lg:grid-cols-3">
                {shownSources.map((ds) => {
                  const config = ds.connectionConfig as DatabaseConnectionConfig
                  const engine = config.engine
                    ? config.engine.charAt(0).toUpperCase() + config.engine.slice(1)
                    : ds.sourceType
                  const description = localized(ds.description, i18n.language)
                  return (
                    <button
                      key={ds.id}
                      type="button"
                      onClick={() => handleLink(ds.id)}
                      className="flex min-h-24 flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
                    >
                      <div className="flex w-full items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
                          <Database size={16} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{localized(ds.name, i18n.language)}</p>
                          <p className="text-xs text-muted-foreground">{engine}</p>
                        </div>
                        <Link size={14} className="shrink-0 text-muted-foreground" />
                      </div>
                      {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </DialogShell>

      <AddDatabaseDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectUid={projectUid}
      />
    </>
  )
}
