import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, FolderOpen, Server, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { TruncatedText } from '@/components/ui/truncated-text'
import { ServerPathPickerDialog } from '@/components/ui/server-path-picker-dialog'
import { isServerMode } from '@/lib/api-client'
import type { FsScope } from '@/lib/api/fs-browser'

/** Where a file comes from. `upload` sends bytes from the user's machine;
 *  `server` uses a file already on the server — for a database it copies
 *  nothing (the only workable option for a warehouse too big to upload, and the
 *  server-side analogue of the front-only zero-copy FS Access handles); for a
 *  dataset or an IDE file the server copies it in itself. */
export type FileOrigin = 'upload' | 'server'

interface Props {
  /** Which authority the browse answers to (see `FsScope`). */
  scope: FsScope
  /** Controlled origin, for a form that keeps the chosen path on screen (a
   *  database). Omit it when the caller acts on the pick at once and moves on
   *  (a dataset import, an IDE upload): the origin then follows `serverPath`. */
  origin?: FileOrigin
  onOriginChange?: (origin: FileOrigin) => void
  /** A Parquet source is a folder; DuckDB/SQLite is a single file. */
  expect: 'file' | 'dir'
  /** Display filter for the picker, e.g. ['.duckdb']. */
  extensions?: string[]
  serverPath: string
  onServerPathChange: (path: string) => void
  /** True once files have been picked from the machine, so the upload side takes
   *  the row and the server zone steps aside. */
  hasUpload?: boolean
  /** The upload UI — its own label and drop zone. */
  children: ReactNode
}

/**
 * Where a file comes from — the user's machine or the server — shared by every
 * dialog that takes a file in server mode: the two add-database dialogs
 * (warehouse and IDE connections), the dataset import and the IDE upload.
 *
 * The two origins sit **side by side** rather than behind a mode switch: they are
 * alternatives of the same kind, so showing both makes the server option
 * discoverable and costs one click instead of two. Once either side holds
 * something, it takes the full row and the other steps aside — the choice has
 * been made, and a live picker for the road not taken is only noise.
 */
export function FileSource({
  scope,
  origin: originProp,
  onOriginChange = () => {},
  expect,
  extensions,
  serverPath,
  onServerPathChange,
  hasUpload,
  children,
}: Props) {
  const { t } = useTranslation()
  const origin = originProp ?? (serverPath ? 'server' : 'upload')
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Set by onPick, read by onClose — both fire in the same tick, so state would
   *  still hold its pre-pick value there. */
  const pickedRef = useRef(false)

  // Client-only: there is no server filesystem to point at, so the second zone
  // would be a dead control. Render the upload UI exactly as before.
  if (!isServerMode()) return <>{children}</>

  const openPicker = () => {
    onOriginChange('server')
    setPickerOpen(true)
  }

  const serverChosen = origin === 'server' && !!serverPath

  /** The chosen path, taking the full row: the decision is made, so a live
   *  picker for the road not taken would only be noise. */
  const chosenPathRow = (
    // min-w-0: a flex item defaults to min-width:auto, so without it the path —
    // which can be any length — refuses to shrink and widens the whole dialog
    // instead of truncating.
    <div className="min-w-0 space-y-2">
      <Label>
        {t(expect === 'dir' ? 'databases.server_folder' : 'databases.server_file')}
      </Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
        {expect === 'dir' ? (
          <FolderOpen size={14} className="shrink-0 text-amber-500" />
        ) : (
          <Database size={14} className="shrink-0 text-violet-500" />
        )}
        {/* TruncatedText only raises its tooltip when the path is actually cut
            off, and brings a copy button — handy for a path meant to be pasted
            into a script or a shell. */}
        <div className="min-w-0 flex-1">
          <TruncatedText text={serverPath} className="font-mono text-xs" />
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setPickerOpen(true)}>
          {t('project_folders.change')}
        </Button>
        <button
          type="button"
          onClick={() => { onServerPathChange(''); onOriginChange('upload') }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )

  return (
    <>
      {serverChosen ? (
        chosenPathRow
      ) : hasUpload ? (
        children
      ) : (
        // Equal halves: the two origins are alternatives of the same kind. Each
        // column keeps its own label — the upload side already carries one — so
        // the zones line up whatever those labels wrap to.
        <div className="grid grid-cols-2 items-start gap-3">
          <div className="min-w-0">{children}</div>
          <div className="min-w-0 space-y-2">
            {/* Neither origin carries a required mark: either one satisfies the
                form, so starring one side (or both) reads as "this one is
                mandatory". The callers' upload labels follow the same rule. */}
            <Label>{t('databases.file_origin_server')}</Label>
            <FileDropZone
              icon={<Server size={20} className="text-muted-foreground" />}
              label={t('databases.server_path_hint')}
              hint={extensions?.join(', ')}
              onClick={openPicker}
            />
          </div>
        </div>
      )}

      {/* Mounted unconditionally, with `open` driven by state: Radix animates the
          closed→open transition, so a dialog conditionally mounted *already* open
          has no starting state to animate from and appears in two paints. */}
      <ServerPathPickerDialog
        open={pickerOpen}
        mode={expect === 'dir' ? 'folder' : 'file'}
        scope={scope}
        extensions={extensions}
        // The chosen path when there is one; otherwise the picker reopens where
        // it was last left, in this dialog or any other.
        initialPath={serverPath || undefined}
        onClose={() => {
          setPickerOpen(false)
          // Falling back to the upload side is only right when the browse was
          // opened from the empty zone and cancelled: leaving a server origin
          // with no path would strand the form. Re-browsing an already chosen
          // path and cancelling must keep it — the ref (not `serverPath`, which
          // is still the pre-pick value in this same tick) says whether a pick
          // just happened.
          if (!pickedRef.current && !serverPath) onOriginChange('upload')
          pickedRef.current = false
        }}
        onPick={(path) => {
          pickedRef.current = true
          onServerPathChange(path)
        }}
      />
    </>
  )
}
