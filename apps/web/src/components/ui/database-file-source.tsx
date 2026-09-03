import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, FolderOpen, Laptop, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RequiredMark } from '@/components/ui/required-mark'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { ServerPathPickerDialog } from '@/components/ui/server-path-picker-dialog'
import { useTallestPanel } from '@/hooks/use-tallest-panel'
import { isServerMode } from '@/lib/api-client'
import { cn } from '@/lib/utils'

/** Where a file-backed database gets its data. `upload` copies bytes from the
 *  user's machine; `server` points at data already on the server and copies
 *  nothing — the only workable option for a warehouse too big to upload, and the
 *  server-side analogue of the front-only zero-copy FS Access handles. */
export type FileOrigin = 'upload' | 'server'

/** The inactive origin, kept mounted so it can be measured: absolute so it adds
 *  no height, invisible so nothing inside it paints (a drop zone would otherwise
 *  show through), pointer-events-none so its hidden file input can't be hit. */
const HIDDEN_PANEL = 'pointer-events-none invisible absolute inset-x-0 top-0'

interface OriginChoiceProps {
  value: FileOrigin
  onChange: (origin: FileOrigin) => void
}

/** Only rendered in server mode: a client-only build has no server to browse. */
function OriginChoice({ value, onChange }: OriginChoiceProps) {
  const { t } = useTranslation()
  const option = (origin: FileOrigin, icon: ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(origin)}
      className={cn(
        'flex flex-1 items-center gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors',
        value === origin ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-accent',
      )}
    >
      {icon}
      {label}
    </button>
  )
  return (
    <div className="space-y-2">
      <Label>{t('databases.file_origin_label')}</Label>
      <div className="flex gap-2">
        {option('upload', <Laptop size={14} />, t('databases.file_origin_upload'))}
        {option('server', <Server size={14} />, t('databases.file_origin_server'))}
      </div>
    </div>
  )
}

interface Props {
  /** Which workspace's `databases:write` authorizes the browse. */
  workspaceId: string
  origin: FileOrigin
  onOriginChange: (origin: FileOrigin) => void
  /** A Parquet source is a folder; DuckDB/SQLite is a single file. */
  expect: 'file' | 'dir'
  /** Display filter for the picker, e.g. ['.duckdb']. */
  extensions?: string[]
  serverPath: string
  onServerPathChange: (path: string) => void
  /** The upload UI, rendered when the chosen origin is `upload`. */
  children: ReactNode
}

/** The "where does this database's data come from" field, shared by the two
 *  add-database dialogs (warehouse and IDE connections) so the server-path option
 *  exists once rather than in each of them. */
export function DatabaseFileSource({
  workspaceId,
  origin,
  onOriginChange,
  expect,
  extensions,
  serverPath,
  onServerPathChange,
  children,
}: Props) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  const { containerProps, measuredPanelProps } = useTallestPanel()

  // Client-only: there is no server filesystem to point at, so the choice would
  // be a dead control. Render the upload UI exactly as before.
  if (!isServerMode()) return <>{children}</>

  return (
    <div className="space-y-3">
      <OriginChoice value={origin} onChange={onOriginChange} />

      {/* Both origins are measured and the taller one sets the height, so
          switching between them never resizes the dialog. Matching the two by
          hand is not enough: each side changes height on its own (a chosen path
          row, a file list, the Parquet tables summary), so only measuring holds. */}
      <div className="relative" {...containerProps}>
        <div
          {...measuredPanelProps('upload')}
          inert={origin !== 'upload'}
          className={cn(origin !== 'upload' && HIDDEN_PANEL)}
        >
          {children}
        </div>
        <div
          {...measuredPanelProps('server')}
          inert={origin !== 'server'}
          className={cn('space-y-2', origin !== 'server' && HIDDEN_PANEL)}
        >
          <Label>
            {t(expect === 'dir' ? 'databases.server_folder' : 'databases.server_file')}
            <RequiredMark />
          </Label>
          {serverPath ? (
            <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
              {expect === 'dir' ? (
                <FolderOpen size={14} className="shrink-0 text-amber-500" />
              ) : (
                <Database size={14} className="shrink-0 text-violet-500" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={serverPath}>
                {serverPath}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
                {t('project_folders.change')}
              </Button>
              <button
                type="button"
                onClick={() => onServerPathChange('')}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <FileDropZone
              icon={<Server size={20} className="text-muted-foreground" />}
              label={t('databases.server_path_hint')}
              hint={extensions?.join(', ')}
              onClick={() => setPickerOpen(true)}
            />
          )}
        </div>
      </div>

      {pickerOpen && (
        <ServerPathPickerDialog
          open
          mode={expect === 'dir' ? 'folder' : 'file'}
          scope={{ kind: 'workspace', workspaceId }}
          extensions={extensions}
          initialPath={serverPath || undefined}
          onClose={() => setPickerOpen(false)}
          onPick={onServerPathChange}
        />
      )}
    </div>
  )
}
