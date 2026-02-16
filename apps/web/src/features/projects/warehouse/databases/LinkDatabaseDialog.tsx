import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import type { DatabaseConnectionConfig } from '@/types'
import { Database, Link, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AddDatabaseDialog } from './AddDatabaseDialog'

interface LinkDatabaseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
}

export function LinkDatabaseDialog({ open, onOpenChange, projectUid }: LinkDatabaseDialogProps) {
  const { t } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const linkedIds = useAppStore((s) =>
    s._projectsRaw.find((p) => p.uid === projectUid)?.linkedDataSourceIds ?? [],
  )
  const linkDataSource = useAppStore((s) => s.linkDataSource)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const availableSources = dataSources.filter((ds) => !linkedIds.includes(ds.id))

  const handleLink = (dataSourceId: string) => {
    linkDataSource(projectUid, dataSourceId)
    onOpenChange(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('app_warehouse.link_database_title')}</DialogTitle>
            <DialogDescription>{t('app_warehouse.link_database_description')}</DialogDescription>
          </DialogHeader>

          {availableSources.length === 0 ? (
            <Card className="mt-2">
              <div className="flex flex-col items-center py-8">
                <Database size={32} className="text-muted-foreground" />
                <p className="mt-3 text-sm font-medium text-foreground">
                  {t('app_warehouse.no_available_databases')}
                </p>
                <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground">
                  {t('app_warehouse.no_available_databases_description')}
                </p>
              </div>
            </Card>
          ) : (
            <div className="mt-2 max-h-64 space-y-2 overflow-auto">
              {availableSources.map((ds) => {
                const config = ds.connectionConfig as DatabaseConnectionConfig
                const engine = config.engine
                  ? config.engine.charAt(0).toUpperCase() + config.engine.slice(1)
                  : ds.sourceType
                return (
                  <button
                    key={ds.id}
                    onClick={() => handleLink(ds.id)}
                    className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
                      <Database size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{ds.name}</p>
                      <p className="text-xs text-muted-foreground">{engine}</p>
                    </div>
                    <Link size={14} className="shrink-0 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          )}

          <div className="mt-2 flex justify-end">
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
          </div>
        </DialogContent>
      </Dialog>

      <AddDatabaseDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectUid={projectUid}
      />
    </>
  )
}
