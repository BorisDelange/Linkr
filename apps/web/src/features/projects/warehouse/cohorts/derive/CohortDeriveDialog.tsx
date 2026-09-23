import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  DEFAULT_DATABASE_LOCATION,
  DatabaseLocationField,
  databaseLocationPath,
  defaultDatabaseFileName,
  type DatabaseLocation,
} from '@/components/ui/database-location-field'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchDerivePlan, type DerivePlanTable } from '@/lib/api/data-sources'
import type { Job } from '@/lib/api/environments'
import { generateAlias } from '@/lib/duckdb/engine'
import { formatDateTime } from '@/lib/format-helpers'
import { localized, toLocalized } from '@/lib/localized'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { Cohort, CohortDerivation, DataSource } from '@/types'
import {
  derivationRequest,
  DERIVE_SCHEMA_NAME,
  derivableReason,
  isWritableTarget,
} from '@/lib/cohort-derive'

type TargetKind = 'new-database' | 'schema'

interface CohortDeriveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cohort: Cohort
  /** The cohort's key in its database's export — what the provenance names it by. */
  cohortKey: string
  /** The database the cohort belongs to, connected. */
  source: DataSource
}

export function CohortDeriveDialog(props: CohortDeriveDialogProps) {
  // Remounted per opening, so each one starts from the cohort as it is now.
  return props.open ? <DeriveForm {...props} /> : null
}

function DeriveForm({ open, onOpenChange, cohort, cohortKey, source }: CohortDeriveDialogProps) {
  const { t, i18n } = useTranslation()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const deriveIntoNewDatabase = useDataSourceStore((s) => s.deriveIntoNewDatabase)
  const runDerivation = useDataSourceStore((s) => s.runDerivation)

  const cohortName = localized(cohort.name, i18n.language)
  const targets = useMemo(
    () => dataSources.filter((d) => d.workspaceId === source.workspaceId && isWritableTarget(d)),
    [dataSources, source.workspaceId],
  )

  const [kind, setKind] = useState<TargetKind>('new-database')
  const [name, setName] = useState(cohortName)
  const [location, setLocation] = useState<DatabaseLocation>(DEFAULT_DATABASE_LOCATION)
  const [locationValid, setLocationValid] = useState(true)
  const [targetId, setTargetId] = useState(() => (isWritableTarget(source) ? source.id : targets[0]?.id ?? ''))
  const [schemaName, setSchemaName] = useState(() => `cohort_${generateAlias(localized(cohort.name, 'en'))}`.slice(0, 63))
  const [register, setRegister] = useState(true)
  const [copyPersonless, setCopyPersonless] = useState(true)
  const [plan, setPlan] = useState<DerivePlanTable[] | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState<CohortDerivation | null>(null)

  const blocked = derivableReason(cohort, source)
  const target = targets.find((d) => d.id === targetId)
  const isPostgresTarget = (target?.connectionConfig as { engine?: string } | undefined)?.engine === 'postgresql'
  const schemaValid = DERIVE_SCHEMA_NAME.test(schemaName)

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    fetchDerivePlan(source.id, cohort.level)
      .then((p) => { if (!cancelled) setPlan(p) })
      .catch((e) => { if (!cancelled) setPlanError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [source.id, cohort.level, blocked])

  const filtered = plan?.filter((p) => p.filter) ?? []
  const personless = plan?.filter((p) => !p.filter) ?? []

  const canConfirm = !blocked && !busy && (
    kind === 'new-database'
      ? !!name.trim() && locationValid
      : !!target && schemaValid
  )

  // The copy runs as a job of the workspace: once it is queued there is nothing
  // left to do here, and the footer's jobs panel follows it. Only a refusal
  // (a name taken, a database that does not allow writes) keeps the dialog open.
  const run = async (go: () => Promise<Job>) => {
    setBusy(true)
    setError(null)
    try {
      await go()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const confirm = () => {
    if (!canConfirm) return
    const base = { cohort, cohortKey, source, copyPersonless }
    if (kind === 'new-database') {
      void run(() => deriveIntoNewDatabase({
        parentId: source.id,
        name: toLocalized(name.trim()),
        path: databaseLocationPath(location),
        request: derivationRequest({ ...base, target: 'new-database' }),
      }))
      return
    }
    void run(() => runDerivation(source.id, {
      ...derivationRequest({ ...base, target: 'schema' }),
      target: {
        kind: 'schema',
        dataSourceId: targetId,
        schemaName,
        ...(isPostgresTarget && register ? { registerName: name.trim() || schemaName, registerAlias: schemaName } : {}),
      },
    }))
  }

  const rebuild = (d: CohortDerivation) => {
    setRebuilding(null)
    void run(() => runDerivation(source.id, {
      ...derivationRequest({ cohort, cohortKey, source, copyPersonless, target: d.kind }),
      target: d.kind === 'new-database'
        ? { kind: 'new-database', dataSourceId: d.targetId }
        : { kind: 'schema', dataSourceId: d.targetId, schemaName: d.schemaName ?? '', replace: true },
    }))
  }

  const databaseName = (id: string | undefined) => {
    const ds = dataSources.find((d) => d.id === id)
    return ds ? localized(ds.name, i18n.language) : t('cohort_derive.missing_database')
  }
  const derivationLabel = (d: CohortDerivation) =>
    d.kind === 'schema' ? `${databaseName(d.targetId)} · ${d.schemaName}` : databaseName(d.targetId)
  const derivations = cohort.derivations ?? []

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        kind="settings"
        title={t('cohort_derive.title')}
        description={t('cohort_derive.description', { name: cohortName })}
        onConfirm={confirm}
        confirmLabel={t('cohort_derive.confirm')}
        confirmDisabled={!canConfirm}
        busy={busy}
        footerExtra={
          <span className="flex items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
            {busy && (
              <>
                <Loader2 size={13} className="shrink-0 animate-spin" />
                {t('cohort_derive.starting')}
              </>
            )}
          </span>
        }
      >
        {blocked ? (
          <p className="text-sm text-muted-foreground">{t(`cohort_derive.unavailable_${blocked}`)}</p>
        ) : (
          <>
            {derivations.length > 0 && (
              <div className="space-y-1.5">
                <SectionLabel>{t('cohort_derive.existing')}</SectionLabel>
                {derivations.map((d) => (
                  <div key={`${d.targetId}:${d.schemaName ?? ''}`} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{derivationLabel(d)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {t('cohort_derive.built', { date: formatDateTime(d.builtAt), count: d.patientCount })}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 text-xs"
                      disabled={busy || !dataSources.some((ds) => ds.id === d.targetId)}
                      onClick={() => setRebuilding(d)}
                    >
                      <RefreshCw size={12} />
                      {t('cohort_derive.rebuild')}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <FormField label={t('cohort_derive.target')}>
              {({ id }) => (
                <Select value={kind} onValueChange={(v) => setKind(v as TargetKind)}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new-database">{t('cohort_derive.target_new_database')}</SelectItem>
                    <SelectItem value="schema" disabled={targets.length === 0}>
                      {t('cohort_derive.target_schema')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>

            {kind === 'new-database' ? (
              <>
                <FormField label={t('cohort_derive.database_name')} required>
                  {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
                </FormField>
                <DatabaseLocationField
                  workspaceId={source.workspaceId ?? ''}
                  value={location}
                  onChange={setLocation}
                  suggestedFileName={defaultDatabaseFileName(generateAlias(name))}
                  onValidityChange={setLocationValid}
                />
              </>
            ) : (
              <>
                <FormField label={t('cohort_derive.target_database')} hint={t('cohort_derive.target_database_hint')} hintInTooltip>
                  {({ id }) => (
                    <Select value={targetId} onValueChange={setTargetId}>
                      <SelectTrigger id={id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {targets.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {localized(d.name, i18n.language)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
                <FormField label={t('cohort_derive.schema_name')} hint={t('cohort_derive.schema_name_hint')} required>
                  {({ id }) => (
                    <Input
                      id={id}
                      value={schemaName}
                      onChange={(e) => setSchemaName(e.target.value)}
                      className="font-mono text-xs"
                    />
                  )}
                </FormField>
                <FieldError message={schemaName && !schemaValid ? t('cohort_derive.schema_name_invalid') : null} />
                {isPostgresTarget && (
                  <>
                    <div className="flex items-start gap-2">
                      <Checkbox id="derive-register" checked={register} onCheckedChange={(v) => setRegister(v === true)} />
                      <div className="space-y-0.5">
                        <Label htmlFor="derive-register">{t('cohort_derive.register')}</Label>
                        <p className="text-xs text-muted-foreground">{t('cohort_derive.register_hint')}</p>
                      </div>
                    </div>
                    {register && (
                      <FormField label={t('cohort_derive.database_name')}>
                        {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
                      </FormField>
                    )}
                  </>
                )}
              </>
            )}

            <div className="flex items-start gap-2">
              <Checkbox id="derive-personless" checked={copyPersonless} onCheckedChange={(v) => setCopyPersonless(v === true)} />
              <div className="space-y-0.5">
                <Label htmlFor="derive-personless">{t('cohort_derive.copy_personless')}</Label>
                <p className="text-xs text-muted-foreground">{t('cohort_derive.copy_personless_hint')}</p>
              </div>
            </div>

            <DerivePlan
              filtered={filtered}
              personless={personless}
              copyPersonless={copyPersonless}
              loading={!plan && !planError}
              error={planError}
            />
          </>
        )}
        <FieldError message={error} />
      </DialogShell>

      <AlertDialog open={!!rebuilding} onOpenChange={(o) => { if (!o) setRebuilding(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohort_derive.rebuild_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {rebuilding && t('cohort_derive.rebuild_description', { target: derivationLabel(rebuilding) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => rebuilding && rebuild(rebuilding)}
            >
              {t('cohort_derive.rebuild')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const FILTER_KEY: Record<NonNullable<DerivePlanTable['filter']>, string> = {
  patient: 'cohort_derive.filter_patient',
  visit: 'cohort_derive.filter_visit',
  visit_detail: 'cohort_derive.filter_visit_detail',
  parent_visit: 'cohort_derive.filter_parent_visit',
}

const tableName = (p: { schema: string | null; table: string }) => (p.schema ? `${p.schema}.${p.table}` : p.table)

/** What will happen to each table, before anything runs. */
function DerivePlan({
  filtered,
  personless,
  copyPersonless,
  loading,
  error,
}: {
  filtered: DerivePlanTable[]
  personless: DerivePlanTable[]
  copyPersonless: boolean
  loading: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  if (error) return <FieldError message={t('cohort_derive.plan_error', { error })} />
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        {t('cohort_derive.plan_loading')}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <SectionLabel>
        {t('cohort_derive.plan_title', { filtered: filtered.length, personless: personless.length })}
      </SectionLabel>
      <div className="max-h-48 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <tbody>
            {filtered.map((p) => (
              <tr key={tableName(p)} className="border-b last:border-0">
                <td className="px-2 py-1 font-mono">{tableName(p)}</td>
                <td className="px-2 py-1 text-muted-foreground">
                  {t(FILTER_KEY[p.filter!], { column: p.column })}
                </td>
              </tr>
            ))}
            {personless.map((p) => (
              <tr key={tableName(p)} className="border-b last:border-0">
                <td className="px-2 py-1 font-mono">{tableName(p)}</td>
                <td className="px-2 py-1 text-muted-foreground">
                  {copyPersonless ? t('cohort_derive.filter_whole') : t('cohort_derive.filter_skipped')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
