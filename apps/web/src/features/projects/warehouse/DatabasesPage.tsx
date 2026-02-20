import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { DataSource } from '@/types'
import { Database, Link as LinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { ExportDatabaseDialog } from './databases/ExportDatabaseDialog'

export function DatabasesPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const {
    getProjectSources,
    getActiveSource,
    setActiveDataSource,
    testConnection,
    disconnectDataSource,
    mountProjectSources,
    reconnectDataSource,
  } = useDataSourceStore()
  const unlinkDataSource = useAppStore((s) => s.unlinkDataSource)

  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [sourceToUnlink, setSourceToUnlink] = useState<DataSource | null>(null)
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null)
  const [sourceToExport, setSourceToExport] = useState<DataSource | null>(null)

  // Mount all data sources for this project when entering the page
  useEffect(() => {
    if (uid) {
      mountProjectSources(uid)
    }
  }, [uid, mountProjectSources])

  const sources = uid ? getProjectSources(uid).filter((ds) => !ds.isVocabularyReference) : []
  const activeSource = uid ? getActiveSource(uid) : undefined

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
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('databases.title')}
          </h1>
          <Button onClick={() => setLinkDialogOpen(true)}>
            <LinkIcon size={16} />
            {t('app_warehouse.link_database')}
          </Button>
        </div>

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
        ) : (
          <div className="mt-6 space-y-3">
            {sources.map((ds) => (
              <DatabaseCard
                key={ds.id}
                source={ds}
                isActive={activeSource?.id === ds.id}
                onClick={() => setSelectedSource(ds)}
                onSetActive={() => uid && setActiveDataSource(uid, ds.id)}
                onTestConnection={() => testConnection(ds.id)}
                onDisconnect={() => disconnectDataSource(ds.id)}
                onReconnect={() => reconnectDataSource(ds.id)}
                onExport={() => setSourceToExport(ds)}
                onRemove={() => setSourceToUnlink(ds)}
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

      <ExportDatabaseDialog
        source={sourceToExport}
        open={!!sourceToExport}
        onOpenChange={(open) => { if (!open) setSourceToExport(null) }}
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
            <AlertDialogAction onClick={handleUnlink}>
              {t('app_warehouse.unlink')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
