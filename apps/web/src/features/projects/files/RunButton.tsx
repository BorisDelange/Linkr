import { useTranslation } from 'react-i18next'
import { Play, Square, ChevronDown, Loader2, Server, FileCode, TextSelect, CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConnectionStore } from '@/stores/connection-store'
import { ConnectionDropdown } from './ConnectionDropdown'
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
  const { getProjectConnections, activeConnectionId } = useConnectionStore()
  const { pythonStatus, rStatus } = useRuntimeStore()
  const canExecute = useMyProjectRole(projectUid).can('ide:execute')

  // Only to gate the Run button for SQL, which cannot run without a database.
  // The selection itself is owned by ConnectionDropdown, which also auto-selects.
  const connections = projectUid ? getProjectConnections(projectUid) : []
  const activeConn = connections.find((c) => c.id === activeConnectionId) ?? connections[0]

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

      <ConnectionDropdown projectUid={projectUid} />
    </div>
  )
}
