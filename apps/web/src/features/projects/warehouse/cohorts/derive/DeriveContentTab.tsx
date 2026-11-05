import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, Loader2, Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DerivePlanTable, DeriveScope } from '@/lib/api/data-sources'
import {
  copyableTables, criteriaConcepts, derivationScopes, mergeVariables, personlessTables, planTableName, variableFilters,
  type VariableSelection,
} from '@/lib/cohort-derive'
import type { Cohort, DataSource } from '@/types'
import { CohortConceptPickerDialog } from '../builder/criteria/CohortConceptPickerDialog'

export type VariablesMode = 'all' | 'list'

const FILTER_KEY: Record<NonNullable<DerivePlanTable['filter']>, string> = {
  patient: 'cohort_derive.filter_patient',
  visit: 'cohort_derive.filter_visit',
  visit_detail: 'cohort_derive.filter_visit_detail',
  parent_visit: 'cohort_derive.filter_parent_visit',
}

/**
 * What a derivation keeps, on two axes — the individuals (the cohort's level or
 * a wider one) and the variables (all, or a list of concepts) — then table by
 * table. Data minimisation: a project receives only what it needs.
 */
export function DeriveContentTab({
  cohort,
  source,
  scope,
  onScopeChange,
  variablesMode,
  onVariablesModeChange,
  variables,
  onVariablesChange,
  plan,
  planError,
  excluded,
  onExcludedChange,
}: {
  cohort: Cohort
  source: DataSource
  scope: DeriveScope
  onScopeChange: (scope: DeriveScope) => void
  variablesMode: VariablesMode
  onVariablesModeChange: (mode: VariablesMode) => void
  variables: VariableSelection | undefined
  onVariablesChange: (variables: VariableSelection | undefined) => void
  plan: DerivePlanTable[] | null
  planError: string | null
  /** The copyable tables left unticked, by `planTableName`. */
  excluded: ReadonlySet<string>
  onExcludedChange: (excluded: Set<string>) => void
}) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(false)
  const fromCriteria = useMemo(() => criteriaConcepts(cohort.criteriaTree), [cohort.criteriaTree])
  const mapping = source.schemaMapping

  // Concepts per table, as the server will filter them.
  const filtered = useMemo(() => {
    if (variablesMode !== 'list' || !variables || !mapping) return null
    const { filters, unfiltered } = variableFilters(mapping, variables)
    const byTable = new Map(filters.map((f) => [planTableName({ schema: f.schemaName ?? null, table: f.table }).toLowerCase(), f.conceptIds.length]))
    return { byTable, unfiltered }
  }, [variablesMode, variables, mapping])

  const copyable = plan ? copyableTables(plan) : []
  const refused = plan ? plan.filter((p) => p.unresolved || p.unfilterable) : []
  const copied = copyable.filter((p) => !excluded.has(planTableName(p))).length

  const toggle = (name: string, on: boolean) => {
    const next = new Set(excluded)
    if (on) next.delete(name)
    else next.add(name)
    onExcludedChange(next)
  }
  const tickPersonless = () => {
    const next = new Set(excluded)
    for (const p of personlessTables(plan ?? [])) next.delete(planTableName(p))
    onExcludedChange(next)
  }

  const conceptCount = (p: DerivePlanTable) => filtered?.byTable.get(planTableName(p).toLowerCase())

  return (
    <>
      <FormField label={t('cohort_derive.scope')} hint={t('cohort_derive.scope_hint')} hintInTooltip>
        {({ id }) => (
          <Select value={scope} onValueChange={(v) => onScopeChange(v as DeriveScope)}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {derivationScopes(cohort.level).map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`cohort_derive.scope_${s}`)}
                  {s === cohort.level && <span className="text-muted-foreground"> · {t('cohort_derive.scope_cohort_level')}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      <FormField label={t('cohort_derive.variables')} hint={t('cohort_derive.variables_hint')} hintInTooltip>
        {({ id }) => (
          <Select value={variablesMode} onValueChange={(v) => onVariablesModeChange(v as VariablesMode)}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('cohort_derive.variables_all')}</SelectItem>
              <SelectItem value="list">{t('cohort_derive.variables_list')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>

      {variablesMode === 'list' && (
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex flex-wrap gap-1">
            {(variables?.conceptIds ?? []).map((id) => (
              <Badge key={id} variant="secondary" className="gap-1">
                <span className="max-w-48 truncate">{variables?.conceptNames[id] ?? id}</span>
                <span className="font-mono text-muted-foreground">{id}</span>
                <button
                  type="button"
                  aria-label={t('common.remove')}
                  className="rounded-sm hover:bg-muted"
                  onClick={() => {
                    const ids = variables!.conceptIds.filter((c) => c !== id)
                    onVariablesChange(ids.length ? { ...variables!, conceptIds: ids } : undefined)
                  }}
                >
                  <X size={10} />
                </button>
              </Badge>
            ))}
            {!variables?.conceptIds.length && (
              <span className="text-xs text-muted-foreground">{t('cohort_derive.variables_none')}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setPicking(true)}>
              <Plus size={12} />
              {t('cohort_derive.variables_pick')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={fromCriteria.conceptIds.length === 0}
              onClick={() => onVariablesChange(mergeVariables(variables, fromCriteria))}
            >
              <ListChecks size={12} />
              {t('cohort_derive.variables_from_criteria', { count: fromCriteria.conceptIds.length })}
            </Button>
          </div>
          {!!filtered?.unfiltered.length && (
            <p className="text-xs text-muted-foreground">
              {t('cohort_derive.variables_unfiltered', { relations: filtered.unfiltered.join(', ') })}
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-40 flex-1 flex-col gap-1.5">
        <div className="flex shrink-0 items-center gap-2">
          <SectionLabel info={t('cohort_derive.tables_info')}>
            {plan ? t('cohort_derive.tables_title', { copied, total: copyable.length }) : t('cohort_derive.tables')}
          </SectionLabel>
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={!plan} onClick={() => onExcludedChange(new Set())}>
              {t('cohort_derive.tables_all')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              disabled={!plan}
              onClick={() => onExcludedChange(new Set(copyable.map(planTableName)))}
            >
              {t('cohort_derive.tables_none')}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={!plan} onClick={tickPersonless}>
              {t('cohort_derive.tables_personless')}
            </Button>
          </div>
        </div>
        {planError ? (
          <FieldError message={t('cohort_derive.plan_error', { error: planError })} />
        ) : !plan ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {t('cohort_derive.plan_loading')}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            {copyable.map((p) => {
              const name = planTableName(p)
              const on = !excluded.has(name)
              const count = conceptCount(p)
              const id = `derive-table-${name}`
              return (
                <div key={name} className="flex items-start gap-2 border-b px-2 py-1 last:border-0">
                  <Checkbox id={id} className="mt-0.5" checked={on} onCheckedChange={(v) => toggle(name, v === true)} />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-xs">
                    <span className="font-mono">{name}</span>
                    <span className="block text-muted-foreground">
                      {p.filter ? t(FILTER_KEY[p.filter], { column: p.column }) : t('cohort_derive.filter_whole')}
                      {on && count !== undefined && (
                        <> · {count ? t('cohort_derive.table_variables', { count }) : t('cohort_derive.table_no_variable')}</>
                      )}
                    </span>
                  </label>
                </div>
              )
            })}
            {refused.map((p) => (
              <div key={planTableName(p)} className="flex items-start gap-2 border-b px-2 py-1 last:border-0">
                <Checkbox className="mt-0.5" checked={false} disabled />
                <div className="min-w-0 flex-1 text-xs">
                  <span className="font-mono text-muted-foreground">{planTableName(p)}</span>
                  <span className="block text-destructive">
                    {p.unresolved
                      ? t('cohort_derive.filter_unresolved', { relation: p.unresolved })
                      : t('cohort_derive.filter_unfilterable', { column: p.unfilterable })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CohortConceptPickerDialog
        open={picking}
        onOpenChange={setPicking}
        selectedConceptIds={variables?.conceptIds ?? []}
        selectedDictionaryKeys={variables?.dictionaryKeys}
        dataSourceId={source.id}
        schemaMapping={mapping}
        onConfirm={(conceptIds, conceptNames, dictionaryKeys) => {
          onVariablesChange(conceptIds.length
            ? { conceptIds, conceptNames: { ...variables?.conceptNames, ...conceptNames }, ...(dictionaryKeys ? { dictionaryKeys } : {}) }
            : undefined)
          setPicking(false)
        }}
      />
    </>
  )
}
