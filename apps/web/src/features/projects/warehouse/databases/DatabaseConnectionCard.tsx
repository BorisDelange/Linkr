import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Minimize2, Plug } from 'lucide-react'
import type { DataSource, DatabaseConnectionConfig } from '@/types'
import { localized } from '@/lib/localized'
import { humanBytes } from '@/lib/format-helpers'
import { portOf } from '@/lib/database-engines'
import { compactDatabase, fetchCompactStatus, type CompactStatus } from '@/lib/api/data-sources'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { Button } from '@/components/ui/button'
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Progress } from '@/components/ui/progress'
import { CopyablePath, ParquetFilesDialog } from '@/components/ui/parquet-files-dialog'
import { notifyDatabaseLocationChanged, useDatabaseLocation } from './use-database-location'

const statusColors: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-amber-500',
}

function formatSourceType(source: DataSource, lang: string): string {
  if (source.sourceType === 'fhir') return 'FHIR Server'
  const mapping = source.schemaMapping
  if (mapping?.presetLabel) return localized(mapping.presetLabel, lang)
  const config = source.connectionConfig as DatabaseConnectionConfig
  return config.engine ? config.engine.charAt(0).toUpperCase() + config.engine.slice(1) : 'Database'
}

/** A label/value row whose value gets a tooltip only when it is actually cut. */
function ConnectionRow({ label, value }: { label: string; value: string }) {
  const { ref, overflows, triggerProps } = useOverflowTooltip<HTMLSpanElement>()
  const text = (
    <span ref={ref} className="min-w-0 truncate font-medium" {...triggerProps}>
      {value}
    </span>
  )
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {overflows ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{text}</TooltipTrigger>
            <TooltipContent side="top" className="text-xs">{value}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : text}
    </div>
  )
}

/**
 * Confirm and run a compaction, reporting what it reclaimed.
 *
 * Behind a confirmation because it rewrites the database file: the data is
 * unchanged, but a large file takes minutes and needs room for a full second
 * copy while it runs.
 */
function CompactDatabaseDialog({
  open,
  onOpenChange,
  source,
  sizeBytes,
  onCompacted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: DataSource
  sizeBytes: number | null
  onCompacted: () => void
}) {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<CompactStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const running = state?.status === 'running'
  const result = state?.status === 'done' ? state : null

  // Reopening mid-run rejoins the compaction in progress: the work is server-side,
  // so closing the dialog only hid it. 404 means none has run — the normal case.
  useEffect(() => {
    if (!open || state) return
    fetchCompactStatus(source.id)
      .then((s) => { if (s.status === 'running') setState(s) })
      .catch(() => {})
  }, [open, state, source.id])

  // Held in a ref so the polling effect does not list it as a dependency: the
  // parent passes an inline arrow, which is a new reference on every render and
  // would tear down and rebuild the interval after each poll.
  const onCompactedRef = useRef(onCompacted)
  useEffect(() => {
    onCompactedRef.current = onCompacted
  }, [onCompacted])

  // Poll while the copy runs. One second matches the rate the server samples the
  // file at, so a faster poll would just re-read the same number.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      fetchCompactStatus(source.id)
        .then((s) => {
          setState(s)
          // `running` goes false on this same update, so the effect tears the
          // interval down and this fires once rather than on every later poll.
          if (s.status === 'done') onCompactedRef.current()
          if (s.status === 'error') setError(s.error ?? 'error')
        })
        .catch(() => {})
    }, 1000)
    return () => clearInterval(id)
  }, [running, source.id])

  const run = () => {
    setStarting(true)
    setError(null)
    compactDatabase(source.id)
      .then(setState)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStarting(false))
  }

  const close = () => {
    onOpenChange(false)
    // Cleared after the dialog is gone, so the body does not flip back to the
    // confirmation text while it animates out.
    setTimeout(() => {
      setState(null)
      setError(null)
    }, 200)
  }

  const reclaimed = result ? result.sizeBefore - (result.sizeAfter ?? 0) : 0
  // Capped: dataSize is DuckDB's own estimate, and a copy that runs slightly past
  // it must not render a bar wider than its track.
  const percent =
    running && state && state.dataSize
      ? Math.min(100, Math.round((state.bytesWritten / state.dataSize) * 100))
      : null

  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('databases.compact_title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            {result ? (
              <span className="block">
                {reclaimed > 0
                  ? t('databases.compact_done', {
                      freed: humanBytes(reclaimed, i18n.language),
                      size: humanBytes(result.sizeAfter ?? 0, i18n.language),
                    })
                  : t('databases.compact_done_nothing')}
              </span>
            ) : running ? (
              <span className="block space-y-2">
                <span className="block">{t('databases.compact_running')}</span>
                {/* Only when DuckDB gave a denominator. Without one there is no
                    honest bar to draw, so the bytes written stand alone. */}
                {percent != null && <Progress value={percent} />}
                <span className="block font-mono text-[10px]">
                  {state && state.dataSize
                    ? t('databases.compact_progress', {
                        written: humanBytes(state.bytesWritten, i18n.language),
                        total: humanBytes(state.dataSize, i18n.language),
                        percent: percent ?? 0,
                      })
                    : t('databases.compact_progress_unknown', {
                        written: humanBytes(state?.bytesWritten ?? 0, i18n.language),
                      })}
                </span>
              </span>
            ) : (
              <span className="block space-y-2">
                <span className="block">{t('databases.compact_explain')}</span>
                <span className="block">
                  {t('databases.compact_warning', {
                    size: sizeBytes != null ? humanBytes(sizeBytes, i18n.language) : '—',
                  })}
                </span>
                {error && <span className="block text-destructive">{error}</span>}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {result ? (
            <AlertDialogAction onClick={close}>{t('common.close')}</AlertDialogAction>
          ) : running ? (
            // The work is server-side and survives this dialog, so closing it is
            // safe: hiding the progress does not cancel the compaction.
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={starting}>{t('common.cancel')}</AlertDialogCancel>
              {/* Not AlertDialogAction: that closes the dialog on click, and the
                  run has to stay on screen to report its progress. */}
              <Button size="sm" onClick={run} disabled={starting} className="gap-1.5">
                {starting && <Loader2 size={14} className="animate-spin" />}
                {t('databases.compact_action')}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** How this database is reached: engine, host or files, and the DuckDB alias. */
export function ConnectionCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const config = source.connectionConfig as DatabaseConnectionConfig
  const location = useDatabaseLocation(source)
  const connInfo = location.info
  const [filesOpen, setFilesOpen] = useState(false)
  const [compactOpen, setCompactOpen] = useState(false)
  const parquetTables = connInfo?.kind === 'parquet-folder' ? connInfo.tables : []
  const filePath = connInfo?.kind === 'file' ? connInfo.path : null

  // Compaction rewrites the file, so it is offered only for a server-owned
  // ("managed") database: an uploaded blob is addressed by its hash, and
  // rewriting it would invalidate every reference to that sha.
  const canCompact = Boolean(config.managed) && connInfo?.kind === 'file' && connInfo.exists

  const rows: { label: string; value: string }[] = [
    { label: 'Type', value: formatSourceType(source, i18n.language) },
    ...(source.sourceType === 'database' && config.engine
      ? [{ label: t('databases.field_engine'), value: capitalize(config.engine) }]
      : []),
    // The server's own count wins when it answered: it counts the blobs actually
    // stored, where `config.fileNames` is whatever the import recorded.
    ...(parquetTables.length || config.fileNames?.length
      ? []
      : config.host
        ? [{
            label: t('databases.field_host'),
            value: `${config.host}${portOf(config) ? `:${portOf(config)}` : ''}${config.database ? `/${config.database}` : ''}`,
          }]
        : []),
    { label: t('databases.field_identifier'), value: source.alias },
  ]

  const fileCount = parquetTables.length || config.fileNames?.length || 0

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Plug size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('databases.detail_connection')}</h3>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="shrink-0 text-muted-foreground">{t('databases.status')}</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${statusColors[source.status] ?? statusColors.disconnected}`}
            />
            <span className="truncate font-medium">{t(`databases.status_${source.status}`)}</span>
          </span>
        </div>
        {rows.map((r) => (
          <ConnectionRow key={r.label} label={r.label} value={r.value} />
        ))}
        {fileCount > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-muted-foreground">{t('databases.parquet_files_label')}</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">
                {t('databases.parquet_files_count', { count: fileCount })}
              </span>
              {/* Only the server knows the paths; without them there is nothing
                  a dialog could show beyond the count already on this row.
                  Negative margin: even the smallest button is taller than a
                  text-xs line, and without it this one row sat lower than the
                  rest of the card. */}
              {parquetTables.length > 0 && (
                <Button
                  variant="outline"
                  size="xs"
                  className="-my-1"
                  onClick={() => setFilesOpen(true)}
                >
                  {t('common.show')}
                </Button>
              )}
            </div>
          </div>
        )}
        {location.missing && connInfo?.kind !== 'file' && (
          <div className="space-y-1 pt-0.5">
            <span className="block text-xs text-muted-foreground">{t('databases.folder_location')}</span>
            {location.path && <CopyablePath value={location.path} />}
            <p className="text-[10px] font-medium text-destructive">
              {location.path ? t('etl.pipeline_db_missing') : t('databases.location_missing_description')}
            </p>
          </div>
        )}
        {/* A single-file source (DuckDB, SQLite) has one path, so it reads inline
            rather than behind a dialog. */}
        {filePath && (
          <div className="space-y-1 pt-0.5">
            <span className="block text-xs text-muted-foreground">{t('databases.file_location')}</span>
            <CopyablePath value={filePath} />
            {/* Under the path, not beside it: a content-addressed blob path fills
                the row on its own, and appending anything to it pushed the size
                onto a wrapped line of its own anyway. */}
            {connInfo?.sizeBytes != null && (
              <p className="text-[10px] text-muted-foreground">
                {humanBytes(connInfo.sizeBytes, i18n.language)}
              </p>
            )}
            {connInfo?.blob && (
              <p className="text-[10px] text-muted-foreground/70">{t('etl.pipeline_db_blob_hint')}</p>
            )}
            {location.missing && (
              <p className="text-[10px] font-medium text-destructive">{t('etl.pipeline_db_missing')}</p>
            )}
            {canCompact && (
              <Button
                variant="outline"
                size="xs"
                className="mt-1"
                onClick={() => setCompactOpen(true)}
              >
                <Minimize2 size={12} />
                {t('databases.compact_action')}
              </Button>
            )}
          </div>
        )}
      </div>
      <ParquetFilesDialog open={filesOpen} onOpenChange={setFilesOpen} tables={parquetTables} />
      <CompactDatabaseDialog
        open={compactOpen}
        onOpenChange={setCompactOpen}
        source={source}
        sizeBytes={connInfo?.sizeBytes ?? null}
        onCompacted={() => {
          // Re-read rather than patching sizeBytes locally: the server is the
          // only thing that knows what the file now weighs.
          notifyDatabaseLocationChanged(source.id)
        }}
      />
    </div>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
