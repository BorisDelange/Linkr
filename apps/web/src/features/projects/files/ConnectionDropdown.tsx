import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConnectionStore, type ConnectionEntry } from '@/stores/connection-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useAppStore } from '@/stores/app-store'
import { cn } from '@/lib/utils'

/** Status dot colors, shared with the connections sidebar so the same database
 *  never reads as two different states depending on where it is shown. */
const statusDot: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

/**
 * The database picker shown in the IDE toolbar.
 *
 * Backed by `activeConnectionId`, the same single selection the connections
 * sidebar writes — picking a database in either place moves both. It is offered
 * for every runnable language, not just SQL: an R or Python script reaches the
 * selected database through `sql_query()`, and a notebook through its cells, so
 * gating the picker on SQL left those with no way to choose.
 */
export function ConnectionDropdown({ projectUid }: { projectUid?: string }) {
  const { t } = useTranslation()
  const { getProjectConnections, activeConnectionId, setActiveConnection } = useConnectionStore()
  // `getProjectConnections` is a plain getter that reads the data-source store
  // through getState(), so nothing here re-renders when a database connects or
  // finishes loading. Subscribing to both backing lists is what makes the dot
  // repaint — and what lets the auto-select below fire once databases arrive.
  useDataSourceStore((s) => s.dataSources)
  useConnectionStore((s) => s.customConnections)
  const setIdeDataSource = useAppStore((s) => s.setIdeDataSource)
  const savedDataSourceId = useAppStore((s) => {
    const cfg = s._projectsRaw.find((p) => p.uid === projectUid)?.config as
      | { ideDataSourceId?: string }
      | undefined
    return cfg?.ideDataSourceId
  })

  const connections = projectUid ? getProjectConnections(projectUid) : []
  const warehouseConns = connections.filter((c) => c.source === 'warehouse')
  const customConns = connections.filter((c) => c.source === 'custom')

  const hasValidSelection = activeConnectionId && connections.some((c) => c.id === activeConnectionId)
  // `connections` is rebuilt on every render, so the effects below depend on the
  // ids rather than the array itself — otherwise they re-run each render.
  const firstConnectionId = connections[0]?.id
  const connectionIds = connections.map((c) => c.id).join(',')

  // Restore the project's saved database, else fall back to the first one. Also
  // covers switching project: the active id is global, so it may still point at
  // the database of the project we just left.
  useEffect(() => {
    if (!firstConnectionId || hasValidSelection) return
    const saved = savedDataSourceId && connectionIds.split(',').includes(savedDataSourceId)
      ? savedDataSourceId
      : firstConnectionId
    setActiveConnection(saved)
  }, [firstConnectionId, connectionIds, hasValidSelection, savedDataSourceId, setActiveConnection])

  if (connections.length === 0) return null

  const handleSelect = (id: string) => {
    setActiveConnection(id)
    if (projectUid) void setIdeDataSource(projectUid, id)
  }

  const activeConn = hasValidSelection
    ? connections.find((c) => c.id === activeConnectionId)
    : connections[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" className="max-w-[160px] gap-1 text-xs">
          <Database size={11} className="shrink-0" />
          <span className="truncate">{activeConn?.name ?? t('connections.select')}</span>
          <ChevronDown size={10} className="shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {warehouseConns.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('connections.warehouse_databases')}
            </DropdownMenuLabel>
            {warehouseConns.map((c) => (
              <ConnectionMenuItem
                key={c.id}
                entry={c}
                isActive={activeConnectionId === c.id}
                onSelect={() => handleSelect(c.id)}
              />
            ))}
          </>
        )}
        {warehouseConns.length > 0 && customConns.length > 0 && <DropdownMenuSeparator />}
        {customConns.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('connections.custom_connections')}
            </DropdownMenuLabel>
            {customConns.map((c) => (
              <ConnectionMenuItem
                key={c.id}
                entry={c}
                isActive={activeConnectionId === c.id}
                onSelect={() => handleSelect(c.id)}
              />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConnectionMenuItem({
  entry,
  isActive,
  onSelect,
}: {
  entry: ConnectionEntry
  isActive: boolean
  onSelect: () => void
}) {
  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2 py-1 text-xs" title={entry.name}>
      <span className={cn('size-1.5 shrink-0 rounded-full', statusDot[entry.status] ?? 'bg-gray-400')} />
      <span className="truncate">{entry.name}</span>
      {isActive && <span className="ml-auto text-primary">✓</span>}
    </DropdownMenuItem>
  )
}
