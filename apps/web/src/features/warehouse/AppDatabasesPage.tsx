import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { DataSource } from '@/types'
import { Database, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import { DatabaseCard } from '@/features/projects/warehouse/databases/DatabaseCard'
import { AddDatabaseDialog } from '@/features/projects/warehouse/databases/AddDatabaseDialog'
import { DatabaseDetailSheet } from '@/features/projects/warehouse/databases/DatabaseDetailSheet'

export function AppDatabasesPage() {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { testConnection, removeDataSource, reconnectDataSource } = useDataSourceStore()
  const projects = useAppStore((s) => s._projectsRaw)
  const language = useAppStore((s) => s.language)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [sourceToRemove, setSourceToRemove] = useState<DataSource | null>(null)
  const [selectedSource, setSelectedSource] = useState<DataSource | null>(null)
  const [sourceToEdit, setSourceToEdit] = useState<DataSource | null>(null)

  const currentSelectedSource = selectedSource
    ? dataSources.find((ds) => ds.id === selectedSource.id) ?? null
    : null

  const getLinkedProjects = (dataSourceId: string) =>
    projects.filter((p) => p.linkedDataSourceIds?.includes(dataSourceId))

  const handleRemove = () => {
    if (sourceToRemove) {
      removeDataSource(sourceToRemove.id)
      if (selectedSource?.id === sourceToRemove.id) {
        setSelectedSource(null)
      }
      setSourceToRemove(null)
    }
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('app_warehouse.nav_databases')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('app_warehouse.databases_description', { count: dataSources.length })}
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            {t('databases.add')}
          </Button>
        </div>

      {dataSources.length === 0 ? (
        <Card className="mt-4">
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
        <div className="mt-4 space-y-3">
          {dataSources.map((ds) => {
            const linkedProjects = getLinkedProjects(ds.id)
            return (
              <div key={ds.id} className="space-y-1">
                <DatabaseCard
                  source={ds}
                  onClick={() => setSelectedSource(ds)}
                  onTestConnection={() => testConnection(ds.id)}
                  onReconnect={() => reconnectDataSource(ds.id)}
                  onEdit={() => setSourceToEdit(ds)}
                  onRemove={() => setSourceToRemove(ds)}
                />
                {linkedProjects.length > 0 && (
                  <div className="flex items-center gap-1.5 pl-4">
                    <span className="text-[10px] text-muted-foreground">
                      {t('app_warehouse.linked_projects')}:
                    </span>
                    {linkedProjects.map((p) => {
                      const name = p.name[language] ?? p.name['en'] ?? Object.values(p.name)[0] ?? ''
                      return (
                        <Badge key={p.uid} variant="secondary" className="text-[10px] px-1.5 py-0">
                          {name}
                        </Badge>
                      )
                    })}
                  </div>
                )}
                {linkedProjects.length === 0 && (
                  <p className="pl-4 text-[10px] text-muted-foreground/60">
                    {t('app_warehouse.no_linked_projects')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <AddDatabaseDialog
        open={dialogOpen || !!sourceToEdit}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false)
            setSourceToEdit(null)
          } else {
            setDialogOpen(true)
          }
        }}
        editingSource={sourceToEdit}
      />

      <DatabaseDetailSheet
        source={currentSelectedSource}
        open={!!currentSelectedSource}
        onOpenChange={(open) => { if (!open) setSelectedSource(null) }}
      />

      <AlertDialog
        open={!!sourceToRemove}
        onOpenChange={(open) => { if (!open) setSourceToRemove(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('app_warehouse.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('app_warehouse.delete_confirm_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleRemove}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  )
}
