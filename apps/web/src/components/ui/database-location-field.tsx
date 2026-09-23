import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ServerPathPickerDialog } from '@/components/ui/server-path-picker-dialog'
import { TruncatedText } from '@/components/ui/truncated-text'
import { fsValidatePath, type FsValidationReason } from '@/lib/api/fs-browser'
import { isServerMode } from '@/lib/api-client'

/** Where Linkr writes a DuckDB file it creates: its own data folder, or a server
 *  folder the user picked (`folder` + `fileName`). */
export type DatabaseLocation =
  | { kind: 'app' }
  | { kind: 'server'; folder: string; fileName: string }

export const DEFAULT_DATABASE_LOCATION: DatabaseLocation = { kind: 'app' }

/** The absolute file path a server location names, or undefined for the app folder. */
export function databaseLocationPath(location: DatabaseLocation): string | undefined {
  if (location.kind === 'app') return undefined
  return `${location.folder.replace(/\/+$/, '')}/${location.fileName.trim()}`
}

/** `<alias>.duckdb`, the name offered until the user types one. */
export function defaultDatabaseFileName(alias: string): string {
  return `${alias || 'database'}.duckdb`
}

interface Props {
  /** Which workspace's `databases:write` authorizes the browse. */
  workspaceId: string
  value: DatabaseLocation
  onChange: (value: DatabaseLocation) => void
  /** Offered as the file name when the user switches to a server folder. */
  suggestedFileName: string
  /** Reports whether the chosen location can be written, so the dialog can gate
   *  its confirm button. The app folder is always valid. */
  onValidityChange: (valid: boolean) => void
}

/**
 * Where a DuckDB file Linkr creates will live. Server mode only — the browser
 * build keeps its databases in memory, so there is nothing to choose there.
 *
 * The server re-checks the path when it creates the file (a new file, inside the
 * browse roots, in a writable folder); the live check here is only feedback.
 */
export function DatabaseLocationField({
  workspaceId,
  value,
  onChange,
  suggestedFileName,
  onValidityChange,
}: Props) {
  const { t } = useTranslation()
  const [pickerOpen, setPickerOpen] = useState(false)
  /** Set by onPick, read by onClose — both fire in the same tick, so `value`
   *  there still holds its pre-pick folder. */
  const pickedRef = useRef(false)
  /** The server's answer, tagged with the path it was for: an answer for a path
   *  the user has since edited is stale and must not be shown. */
  const [check, setCheck] = useState<{ path: string; reason: FsValidationReason | null } | null>(null)
  const path = databaseLocationPath(value)
  const needsCheck = value.kind === 'server' && !!value.folder && !!value.fileName.trim()

  useEffect(() => {
    if (!needsCheck || !path) return
    let cancelled = false
    const timer = setTimeout(() => {
      fsValidatePath(workspaceId, path, 'new-file')
        .then((r) => { if (!cancelled) setCheck({ path, reason: r.ok ? null : (r.reason ?? 'empty') }) })
        .catch(() => { if (!cancelled) setCheck({ path, reason: 'empty' }) })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needsCheck, path, workspaceId])

  const reason: FsValidationReason | 'checking' | null =
    value.kind === 'app' ? null
      : !needsCheck ? 'empty'
        : check && check.path === path ? check.reason
          : 'checking'
  const valid = reason === null

  useEffect(() => {
    onValidityChange(valid)
  }, [valid, onValidityChange])

  if (!isServerMode()) return null

  const reasonMessage = reason && reason !== 'checking' && reason !== 'empty'
    ? t(`databases.location_err_${reason}`, { defaultValue: t('databases.location_err_invalid') })
    : null

  return (
    <div className="min-w-0 space-y-2">
      <FormField label={t('databases.location')} hint={t('databases.location_hint')} hintInTooltip>
        {({ id }) => (
          <Select
            value={value.kind}
            onValueChange={(kind) => {
              if (kind === 'app') onChange({ kind: 'app' })
              else {
                onChange({ kind: 'server', folder: '', fileName: suggestedFileName })
                setPickerOpen(true)
              }
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">{t('databases.location_app')}</SelectItem>
              <SelectItem value="server">{t('databases.location_server')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>

      {value.kind === 'server' && (
        <>
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
            <FolderOpen size={14} className="shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              {value.folder ? (
                <TruncatedText text={value.folder} className="font-mono text-xs" />
              ) : (
                <span className="text-xs text-muted-foreground">{t('databases.location_no_folder')}</span>
              )}
            </div>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setPickerOpen(true)}>
              {value.folder ? t('project_folders.change') : t('project_folders.pick_folder')}
            </Button>
          </div>
          <FormField label={t('databases.location_file_name')} required>
            {({ id }) => (
              <Input
                id={id}
                value={value.fileName}
                onChange={(e) => onChange({ ...value, fileName: e.target.value })}
                placeholder={suggestedFileName}
                className="font-mono text-xs"
              />
            )}
          </FormField>
          <FieldError message={reasonMessage} />
        </>
      )}

      <ServerPathPickerDialog
        open={pickerOpen}
        mode="folder"
        scope={{ kind: 'workspace', workspaceId }}
        extensions={['.duckdb']}
        initialPath={value.kind === 'server' && value.folder ? value.folder : undefined}
        title={t('databases.location_pick_title')}
        onClose={() => {
          setPickerOpen(false)
          // Cancelled before any folder was chosen: back to the default, rather
          // than leaving the form on a location it cannot use.
          if (!pickedRef.current && value.kind === 'server' && !value.folder) onChange({ kind: 'app' })
          pickedRef.current = false
        }}
        onPick={(folder) => {
          pickedRef.current = true
          onChange({
            kind: 'server',
            folder,
            fileName: value.kind === 'server' && value.fileName ? value.fileName : suggestedFileName,
          })
        }}
      />
    </div>
  )
}
