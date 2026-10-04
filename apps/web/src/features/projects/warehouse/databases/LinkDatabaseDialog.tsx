import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { Database, Search } from 'lucide-react'
import { CardGrid } from '@/components/ui/card-grid'
import { DialogShell } from '@/components/ui/dialog-shell'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchInput } from '@/components/ui/search-input'
import { DatabaseCard } from './DatabaseCard'
import { localized } from '@/lib/localized'
import { foldAccents } from '@/lib/fold-accents'

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

  const [search, setSearch] = useState('')
  const projectWsId = useAppStore((s) => s._projectsRaw.find((p) => p.uid === projectUid)?.workspaceId)

  const availableSources = dataSources.filter((ds) => !linkedIds.includes(ds.id) && !ds.isVocabularyReference && (!ds.workspaceId || ds.workspaceId === projectWsId))
  const shownSources = useMemo(() => {
    const fold = (text: string) => foldAccents(text).toLowerCase()
    const words = fold(search).split(/\s+/).filter(Boolean)
    if (!words.length) return availableSources
    return availableSources.filter((ds) => {
      const haystack = fold(`${localized(ds.name, i18n.language)} ${localized(ds.description, i18n.language)} ${ds.alias}`)
      return words.every((w) => haystack.includes(w))
    })
  }, [availableSources, search, i18n.language])

  const handleLink = (dataSourceId: string) => {
    linkDataSource(projectUid, dataSourceId)
    onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch('')
        onOpenChange(next)
      }}
      kind="workbench"
      // Three CardGrid columns of 20rem need more than the workbench's 5xl.
      className="sm:max-w-6xl"
      title={t('app_warehouse.link_database_title')}
      description={t('app_warehouse.link_database_description')}
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
            <CardGrid className="min-h-0 flex-1 auto-rows-min overflow-auto pb-1">
              {shownSources.map((ds) => (
                <DatabaseCard key={ds.id} source={ds} onClick={() => handleLink(ds.id)} hideActions />
              ))}
            </CardGrid>
          )}
        </div>
      )}
    </DialogShell>
  )
}
