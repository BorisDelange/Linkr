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

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
        isActive && 'bg-accent ring-1 ring-primary/30'
      )}
    >
      <Database size={14} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{entry.name}</span>
          <span className={cn('size-2 shrink-0 rounded-full', statusDot[entry.status] ?? 'bg-gray-400')} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="uppercase">{entry.engine}</span>
          {entry.errorMessage && (
            <span className="truncate text-destructive">{entry.errorMessage}</span>
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
  const { getProjectConnections, activeConnectionId, setActiveConnection, removeCustomConnection } = useConnectionStore()
  const connections = getProjectConnections(projectUid)

  const warehouseConns = connections.filter((c) => c.source === 'warehouse')
  const customConns = connections.filter((c) => c.source === 'custom')

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

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

          <ScrollArea className="flex-1">
            <div className="space-y-6 p-5">
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
                        onSelect={() => setActiveConnection(entry.id)}
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
                  <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
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
                        onSelect={() => setActiveConnection(entry.id)}
                        onRemove={() => setDeleteTarget(entry.id)}
                      />
                    ))}
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 w-full gap-1.5"
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
