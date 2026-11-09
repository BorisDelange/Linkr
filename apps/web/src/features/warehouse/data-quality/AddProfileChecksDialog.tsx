import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { DialogShell } from '@/components/ui/dialog-shell'
import { setChecks, takesCheck, type ProfileRuleSet } from '@/lib/dq-profile'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { DqCustomCheck, DqProfile, DqProfileSource, DqRuleSet } from '@/types'
import { CATEGORY_COLORS, SEVERITY_CONFIG } from './DqConstants'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: DqProfile
  ruleSets: ProfileRuleSet[]
  checksByRuleSet: Record<string, DqCustomCheck[]>
  onAdd: (sources: DqProfileSource[]) => Promise<void>
}

interface Row {
  check: DqCustomCheck
  ruleSet: DqRuleSet
}

/**
 * Add checks to a quality profile from the workspace's rule sets: every check
 * the profile does not take yet, in one table to sort and filter by rule set,
 * origin, category, subcategory and severity.
 */
export function AddProfileChecksDialog({ open, onOpenChange, profile, ruleSets, checksByRuleSet, onAdd }: Props) {
  const { t, i18n } = useTranslation()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [visible, setVisible] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setPicked(new Set())
  }, [open])

  const rows = useMemo<Row[]>(() => ruleSets.flatMap(({ ruleSet }) => {
    const source = profile.sources.find((s) => s.ruleSetId === ruleSet.id)
    return (checksByRuleSet[ruleSet.id] ?? [])
      .filter((check) => !takesCheck(source, check.checkKey))
      .map((check) => ({ check, ruleSet }))
  }), [ruleSets, profile.sources, checksByRuleSet])

  const toggle = useCallback((ids: string[], on: boolean) => setPicked((prev) => {
    const next = new Set(prev)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    return next
  }), [])

  const columns = useMemo<DataTableColumn<Row>[]>(() => [
    {
      id: 'pick',
      header: t('common.select_all'),
      headerCell: () => {
        const n = visible.filter((r) => picked.has(r.check.id)).length
        return (
          <Checkbox
            checked={n > 0 && n === visible.length ? true : n > 0 ? 'indeterminate' : false}
            disabled={visible.length === 0}
            aria-label={t('common.select_all')}
            onCheckedChange={() => toggle(visible.map((r) => r.check.id), n !== visible.length)}
          />
        )
      },
      size: 36,
      sortable: false,
      accessor: (r) => (picked.has(r.check.id) ? 1 : 0),
      cell: (r) => (
        <Checkbox
          checked={picked.has(r.check.id)}
          onCheckedChange={(on) => toggle([r.check.id], !!on)}
        />
      ),
    },
    {
      id: 'ruleSet',
      header: t('data_quality.col_rule_set'),
      accessor: (r) => localized(r.ruleSet.name, i18n.language),
      filter: 'select',
      size: 170, minSize: 90,
      tooltip: true,
    },
    {
      id: 'check',
      header: t('data_quality.col_check'),
      accessor: (r) => r.check.name,
      filter: 'text',
      size: 260, minSize: 120,
      tooltip: 'font-medium',
    },
    {
      id: 'group',
      header: t('data_quality.col_table'),
      accessor: (r) => r.check.tableName ?? '',
      filter: 'select',
      size: 130, minSize: 70,
      cell: (r) => <span className="font-mono text-muted-foreground">{r.check.tableName ?? '—'}</span>,
    },
    {
      id: 'origin',
      header: t('data_quality.filter_origin'),
      accessor: (r) => r.check.origin,
      filter: 'select',
      selectOptionLabel: (v) => t(`data_quality.origin_${v}`),
      size: 110, minSize: 70,
      cell: (r) => <span className="text-muted-foreground">{t(`data_quality.origin_${r.check.origin}`)}</span>,
    },
    {
      id: 'category',
      header: t('data_quality.col_category'),
      accessor: (r) => r.check.category,
      filter: 'select',
      selectOptionLabel: (v) => t(`data_quality.category_${v}`),
      size: 130, minSize: 80,
      cell: (r) => (
        <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-medium', CATEGORY_COLORS[r.check.category])}>
          {t(`data_quality.category_${r.check.category}`)}
        </span>
      ),
    },
    {
      id: 'subcategory',
      header: t('data_quality.col_subcategory'),
      accessor: (r) => r.check.subcategory ?? '',
      filter: 'select',
      selectOptionLabel: (v) => (v ? t(`data_quality.subcategory_${v}`) : '—'),
      size: 110, minSize: 70,
      cell: (r) => (r.check.subcategory
        ? <span className="text-muted-foreground">{t(`data_quality.subcategory_${r.check.subcategory}`)}</span>
        : <span className="text-muted-foreground/50">—</span>),
    },
    {
      id: 'severity',
      header: t('data_quality.col_severity'),
      accessor: (r) => r.check.severity,
      filter: 'select',
      selectOptionLabel: (v) => t(`data_quality.severity_${v}`),
      size: 100, minSize: 70,
      cell: (r) => (
        <span className={SEVERITY_CONFIG[r.check.severity].color}>{t(`data_quality.severity_${r.check.severity}`)}</span>
      ),
    },
  ], [picked, visible, toggle, t, i18n.language])

  const add = async () => {
    if (picked.size === 0) return
    let sources = profile.sources
    for (const { ruleSet, ref } of ruleSets) {
      const checks = checksByRuleSet[ruleSet.id] ?? []
      const keys = checks.filter((c) => picked.has(c.id)).map((c) => c.checkKey)
      if (keys.length) sources = setChecks(sources, { id: ruleSet.id, ref }, checks.map((c) => c.checkKey), keys, true)
    }
    setBusy(true)
    try {
      await onAdd(sources)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      className="sm:max-w-6xl"
      title={t('data_quality.profile_add_title')}
      description={t('data_quality.profile_add_description')}
      onConfirm={add}
      confirmLabel={t('data_quality.profile_add_confirm', { count: picked.size })}
      confirmDisabled={picked.size === 0}
      busy={busy}
    >
      <DataTable
        data={rows}
        columns={columns}
        rowKey={(r) => r.check.id}
        pageSize={100}
        viewKey="dq-profile-add-checks"
        rowClassName={(r) => (r.check.disabled ? 'opacity-50' : undefined)}
        onRowClick={(r) => toggle([r.check.id], !picked.has(r.check.id))}
        // The header checkbox reads `visible`, so the columns change with it and
        // the table re-reports its rows: keep the same array when they are the
        // same rows, or each report triggers the next.
        onVisibleRowsChange={(next) => setVisible((prev) => (
          prev.length === next.length && prev.every((r, i) => r.check.id === next[i].check.id) ? prev : next
        ))}
        emptyMessage={t('data_quality.profile_add_empty')}
      />
    </DialogShell>
  )
}
