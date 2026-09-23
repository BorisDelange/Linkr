import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Loader2, RefreshCw, Split } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field-error'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isServerMode } from '@/lib/api-client'
import { rebuildRequest } from '@/lib/cohort-derive'
import { buildCohortKeyMap } from '@/lib/entity-io'
import { formatDateTime } from '@/lib/format-helpers'
import { resolvePointer } from '@/lib/import-identity'
import { localized } from '@/lib/localized'
import { paths } from '@/lib/paths'
import { useCohortStore } from '@/stores/cohort-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DataSource } from '@/types'

const LEVEL_KEY = {
  patient: 'cohorts.level_patient',
  visit: 'cohorts.level_visit',
  visit_detail: 'cohorts.level_visit_detail',
  event: 'cohorts.level_event',
} as const

/**
 * Where a derived database came from — its parent and the cohort's criteria as
 * they were when it was built — and the rebuild those make possible. The parent
 * is matched by portable pointer, so the card still names it (from the snapshot)
 * on an instance that does not hold it.
 */
export function DerivedFromCard({ source }: { source: DataSource }) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('databases:write')
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const runDerivation = useDataSourceStore((s) => s.runDerivation)
  const cohorts = useCohortStore((s) => s.cohorts)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)

  const from = source.derivedFrom
  const parent = from ? resolvePointer(dataSources, from.database, source.workspaceId ?? '') : undefined
  const parentCohortId = useMemo(() => {
    if (!parent || !from) return undefined
    const own = cohorts.filter((c) => c.ownerDataSourceId === parent.id)
    const keys = buildCohortKeyMap(own)
    return own.find((c) => keys.get(c.id) === from.cohort.key)?.id
  }, [parent, from, cohorts])
  if (!from) return null

  const request = parent ? rebuildRequest(source, parent, parentCohortId) : null
  const parentName = parent ? localized(parent.name, i18n.language) : localized(from.database.label, i18n.language)
  const canRebuild = isServerMode() && canWrite && !!request && !!parent && parent.status === 'connected'

  const rebuild = async () => {
    if (!request || !parent) return
    setConfirm(false)
    setBusy(true)
    setError(null)
    try {
      await runDerivation(parent.id, request)
      setStarted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rows: { label: string; value: ReactNode }[] = [
    {
      label: t('cohort_derive.provenance_database'),
      value: parent ? (
        <Link
          to={paths.warehouseDatabase(source.workspaceId ?? '', parent.id, dataSources.map((d) => d.id))}
          className="truncate font-medium hover:underline"
        >
          {parentName}
        </Link>
      ) : (
        <span className="truncate font-medium">{parentName || '—'}</span>
      ),
    },
    { label: t('cohort_derive.provenance_cohort'), value: <span className="truncate font-medium">{localized(from.cohort.name, i18n.language)}</span> },
    { label: t('cohort_derive.provenance_level'), value: <span className="truncate font-medium">{t(LEVEL_KEY[from.level])}</span> },
    ...(from.builtAt
      ? [{ label: t('cohort_derive.provenance_built'), value: <span className="truncate font-medium">{formatDateTime(from.builtAt)}</span> }]
      : []),
    ...(from.patientCount != null
      ? [{ label: t('cohort_derive.provenance_patients'), value: <span className="truncate font-medium tabular-nums">{from.patientCount.toLocaleString()}</span> }]
      : []),
  ]

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Split size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('cohort_derive.provenance_title')}</h3>
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-muted-foreground">{r.label}</span>
            <span className="flex min-w-0 justify-end">{r.value}</span>
          </div>
        ))}
      </div>
      {from.target === 'new-database' && isServerMode() && canWrite && (
        parent ? (
          <div className="space-y-1">
            <Button size="sm" variant="outline" onClick={() => setConfirm(true)} disabled={!canRebuild || busy}>
              {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw size={14} className="mr-1.5" />}
              {t('cohort_derive.rebuild')}
            </Button>
            <p className="text-[10px] text-muted-foreground">
              {t(started ? 'cohort_derive.started' : 'cohort_derive.provenance_rebuild_hint')}
            </p>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">{t('cohort_derive.provenance_parent_missing')}</p>
        )
      )}
      <FieldError message={error} />

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohort_derive.rebuild_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohort_derive.provenance_rebuild_description', { database: parentName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void rebuild()}
            >
              {t('cohort_derive.rebuild')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
