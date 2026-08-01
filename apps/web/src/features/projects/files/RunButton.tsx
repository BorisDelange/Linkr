import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, Square, ChevronDown, Database, Loader2, Server, FileCode, TextSelect, CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConnectionStore, type ConnectionEntry } from '@/stores/connection-store'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useShortcutStore } from '@/stores/shortcut-store'
import { useMyProjectRole } from '@/hooks/use-context-role'
import { isServerMode } from '@/lib/api-client'
import { comboToString } from '@/lib/format-shortcut'

interface RunButtonProps {
  onRunFile: () => void
  onRunSelection: () => void
  onRunLine: () => void
  onStop: () => void
  /** Run the whole file as a background job (server mode only). */
  onRunFileAsJob?: () => void
  /** Whether the current file is SQL (shows connection selector). */
  isSql?: boolean
  /** Whether code is currently executing. */
  isExecuting?: boolean
  /** Language of the current file (for runtime status). */
  language?: 'python' | 'r'
  projectUid?: string
}

export function RunButton({
  onRunFile,
  onRunSelection,
  onRunLine,
  onStop,
  onRunFileAsJob,
  isSql,
  isExecuting,
  language,
  projectUid,
}: RunButtonProps) {
  const { t } = useTranslation()
  const serverMode = isServerMode()
  // Show each item's keyboard shortcut at the end of its row.
  const runFileKey = useShortcutStore((s) => comboToString(s.shortcuts.run_file.binding))
  const runLineKey = useShortcutStore((s) => comboToString(s.shortcuts.run_selection_or_line.binding))
  const runAsJobKey = useShortcutStore((s) => comboToString(s.shortcuts.run_file_as_job.binding))
  const { getProjectConnections, activeConnectionId, setActiveConnection } = useConnectionStore()
  const { pythonStatus, rStatus } = useRuntimeStore()
  const canExecute = useMyProjectRole(projectUid).can('ide:execute')

  const connections = projectUid ? getProjectConnections(projectUid) : []
  const warehouseConns = connections.filter((c) => c.source === 'warehouse')
  const customConns = connections.filter((c) => c.source === 'custom')

  // Auto-select first connection if none is active or current one is gone
  const hasValidSelection = activeConnectionId && connections.some((c) => c.id === activeConnectionId)
  useEffect(() => {
    if (isSql && connections.length > 0 && !hasValidSelection) {
      setActiveConnection(connections[0].id)
    }
  }, [isSql, connections, hasValidSelection, setActiveConnection])

  const activeConn = hasValidSelection
    ? connections.find((c) => c.id === activeConnectionId)
    : connections[0]

  const runtimeStatus = language === 'python' ? pythonStatus : language === 'r' ? rStatus : 'idle'
  const isLoading = runtimeStatus === 'loading'
  const canRun = (isSql ? !!activeConn : true) && canExecute
  const isDisabled = !canRun || isExecuting || isLoading

  const getButtonLabel = () => {
    if (isExecuting) return t('files.running')
    if (isLoading) {
      return language === 'python' ? t('runtime.loading_python') : t('runtime.loading_r')
    }
    return t('files.run')
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Run / Stop button */}
      <div className="flex">
        {isExecuting ? (
          <Button
            size="xs"
            variant="destructive"
            className="gap-1"
            onClick={onStop}
          >
            <Square size={12} />
            {t('files.stop')}
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              className="gap-1 rounded-r-none"
              onClick={onRunFile}
              disabled={isDisabled}
            >
              {isLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              {getButtonLabel()}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="xs"
                  className="rounded-l-none border-l border-primary-foreground/20 px-1"
                  disabled={isDisabled}
                >
                  <ChevronDown size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={onRunFile} disabled={isDisabled} className="gap-2 text-xs">
                  <FileCode size={13} className="text-muted-foreground" />
                  {t('files.run_file')}
                  {runFileKey && <DropdownMenuShortcut>{runFileKey}</DropdownMenuShortcut>}
                </DropdownMenuItem>
                {/* run_selection_or_line (⌘Enter) covers BOTH: run selection when
                    there's a selection, else the current line — so show it on both. */}
                <DropdownMenuItem onClick={onRunSelection} disabled={isDisabled} className="gap-2 text-xs">
                  <TextSelect size={13} className="text-muted-foreground" />
                  {t('files.run_selection')}
                  {runLineKey && <DropdownMenuShortcut>{runLineKey}</DropdownMenuShortcut>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRunLine} disabled={isDisabled} className="gap-2 text-xs">
                  <CornerDownLeft size={13} className="text-muted-foreground" />
                  {t('files.run_line')}
                  {runLineKey && <DropdownMenuShortcut>{runLineKey}</DropdownMenuShortcut>}
                </DropdownMenuItem>
                {/* Batch run is server-only (a fresh process on the server); hide
                    it in front-only/WASM mode and for SQL files. */}
                {onRunFileAsJob && !isSql && serverMode && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={onRunFileAsJob}
                      disabled={!canRun}
                      className="gap-2 text-xs"
                      title={t('files.run_as_job_hint')}
                    >
                      <Server size={13} className="text-muted-foreground" />
                      {t('files.run_as_job')}
                      {runAsJobKey && <DropdownMenuShortcut>{runAsJobKey}</DropdownMenuShortcut>}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Connection selector — only for SQL files */}
      {isSql && connections.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" className="gap-1 max-w-[160px] text-[11px]">
              <Database size={11} className="shrink-0" />
              <span className="truncate">
                {activeConn?.name ?? t('connections.select')}
              </span>
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
                    onSelect={() => setActiveConnection(c.id)}
                  />
                ))}
              </>
            )}
            {warehouseConns.length > 0 && customConns.length > 0 && (
              <DropdownMenuSeparator />
            )}
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
                    onSelect={() => setActiveConnection(c.id)}
                  />
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
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
  const statusColor = entry.status === 'connected'
    ? 'bg-green-500'
    : entry.status === 'error'
      ? 'bg-red-500'
      : 'bg-gray-400'

  return (
    <DropdownMenuItem onClick={onSelect} className="gap-2 py-1 text-xs" title={entry.name}>
      <span className={`size-1.5 shrink-0 rounded-full ${statusColor}`} />
      <span className="truncate">{entry.name}</span>
      {isActive && <span className="ml-auto text-primary">✓</span>}
    </DropdownMenuItem>
  )
}
