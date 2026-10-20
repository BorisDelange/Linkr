import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Pencil, RefreshCw } from 'lucide-react'
import type { DataSource } from '@/types'
import { DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { NoticeBanner } from '@/components/ui/notice-banner'
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
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDataSourceStore } from '@/stores/data-source-store'
import { canRebuild, connectionBannerShown } from './connection-status'

/**
 * Why a database does not work — the connection failed, it is being set up, it
 * holds no data — with the ways out: test again, edit the connection, rebuild
 * from its schema. Under the database page's tab bar, so every tab says it.
 */
export function ConnectionStatusBanner({
  source,
  onEditConnection,
  className,
}: {
  source: DataSource
  /** Opens the edit dialog on its Connection tab; absent without the right to edit. */
  onEditConnection?: () => void
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const rebuildFromSchema = useDataSourceStore((s) => s.rebuildFromSchema)
  const retestDataSource = useDataSourceStore((s) => s.retestDataSource)
  const [rebuilding, setRebuilding] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const [retesting, setRetesting] = useState(false)

  if (!connectionBannerShown(source)) return null
  const configuring = source.status === 'configuring'
  const rebuildable = canWrite && canRebuild(source)

  const handleRetest = async () => {
    setRetesting(true)
    try {
      await retestDataSource(source.id)
    } finally {
      setRetesting(false)
    }
  }

  const handleRebuild = async () => {
    setConfirmRebuild(false)
    setRebuilding(true)
    try {
      await rebuildFromSchema(source.id)
    } catch {
      // The failure is already on the row as `errorMessage`, which this banner
      // renders — rethrowing here would only add an unhandled rejection.
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <>
      <NoticeBanner
        tone={source.status === 'error' ? 'danger' : configuring ? 'progress' : 'warning'}
        className={className}
        title={t(source.status === 'error' ? 'databases.detail_error'
          : configuring ? 'databases.detail_configuring' : 'databases.detail_not_connected')}
        description={(
          <>
            <p className={cn(
              source.status === 'error' ? 'break-all font-mono text-destructive/80'
                : configuring ? undefined : 'break-all text-warning-foreground/80',
            )}>
              {configuring && (!source.errorMessage || source.errorMessage === DB_ERROR_NO_DATA_ON_IMPORT)
                ? t('databases.detail_configuring_hint')
                : !source.errorMessage || source.errorMessage === DB_ERROR_NO_DATA_ON_IMPORT
                  ? t('databases.imported_without_data')
                  : source.errorMessage}
            </p>
            {/* A database built from a schema carries its DDL but never its
                tables — the export leaves the DuckDB file behind on purpose. */}
            {rebuildable && <p className="mt-1 text-[10px]">{t('databases.rebuild_from_schema_hint')}</p>}
          </>
        )}
        // Nothing to do while it is being set up: a job builds it, or a test is
        // already running — kept while the user's own retest spins.
        action={(!configuring || retesting) && (
          <div className="flex items-center gap-2">
            {onEditConnection && (
              <Button size="sm" variant="outline" onClick={onEditConnection} disabled={retesting || rebuilding}>
                <Pencil size={14} />
                {t('databases.edit_connection')}
              </Button>
            )}
            {/* The non-destructive way out, which fixes every transient cause;
                the rebuild beside it is the last resort. */}
            <Button size="sm" onClick={handleRetest} disabled={retesting || rebuilding}>
              {retesting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t('databases.test_connection_again')}
            </Button>
            {rebuildable && (
              // Confirmed, never immediate: the rebuild drops whatever the file
              // holds, and a database that merely failed to connect may still
              // carry every row it was loaded with.
              <Button size="sm" variant="destructive" onClick={() => setConfirmRebuild(true)} disabled={rebuilding || retesting}>
                {rebuilding && <Loader2 size={14} className="animate-spin" />}
                {t('databases.rebuild_from_schema')}
              </Button>
            )}
          </div>
        )}
      />

      <AlertDialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('databases.rebuild_from_schema')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('databases.rebuild_from_schema_confirm', { name: localized(source.name, i18n.language) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleRebuild}
            >
              {t('databases.rebuild_from_schema_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
