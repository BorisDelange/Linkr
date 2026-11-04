import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
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
import { FieldInfo } from '@/components/ui/field-info'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchDerivePlan, type DerivePlanTable, type DeriveScope } from '@/lib/api/data-sources'
import { generateAlias } from '@/lib/duckdb/engine'
import { formatDateTime } from '@/lib/format-helpers'
import { localized, toLocalized } from '@/lib/localized'
import { paths } from '@/lib/paths'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { Cohort, CohortDerivation, DataSource, DerivationOptions } from '@/types'
import {
  copyableTables,
  derivationRequest,
  DERIVE_SCHEMA_NAME,
  defaultDeriveSchemaName,
  derivableReason,
  derivationScopes,
  isWritableTarget,
  personlessTables,
  planTableName,
  type VariableSelection,
} from '@/lib/cohort-derive'
import { DeriveContentTab, type VariablesMode } from './DeriveContentTab'
import { DEFAULT_PSEUDONYMS, deriveDraft, draftFromDerivations, saveDeriveDraft } from './derive-draft'
import { DerivePseudonymTab } from './DerivePseudonymTab'
import {
  pseudonymSettingsValid, type BirthPrecision, type KeyedDerivation, type PseudonymSettings,
} from './pseudonym-settings'

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
  const navigate = useNavigate()

  const cohortName = localized(cohort.name, i18n.language)
  const targets = useMemo(
    () => dataSources.filter((d) => d.workspaceId === source.workspaceId && isWritableTarget(d)),
    [dataSources, source.workspaceId],
  )

  const draftKey = cohort.id ?? cohortKey
  // The dialog as it was left for this cohort, else what its last derivation kept.
  const [initial] = useState(() => {
    const draft = deriveDraft(draftKey)
    if (draft) return draft
    const recorded = draftFromDerivations(cohort.derivations)
    return recorded.scope && derivationScopes(cohort.level).includes(recorded.scope) ? recorded : { ...recorded, scope: undefined }
  })
  const [kind, setKind] = useState<TargetKind>(initial.kind ?? 'new-database')
  const [name, setName] = useState(initial.name ?? cohortName)
  const [location, setLocation] = useState<DatabaseLocation>(initial.location ?? DEFAULT_DATABASE_LOCATION)
  const [locationValid, setLocationValid] = useState(true)
  const [targetId, setTargetId] = useState(() =>
    initial.targetId && targets.some((d) => d.id === initial.targetId)
      ? initial.targetId
      : isWritableTarget(source) ? source.id : targets[0]?.id ?? '')
  const [schemaName, setSchemaName] = useState(() => initial.schemaName ?? defaultDeriveSchemaName(cohort))
  const [register, setRegister] = useState(initial.register ?? true)
  // Keyed by the scope it was read for: another scope's plan is not this one's.
  const [planned, setPlanned] = useState<{ scope: DeriveScope; tables?: DerivePlanTable[]; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState<CohortDerivation | null>(null)
  const [tab, setTab] = useState(initial.tab ?? 'destination')

  const [scope, setScope] = useState<DeriveScope>(initial.scope ?? (cohort.level as DeriveScope))
  const [variablesMode, setVariablesMode] = useState<VariablesMode>(initial.variablesMode ?? 'all')
  const [variables, setVariables] = useState<VariableSelection | undefined>(initial.variables)
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(initial.excluded ?? []))
  // Tables a recorded derivation ticked: the others are unticked once the plan lists them.
  const included = useRef<string[] | undefined>(initial.included)
  // On by default: the CNIL referential asks each project's data for pseudonyms of its own.
  const [pseudonyms, setPseudonyms] = useState<PseudonymSettings>(initial.pseudonyms ?? DEFAULT_PSEUDONYMS)
  const [birthPrecision, setBirthPrecision] = useState<BirthPrecision>(initial.birthPrecision ?? 'month')

  useEffect(() => {
    saveDeriveDraft(draftKey, {
      tab, kind, name, location, targetId, schemaName, register, scope, variablesMode, variables,
      excluded: [...excluded], included: included.current, pseudonyms, birthPrecision,
    })
  }, [draftKey, tab, kind, name, location, targetId, schemaName, register, scope, variablesMode, variables, excluded, pseudonyms, birthPrecision])

  const blocked = derivableReason(cohort, source)
  const target = targets.find((d) => d.id === targetId)
  const targetEngine = (target?.connectionConfig as { engine?: string } | undefined)?.engine
  // A schema of a server database can also be declared as a database of its own.
  const isExternalTarget = !!targetEngine && targetEngine !== 'duckdb'
  const schemaValid = DERIVE_SCHEMA_NAME.test(schemaName)

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    fetchDerivePlan(source.id, cohort.level, scope)
      .then((tables) => {
        if (cancelled) return
        setPlanned({ scope, tables })
        const kept = included.current
        if (kept) {
          setExcluded(new Set(copyableTables(tables).map(planTableName).filter((n) => !kept.includes(n))))
          included.current = undefined
        }
      })
      .catch((e) => { if (!cancelled) setPlanned({ scope, error: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [source.id, cohort.level, scope, blocked])
  const plan = planned?.scope === scope ? planned.tables ?? null : null
  const planError = planned?.scope === scope ? planned.error ?? null : null

  const copied = useMemo(
    () => (plan ? copyableTables(plan).filter((p) => !excluded.has(planTableName(p))) : []),
    [plan, excluded],
  )
  const idColumns = useMemo(() => [...new Set(copied.flatMap((p) => p.pseudonymized ?? []))], [copied])

  // The correspondence never goes into the derived database itself, nor into the
  // DuckDB file the cohort is read from (one file cannot be opened twice) — a
  // Postgres source can hold it, in a schema of its own.
  const correspondenceTargets = useMemo(() => {
    const sourceIsFile = (source.connectionConfig as { engine?: string }).engine === 'duckdb'
    return targets.filter((d) => (kind === 'new-database' || d.id !== targetId) && !(sourceIsFile && d.id === source.id))
  }, [targets, kind, targetId, source])
  // Derivations of this workspace whose HMAC key is kept: another can draw the
  // same pseudonyms with it (a cohort followed over time).
  const keyedDerivations = useMemo<KeyedDerivation[]>(() => {
    const out = new Map<string, string>()
    const keyed = (o: DerivationOptions | undefined) => o?.pseudonymization?.method === 'hmac' && o.pseudonymization.keepKey
    for (const d of dataSources) {
      const from = d.derivedFrom
      if (d.workspaceId === source.workspaceId && from?.derivationId && keyed(from.options)) {
        out.set(from.derivationId, localized(d.name, i18n.language))
      }
    }
    for (const d of cohort.derivations ?? []) {
      if (d.derivationId && keyed(d.options) && !out.has(d.derivationId)) {
        const ds = dataSources.find((x) => x.id === d.targetId)
        const name = ds ? localized(ds.name, i18n.language) : d.targetId
        out.set(d.derivationId, d.schemaName ? `${name} · ${d.schemaName}` : name)
      }
    }
    return [...out].map(([derivationId, label]) => ({ derivationId, label }))
  }, [dataSources, source.workspaceId, cohort.derivations, i18n.language])

  const options = (): DerivationOptions => ({
    scope,
    tables: copied.map((p) => ({ schema: p.schema, table: p.table })),
    ...(variablesMode === 'list' && variables ? { variables } : {}),
    ...(birthPrecision !== 'day' ? { birthPrecision } : {}),
    ...(pseudonyms.enabled ? {
      pseudonymization: {
        method: pseudonyms.method,
        keepKey: pseudonyms.method === 'hmac' && pseudonyms.keepKey,
        ...(pseudonyms.method === 'hmac' && pseudonyms.reuseKeyOf ? { reuseKeyOf: pseudonyms.reuseKeyOf } : {}),
        ...(pseudonyms.correspondenceId ? {
          correspondence: {
            dataSourceId: pseudonyms.correspondenceId,
            schemaName: pseudonyms.correspondenceSchema,
            tableName: pseudonyms.correspondenceTable,
          },
        } : {}),
      },
    } : {}),
  })
  // Whether every table holding no patient is copied, as the request also says.
  const copyPersonless = !!plan && personlessTables(plan).every((p) => !excluded.has(planTableName(p)))
  const contentReady = !!plan && copied.length > 0 && (variablesMode === 'all' || !!variables?.conceptIds.length)

  const destinationReady = kind === 'new-database' ? !!name.trim() && locationValid : !!target && schemaValid
  const canConfirm = !blocked && !busy && destinationReady && contentReady && pseudonymSettingsValid(pseudonyms)

  // The copy runs as a job of the workspace: once it is queued there is nothing
  // left to do here, and the footer's jobs panel follows it. Only a refusal
  // (a name taken, a database that does not allow writes) keeps the dialog open.
  const run = async (go: () => Promise<unknown>) => {
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
    const base = { cohort, cohortKey, source, copyPersonless, options: options() }
    if (kind === 'new-database') {
      // To the new database straight away: it reads "being set up" until the
      // job ends, then connects in place.
      void run(async () => {
        const { dataSourceId } = await deriveIntoNewDatabase({
          parentId: source.id,
          name: toLocalized(name.trim()),
          path: databaseLocationPath(location),
          request: derivationRequest({ ...base, target: 'new-database' }),
        })
        const ids = useDataSourceStore.getState().dataSources.map((d) => d.id)
        navigate(paths.warehouseDatabase(source.workspaceId ?? '', dataSourceId, ids))
      })
      return
    }
    void run(async () => runDerivation(source.id, {
      ...derivationRequest({ ...base, target: 'schema' }),
      target: {
        kind: 'schema',
        dataSourceId: targetId,
        schemaName,
        ...(isExternalTarget && register ? { registerName: name.trim() || schemaName, registerAlias: schemaName } : {}),
      },
    }))
  }

  const rebuild = (d: CohortDerivation) => {
    setRebuilding(null)
    void run(async () => runDerivation(source.id, {
      // With what it kept before: a rebuild redraws the same database, never a
      // wider one. One recorded before the options were has none: everything.
      ...derivationRequest({
        cohort, cohortKey, source, copyPersonless: true, options: d.options, target: d.kind,
      }),
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
  // One whose database is gone has nothing left to rebuild or open. The server
  // prunes them when a database is deleted; this covers older records.
  const derivations = (cohort.derivations ?? []).filter((d) => dataSources.some((ds) => ds.id === d.targetId))

  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        kind="settings"
        // The workbench's height at the settings width: the table list of the
        // Content tab fills it down to the footer, and no tab moves the triggers.
        className="flex h-[85vh] max-h-[85vh] flex-col"
        contentClassName="flex min-h-0 flex-1 flex-col"
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
          <DeriveTabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              {
                value: 'destination',
                label: t('cohort_derive.tab_destination'),
                incomplete: !destinationReady,
                content: (
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
                <FormField
                  label={t('cohort_derive.schema_name')}
                  // Oracle has no schema but a user's, which only an administrator creates.
                  hint={t(targetEngine === 'oracle' ? 'cohort_derive.schema_name_hint_oracle' : 'cohort_derive.schema_name_hint')}
                  required
                >
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
                {isExternalTarget && (
                  <>
                    <div className="flex items-center gap-2">
                      <Checkbox id="derive-register" checked={register} onCheckedChange={(v) => setRegister(v === true)} />
                      <Label htmlFor="derive-register">
                        {t('cohort_derive.register')}
                        <FieldInfo text={t('cohort_derive.register_hint')} />
                      </Label>
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

                  </>
                ),
              },
              {
                value: 'content',
                label: t('cohort_derive.tab_content'),
                incomplete: !!plan && !contentReady,
                content: (
                  <DeriveContentTab
                    cohort={cohort}
                    source={source}
                    scope={scope}
                    onScopeChange={setScope}
                    variablesMode={variablesMode}
                    onVariablesModeChange={setVariablesMode}
                    variables={variables}
                    onVariablesChange={setVariables}
                    plan={plan}
                    planError={planError}
                    excluded={excluded}
                    onExcludedChange={setExcluded}
                  />
                ),
              },
              {
                value: 'pseudonymization',
                label: t('cohort_derive.tab_pseudonymization'),
                incomplete: !pseudonymSettingsValid(pseudonyms),
                content: (
                  <DerivePseudonymTab
                    settings={pseudonyms}
                    onChange={setPseudonyms}
                    birthPrecision={birthPrecision}
                    onBirthPrecisionChange={setBirthPrecision}
                    idColumns={idColumns}
                    correspondenceTargets={correspondenceTargets}
                    keyedDerivations={keyedDerivations}
                  />
                ),
              },
            ]}
          />
        )}
        <FieldError message={error} />
      </DialogShell>

      <AlertDialog open={!!rebuilding} onOpenChange={(o) => { if (!o) setRebuilding(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohort_derive.rebuild_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {rebuilding && t('cohort_derive.rebuild_description', { target: derivationLabel(rebuilding) })}
              {rebuilding?.kind === 'schema' && ` ${t('cohort_derive.rebuild_schema_warning')}`}
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

interface DeriveTab {
  value: string
  label: string
  content: ReactNode
  /** Dot on the trigger: something on that tab still holds the confirm back. */
  incomplete?: boolean
}

/** The dialog's tabs, filling its fixed height: the active panel scrolls on
 *  its own, and a panel may stretch a block of its own down to the footer. */
function DeriveTabs({ tabs, value, onValueChange }: { tabs: DeriveTab[]; value: string; onValueChange: (v: string) => void }) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="min-h-0 flex-1">
      <TabsList className="w-full shrink-0">
        {tabs.map((tb) => (
          <TabsTrigger key={tb.value} value={tb.value} className="flex-1 gap-1.5">
            {tb.label}
            {tb.incomplete && <span className="size-1.5 rounded-full bg-destructive" />}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pt-3">
        {tabs.find((tb) => tb.value === value)?.content}
      </div>
    </Tabs>
  )
}
