import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowDownToLine, Check, Database, FileText, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { humanBytes } from '@/lib/format-helpers'
import {
  applyDatabasePull,
  prepareDatabasePull,
  DATABASE_PULL_METADATA_FILES,
  type PreparedDatabasePull,
} from '@/lib/database-pull'

interface DatabasePullProps {
  sourceId: string
  branch: string
  /** The remote head the panel knows about — a plan prepared against a different
   *  one is stale (the remote advanced) and must be recomputed. */
  remoteHead: string | null
  /** Called once the pull is applied so the panel refreshes status + cursors. */
  onPulled: () => void | Promise<void>
}

/**
 * The database pull: one decision, taken or refused.
 *
 * No per-file rows and no draft cache, unlike every other scope. A database is
 * replaced whole (see lib/database-pull.ts) — its metadata, its mapping and the
 * rows the repo carries arrive together or not at all, so there is nothing to
 * tick. What the panel owes the user instead is a clear statement of what taking
 * it costs: the local data is dropped for the remote's.
 */
export function DatabasePull({ sourceId, branch, remoteHead, onPulled }: DatabasePullProps) {
  const { t, i18n } = useTranslation()
  const [prepared, setPrepared] = useState<PreparedDatabasePull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    prepareDatabasePull(sourceId, branch)
      .then((p) => {
        if (cancelled) return
        setPrepared(p)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [sourceId, branch, remoteHead])

  const finalize = async (accepted: boolean) => {
    if (!prepared || applying) return
    setApplying(true)
    setError(null)
    try {
      await applyDatabasePull(sourceId, prepared, accepted)
      await onPulled()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t('versioning.pull_computing')}
      </div>
    )
  }
  if (error && !prepared) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-destructive">
        <AlertTriangle size={24} />
        {error}
      </div>
    )
  }
  if (!prepared) return null

  const { dataTables, tables, dataBytes, remoteName } = prepared
  // A repo that gitignores its data declares tables it does not ship. Pulling it
  // still replaces the database, but brings no rows — say so before the user
  // trades their local data for an empty one.
  const missingData = tables.length > 0 && dataTables.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <ArrowDownToLine size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-xs font-semibold">{t('versioning.pull_db_title')}</span>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('versioning.pull_db_explainer', { name: remoteName ?? t('versioning.pull_db_unnamed') })}
          </p>

          <ul className="space-y-1.5 text-xs">
            <li className="flex items-center gap-2">
              <FileText size={13} className="shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">
                {t('versioning.pull_db_metadata', { files: DATABASE_PULL_METADATA_FILES.join(', ') })}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <Database size={13} className="shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">
                {dataTables.length > 0
                  ? t('versioning.pull_db_data', {
                      count: dataTables.length,
                      size: humanBytes(dataBytes, i18n.language),
                    })
                  : t('versioning.pull_db_no_data')}
              </span>
            </li>
          </ul>

          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{missingData ? t('versioning.pull_db_warn_empty') : t('versioning.pull_db_warn')}</span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3 border-t pt-3">
        <span className="mr-auto text-[11px] text-muted-foreground">
          {t('versioning.pull_db_all_or_nothing')}
        </span>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => finalize(false)} disabled={applying}>
          <X size={14} />
          {t('versioning.pull_keep_mine')}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={() => finalize(true)} disabled={applying}>
          {applying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t('versioning.pull_db_take')}
        </Button>
      </div>
    </div>
  )
}
