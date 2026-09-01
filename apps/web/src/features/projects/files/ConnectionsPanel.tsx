import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Plus, Trash2, Warehouse } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { useConnectionStore, type ConnectionEntry } from '@/stores/connection-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { AddConnectionDialog } from './AddConnectionDialog'
import { cn } from '@/lib/utils'

interface ConnectionsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
}

const statusDot: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

/** Display label for a database engine (proper casing, not raw uppercase). */
const engineLabels: Record<string, string> = {
  duckdb: 'DuckDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
}

function ConnectionItem({
  entry,
  isActive,
  onSelect,
  onRemove,
}: {
  entry: ConnectionEntry
  isActive: boolean
  onSelect: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()

  // `errorMessage` may hold a sentinel rather than a sentence: entity-io has no
  // i18n, so it marks an import that carried no data and leaves the wording to
  // whoever displays it. Rendered raw it shows up as "linkr:db-imported-without-data".
  const errorText = entry.errorMessage === DB_ERROR_NO_DATA_ON_IMPORT
    ? t('databases.imported_without_data')
    : entry.errorMessage

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
        isActive && 'bg-accent ring-1 ring-primary/30'
      )}
    >
      <Database size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{entry.name}</span>
          <span className={cn('size-2 shrink-0 rounded-full', statusDot[entry.status] ?? 'bg-gray-400')} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{engineLabels[entry.engine] ?? entry.engine}</span>
          {entry.errorMessage && (
            <span className="min-w-0 truncate text-destructive" title={errorText}>{errorText}</span>
          )}
        </div>
      </div>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Trash2 size={12} />
          <span className="sr-only">{t('connections.remove')}</span>
        </Button>
      )}
    </button>
  )
}

export function ConnectionsPanel({ open, onOpenChange, projectUid }: ConnectionsPanelProps) {
  const { t } = useTranslation()
  const canWrite = useMyProjectRole(projectUid).can('ide:write')
  const { getProjectConnections, activeConnectionId, setActiveConnection, removeCustomConnection } = useConnectionStore()
  // Same reason as ConnectionDropdown: getProjectConnections reads the
  // data-source store via getState(), so subscribe to keep the dots live.
  useDataSourceStore((s) => s.dataSources)
  useConnectionStore((s) => s.customConnections)
  const connections = getProjectConnections(projectUid)

  const warehouseConns = connections.filter((c) => c.source === 'warehouse')
  const customConns = connections.filter((c) => c.source === 'custom')

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Persist alongside the in-memory selection, as the toolbar dropdown does:
  // the two write the same active connection, so both must remember it.
  const setIdeDataSource = useAppStore((s) => s.setIdeDataSource)
  const handleSelect = (id: string) => {
    setActiveConnection(id)
    void setIdeDataSource(projectUid, id)
  }

  const handleRemove = async () => {
    if (!deleteTarget) return
    await removeCustomConnection(deleteTarget)
    setDeleteTarget(null)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-[380px] flex-col gap-0 p-0 sm:max-w-[380px]">
          <SheetHeader className="border-b px-5 py-4">
            <SheetTitle>{t('connections.title')}</SheetTitle>
          </SheetHeader>

          <ScrollArea className="w-full flex-1">
            {/* w-[380px]/max-w-full pins the width: Radix's viewport wraps content
                in a display:table element that otherwise grows to the widest
                child (e.g. a long error string), overflowing the panel. */}
            <div className="w-[380px] max-w-full space-y-6 p-5">
              {/* Warehouse databases */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Warehouse size={14} className="text-teal-500" />
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('connections.warehouse_databases')}
                  </h3>
                </div>
                {warehouseConns.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    {t('connections.no_warehouse')}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {warehouseConns.map((entry) => (
                      <ConnectionItem
                        key={entry.id}
                        entry={entry}
                        isActive={activeConnectionId === entry.id}
                        onSelect={() => handleSelect(entry.id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="h-px bg-border" />

              {/* Custom connections */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Database size={14} className="text-violet-500" />
                  <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('connections.custom_connections')}
                  </h3>
                  <Badge variant="secondary" className="ml-auto px-1.5 py-0">
                    {customConns.length}
                  </Badge>
                </div>
                {customConns.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    {t('connections.no_custom')}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {customConns.map((entry) => (
                      <ConnectionItem
                        key={entry.id}
                        entry={entry}
                        isActive={activeConnectionId === entry.id}
                        onSelect={() => handleSelect(entry.id)}
                        onRemove={canWrite ? () => setDeleteTarget(entry.id) : undefined}
                      />
                    ))}
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 w-full gap-1.5 text-foreground"
                  disabled={!canWrite}
                  onClick={() => setAddDialogOpen(true)}
                >
                  <Plus size={14} />
                  {t('connections.add_connection')}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        projectUid={projectUid}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connections.remove_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connections.remove_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t('connections.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
