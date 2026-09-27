import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, BarChart3, BookOpen, CalendarDays, Download, Grid3x3, Layers, RotateCcw, Search, ShieldCheck, Sigma, SlidersHorizontal, Stethoscope,
  Table2, Tags, TrendingUp, User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DatePickerField, fromIsoDay } from '@/components/ui/date-picker-field'
import { MultiSelectFilter, MULTI_SELECT_FORM_TRIGGER } from '@/components/ui/multi-select-filter'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { StatCard } from '@/components/ui/stat-card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { catalogCounts } from '@/lib/data-catalog/config'
import { pageLocaleOf } from '@/lib/dcat-ap/page-text'
import { buildPublishedCatalog } from '@/lib/data-catalog/publish'
import { VARIABLE_COLORS } from '@/lib/data-catalog/variable-colors'
import { createExplorer, EXPLORE_TEXT, type ExploreData, type ExploreTable, type Explorer } from '@/lib/dcat-ap/catalog-explore'
import { chartCss } from '@/lib/dcat-ap/export-html-style'
import { buildConceptTable } from '@/lib/dcat-ap/export-html'
import { ENTITY_COLORS } from '@/lib/entity-colors'
import { cn } from '@/lib/utils'
import type { CatalogVariableId } from '@/types/catalog'
import type { CatalogResultCache, DataCatalog } from '@/types'
import { CrossingBadges } from './variable-badge'
import { VARIABLE_ICON } from './variable-icons'

interface Props {
  catalog: DataCatalog
  cache: CatalogResultCache
}

type Row = Record<string, unknown>

/*
 * The Data tab reads the computed catalog the way the published page does —
 * same engine (lib/dcat-ap/catalog-explore.js), same charts — but with the
 * numbers the masks hide still there: a secondary-suppressed cell shows its
 * value struck through, so the effect of the threshold can be checked before
 * anything is published.
 */

/**
 * The page's chart styles, mapped to the app's theme. Scoped to the engine's
 * own markup (`.xp-v`): the page's variable names (--muted, --card…) are also
 * the app's theme tokens, and redefining them any wider recolours the app's
 * components around the charts.
 */
const EXPLORE_STYLE = `.xp-v{--card:var(--color-card);--ink:var(--color-foreground);--text:var(--color-foreground);--muted:var(--color-muted-foreground);--line:var(--color-border);--line-soft:var(--color-border);--soft:var(--color-muted);--blue:var(--color-primary);--blue2:var(--color-primary);--accent-soft:color-mix(in srgb,var(--color-primary) 12%,transparent);--hatch:var(--color-muted);--warn:#d97706}
${chartCss('.xp-v')}`

const STAT_ICON: Record<string, ReactNode> = {
  user: <User size={18} />, stethoscope: <Stethoscope size={18} />, activity: <Activity size={18} />, tags: <Tags size={18} />,
  layers: <Layers size={18} />, trendingUp: <TrendingUp size={18} />, barChart: <BarChart3 size={18} />, sigma: <Sigma size={18} />,
  shield: <ShieldCheck size={18} />, grid: <Grid3x3 size={18} />,
}

function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/** The engine over this catalog, with a render counter bumped by every state change. */
function useExplorer(catalog: DataCatalog, cache: CatalogResultCache): [Explorer, (change?: (x: Explorer) => void) => void] {
  const { t, i18n } = useTranslation()
  const explorer = useMemo(() => {
    const threshold = catalog.anonymization.threshold
    // The labels the published page would carry, in the app's language.
    const locale = pageLocaleOf(i18n.language)
    const published = buildPublishedCatalog(catalog, cache, { reveal: true, locale })
    const counts = catalogCounts(catalog)
    const concepts = buildConceptTable(cache.concepts.map((r) => ({ ...r, _anonymized: r.patientCount < threshold })), locale)
    const data: ExploreData = {
      ...published,
      concepts,
      totals: {
        patients: cache.totalPatients,
        ...(counts.visits ? { stays: cache.totalVisits } : {}),
        ...(counts.unitStays && cache.grandTotal.totalUnitStays != null ? { unitStays: cache.grandTotal.totalUnitStays } : {}),
        records: cache.grandTotal.totalRecords,
        concepts: new Set(cache.concepts.map((r) => r.conceptId)).size,
      },
    }
    const text = Object.fromEntries(Object.keys(EXPLORE_TEXT).map((k) => [k, t(`data_catalog.xp.${k}`)]))
    return createExplorer(data, {
      reveal: true,
      text,
      locale: i18n.language,
      dark: () => document.documentElement.classList.contains('dark'),
      fileBase: 'catalog',
    })
  }, [catalog, cache, t, i18n.language])
  const [, setVersion] = useState(0)
  const update = useCallback((change?: (x: Explorer) => void) => {
    change?.(explorer)
    setVersion((n) => n + 1)
  }, [explorer])
  return [explorer, update]
}

export function CatalogDataTab({ catalog, cache }: Props) {
  const { t } = useTranslation()
  const [xp, update] = useExplorer(catalog, cache)
  const view = xp.view()
  const S = xp.S
  const rootRef = useRef<HTMLDivElement>(null)

  if (!S.crossing) return <EmptyState icon={BookOpen} title={t('data_catalog.no_data')} />

  // The engine's own controls inside the charts: heatmap scale and top N.
  const onChartsClick = (e: React.MouseEvent) => {
    const button = (e.target as HTMLElement).closest('[data-act] button') as HTMLButtonElement | null
    const act = button?.closest<HTMLElement>('[data-act]')?.dataset.act
    if (!button || !act) return
    if (act === 'scale') update((x) => { x.S.scale = button.dataset.v as 'row' | 'all' })
    else if (act === 'topn') update((x) => { x.S.topN = Number(button.dataset.v) })
  }

  return (
    <div ref={rootRef} className="catalog-explore grid grid-cols-1 items-start gap-4 py-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <style>{EXPLORE_STYLE}</style>
      <ExploreSidebar xp={xp} update={update} />

      <div className="flex min-w-0 flex-col gap-4" onClick={onChartsClick}>
        <Tabs value={S.tab} onValueChange={(v) => update((x) => { x.S.tab = v as 'charts' | 'table' })} className="items-center">
          <TabsList>
            <TabsTrigger value="charts"><BarChart3 size={14} />{t('data_catalog.xp_tab_charts')}</TabsTrigger>
            <TabsTrigger value="table"><Table2 size={14} />{t('data_catalog.xp_tab_table')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{view.title}</h3>
          {view.context.map((c) => (
            <span key={c.v} className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', VARIABLE_COLORS[c.v].badge)}>
              {`${c.label} : ${c.value}`}
            </span>
          ))}
        </div>

        {S.tab === 'charts' && view.stats.length > 0 && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {view.stats.map((s) => (
              <StatCard
                key={s.key}
                className="p-3 shadow-none"
                icon={STAT_ICON[s.icon] ?? STAT_ICON.activity}
                iconBg={cn(ENTITY_COLORS.project.bg, ENTITY_COLORS.project.icon)}
                value={s.value}
                label={s.label}
                detail={s.sub ? <span className="text-[10px] text-muted-foreground" title={s.sub}>{s.sub}</span> : undefined}
              />
            ))}
          </div>
        )}

        {view.empty && view.blocks.length === 0 && (
          <Card className="p-8 text-center text-xs text-muted-foreground">{view.empty}</Card>
        )}

        {S.tab === 'charts' && view.blocks.length > 0 && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {view.blocks.map((b, i) => (
              <Card key={`${S.crossing}-${i}-${b.title}`} className={cn('min-w-0 gap-2 p-4', b.size === 'full' && 'xl:col-span-2')}>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h4 className="text-xs font-semibold">{b.title}</h4>
                  {b.sub && <span className="text-[10px] text-muted-foreground">{b.sub}</span>}
                  <span className="flex-1" />
                  {/* Engine-rendered, trusted: the block's own segmented control. */}
                  {b.head && <span className="xp-v" dangerouslySetInnerHTML={{ __html: b.head }} />}
                  {b.csv && (
                    <Button variant="outline" size="xs" onClick={() => downloadCsv(b.csv!.name, b.csv!.text())}>
                      <Download />CSV
                    </Button>
                  )}
                </div>
                <ChartBody render={b.render} />
                {b.note && <p className="text-[10px] text-muted-foreground">{b.note}</p>}
              </Card>
            ))}
          </div>
        )}

        {S.tab === 'table' && view.table && (
          <div className="overflow-hidden rounded-lg border bg-card">
            <ExploreDataTable key={`${S.crossing}|${JSON.stringify(view.context)}|${S.metric}`} table={view.table} threshold={catalog.anonymization.threshold} />
          </div>
        )}
      </div>
      <DataTips root={rootRef} />
    </div>
  )
}

/** An engine chart, drawn at its container's width and redrawn when that changes. */
function ChartBody({ render }: { render: (width: number) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)))
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth))
    return () => ro.disconnect()
  }, [])
  // The markup comes from the engine, which escapes every data string it draws.
  return <div ref={ref} className="xp-v min-w-0" dangerouslySetInnerHTML={{ __html: width > 0 ? render(width) : '' }} />
}

/** The charts' hover tooltips: any element carrying `data-tip` (engine-built, escaped HTML). */
function DataTips({ root }: { root: React.RefObject<HTMLDivElement | null> }) {
  const tip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    const box = tip.current
    if (!el || !box) return
    let target: Element | null = null
    const over = (e: MouseEvent) => {
      const t = (e.target as Element | null)?.closest?.('[data-tip]') ?? null
      if (t === target) return
      target = t
      if (!t) { box.classList.remove('on'); return }
      box.innerHTML = t.getAttribute('data-tip') ?? ''
      box.classList.add('on')
    }
    const move = (e: MouseEvent) => {
      if (!target) return
      const r = box.getBoundingClientRect()
      let x = e.clientX + 14
      let y = e.clientY + 14
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14
      box.style.transform = `translate(${Math.max(8, x)}px,${Math.max(8, y)}px)`
    }
    const leave = () => { target = null; box.classList.remove('on') }
    el.addEventListener('mouseover', over)
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseleave', leave)
    return () => {
      el.removeEventListener('mouseover', over)
      el.removeEventListener('mousemove', move)
      el.removeEventListener('mouseleave', leave)
    }
  }, [root])
  return <div className="xp-v"><div ref={tip} className="tip" /></div>
}

// ── Sidebar ──────────────────────────────────────────────────────

function ExploreSidebar({ xp, update }: { xp: Explorer; update: (change?: (x: Explorer) => void) => void }) {
  const { t } = useTranslation()
  const S = xp.S
  const vars = xp.varsOf(S.crossing)
  const measures = xp.measures()

  return (
    <Card className="flex max-h-[calc(100vh-10rem)] flex-col gap-4 overflow-y-auto p-4 lg:sticky lg:top-4">
      <div className="grid gap-2">
        <SectionLabel>{t('data_catalog.xp_variables')}</SectionLabel>
        <Select value={S.crossing ?? ''} onValueChange={(id) => update((x) => x.setCrossing(id))}>
          <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {xp.options().map((g) => (
              <SelectGroup key={g.size}>
                <SelectLabel>{t(`data_catalog.xp_group_${g.size}`)}</SelectLabel>
                {g.items.map((it) => (
                  <SelectItem key={it.id} value={it.id} className="text-xs">{it.vars.map(xp.varLabel).join(' × ')}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <CrossingBadges vars={vars} />
      </div>

      {measures.length > 1 && (
        <div className="grid gap-2 border-t pt-3">
          <SectionLabel>{t('data_catalog.xp_count')}</SectionLabel>
          <Select value={measures.includes(S.metric) ? S.metric : 'patients'} onValueChange={(m) => update((x) => { x.S.metric = m as typeof S.metric })}>
            <SelectTrigger className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {measures.map((m) => <SelectItem key={m} value={m} className="text-xs">{xp.measureLabel(m)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid gap-4 border-t pt-3">
        <SectionLabel>{t('data_catalog.xp_filters')}</SectionLabel>
        {S.pin && <PinFilter xp={xp} vars={vars} update={update} />}
        {vars.filter((v) => v !== S.pin).map((v) => (
          v === 'period' ? <PeriodFilter key={v} xp={xp} update={update} />
            : v === 'concept' && (xp.isListView() || xp.V.concept?.level === 'concept') ? <ConceptFilter key={v} xp={xp} update={update} />
            : <NominalFilter key={v} xp={xp} v={v} update={update} />
        ))}
      </div>

      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => update((x) => x.reset())}>
        <RotateCcw size={14} />
        {t('data_catalog.xp_reset')}
      </Button>
    </Card>
  )
}

function FilterHead({ v, label, children }: { v: CatalogVariableId; label: string; children?: ReactNode }) {
  const Icon = VARIABLE_ICON[v]
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={12} className={VARIABLE_COLORS[v].icon} />
      <Label>{label}</Label>
      <span className="flex-1" />
      {children}
    </div>
  )
}

function NominalFilter({ xp, v, update }: { xp: Explorer; v: CatalogVariableId; update: (change?: (x: Explorer) => void) => void }) {
  const { t } = useTranslation()
  const vr = xp.V[v]!
  const sel = xp.S.sel[v]
  const n = vr.mods.length
  // The engine keeps no selection for "all"; the control keeps none for "no filter".
  const value = sel ? Object.keys(sel) : []
  return (
    <div className="grid gap-1.5">
      <FilterHead v={v} label={vr.label} />
      <MultiSelectFilter
        value={value}
        options={vr.names.map((name, i) => ({ value: String(i), label: name }))}
        placeholder={t('data_catalog.xp_all')}
        triggerClass={MULTI_SELECT_FORM_TRIGGER}
        showChevron
        onChange={(next) => update((x) => {
          if (next.length === 0 || next.length === n) delete x.S.sel[v]
          else x.S.sel[v] = Object.fromEntries(next.map((i) => [Number(i), true as const]))
        })}
      />
    </div>
  )
}

/** First and last day of a period modality, which spans `step` units from the one it names. */
function periodBounds(code: string, step = 1): [string, string] {
  const pad = (n: number) => String(n).padStart(2, '0')
  const q = /^(\d{4})-Q([1-4])$/.exec(code)
  const m = /^(\d{4})-(\d{2})$/.exec(code)
  const first = q ? Number(q[1]) * 12 + (Number(q[2]) - 1) * 3 : m ? Number(m[1]) * 12 + Number(m[2]) - 1 : Number(code) * 12
  const last = first + (q ? 3 : m ? 1 : 12) * step - 1
  const ly = Math.floor(last / 12)
  const lm = (last % 12) + 1
  const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate()
  return [`${Math.floor(first / 12)}-${pad((first % 12) + 1)}-01`, `${ly}-${pad(lm)}-${pad(lastDay)}`]
}

function PeriodFilter({ xp, update }: { xp: Explorer; update: (change?: (x: Explorer) => void) => void }) {
  const { t } = useTranslation()
  const vr = xp.V.period!
  const n = vr.mods.length
  const step = vr.step ?? 1
  const bounds = (code: string) => periodBounds(code, step)
  const r = xp.S.range ?? [0, n - 1]
  const setRange = (next: [number, number]) => update((x) => { x.S.range = next[0] === 0 && next[1] === n - 1 ? null : next })
  const fromDate = (end: 0 | 1, date: string) => {
    const next: [number, number] = [...r]
    if (!date) next[end] = end === 0 ? 0 : n - 1
    else {
      let idx = -1
      for (let k = 0; k < n; k++) {
        const b = bounds(vr.mods[k])
        if (end === 0 ? b[1] >= date : b[0] <= date) { idx = k; if (end === 0) break }
      }
      if (idx !== -1) next[end] = idx
    }
    if (next[0] > next[1]) next[end === 0 ? 1 : 0] = next[end]
    setRange(next)
  }
  const calendar = xp.S.periodMode === 'calendar'
  const preset = !xp.S.range ? 'all' : r[1] === n - 1 && (n - r[0] === 12 || n - r[0] === 5) ? String(n - r[0]) : ''
  return (
    <div className="grid gap-2">
      <FilterHead v="period" label={vr.label}>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          title={t(calendar ? 'data_catalog.xp_slider' : 'data_catalog.xp_calendar')}
          aria-label={t(calendar ? 'data_catalog.xp_slider' : 'data_catalog.xp_calendar')}
          onClick={() => update((x) => { x.S.periodMode = calendar ? 'slider' : 'calendar' })}
        >
          {calendar ? <SlidersHorizontal /> : <CalendarDays />}
        </Button>
      </FilterHead>
      {calendar ? (
        <div className="grid gap-1.5">
          {([0, 1] as const).map((end) => (
            <DatePickerField
              key={end}
              value={bounds(vr.mods[r[end]])[end]}
              onChange={(d) => fromDate(end, d ?? '')}
              clearable={false}
              disabledDays={{ before: fromIsoDay(bounds(vr.mods[0])[0])!, after: fromIsoDay(bounds(vr.mods[n - 1])[1])! }}
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-1.5">
          <div className="flex justify-between text-[10px] text-muted-foreground"><span>{vr.names[r[0]]}</span><span>{vr.names[r[1]]}</span></div>
          <Slider min={0} max={Math.max(0, n - 1)} step={1} minStepsBetweenThumbs={0} value={r} onValueChange={(v) => setRange([v[0], v[1]])} />
        </div>
      )}
      <Select value={preset} onValueChange={(p) => setRange(p === 'all' ? [0, n - 1] : [n - Number(p), n - 1])}>
        <SelectTrigger className="h-8 w-full text-xs"><SelectValue placeholder={t('data_catalog.xp_custom_range')} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-xs">{t('data_catalog.xp_all_periods')}</SelectItem>
          {n > 12 && <SelectItem value="12" className="text-xs">{t('data_catalog.xp_last', { n: 12 })}</SelectItem>}
          {n > 5 && <SelectItem value="5" className="text-xs">{t('data_catalog.xp_last', { n: 5 })}</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  )
}

function ConceptFilter({ xp, update }: { xp: Explorer; update: (change?: (x: Explorer) => void) => void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState(xp.S.cq)
  useEffect(() => {
    const id = setTimeout(() => update((x) => { x.S.cq = q }), 200)
    return () => clearTimeout(id)
  }, [q, update])
  const cats = xp.conceptCategories()
  return (
    <div className="grid gap-1.5">
      <FilterHead v="concept" label={xp.varLabel('concept')} />
      <div className="relative">
        <Search size={12} className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-7 pl-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('data_catalog.search_concepts')} />
      </div>
      {cats.length > 0 && (
        <Select value={xp.S.ccat || '__all__'} onValueChange={(c) => update((x) => { x.S.ccat = c === '__all__' ? '' : c })}>
          <SelectTrigger className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__" className="text-xs">{t('data_catalog.xp_all_categories')}</SelectItem>
            {cats.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

/** A three-variable crossing: one of its variables is read one value at a time. */
function PinFilter({ xp, vars, update }: { xp: Explorer; vars: CatalogVariableId[]; update: (change?: (x: Explorer) => void) => void }) {
  const { t } = useTranslation()
  const pin = xp.S.pin!
  const vr = xp.V[pin]!
  const canAll = xp.canUnpin()
  return (
    <div className="grid gap-1.5">
      <FilterHead v={pin} label={t('data_catalog.xp_pin')} />
      <Select value={pin} onValueChange={(v) => update((x) => { x.S.pin = v as CatalogVariableId; x.S.pinVal = null })}>
        <SelectTrigger className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {vars.map((v) => <SelectItem key={v} value={v} className="text-xs">{xp.varLabel(v)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={xp.S.pinVal == null ? '__all__' : String(xp.S.pinVal)} onValueChange={(v) => update((x) => { x.S.pinVal = v === '__all__' ? null : Number(v) })}>
        <SelectTrigger className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {canAll && <SelectItem value="__all__" className="text-xs">{t('data_catalog.xp_all')}</SelectItem>}
          {vr.names.map((name, i) => <SelectItem key={i} value={String(i)} className="text-xs">{name}</SelectItem>)}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">{t(canAll ? 'data_catalog.xp_pin_hint_all' : 'data_catalog.xp_pin_hint')}</p>
    </div>
  )
}

// ── Table ────────────────────────────────────────────────────────

const CONCEPT_HEADER: Record<string, string> = {
  conceptId: 'col_concept_id', conceptName: 'col_concept_name', dictionaryKey: 'col_vocabulary', category: 'col_category',
  subcategory: 'col_subcategory', patientCount: 'col_patients', visitCount: 'col_visits', recordCount: 'col_records',
}

function ExploreDataTable({ table, threshold }: { table: ExploreTable; threshold: number }) {
  const { t } = useTranslation()
  const columns = useMemo<DataTableColumn<Row>[]>(() => {
    const masked = <span className="text-amber-600 dark:text-amber-400">{`< ${threshold}`}</span>
    return table.columns.map((c): DataTableColumn<Row> => {
      const label = table.kind === 'concepts' && CONCEPT_HEADER[c.key] ? t(`data_catalog.${CONCEPT_HEADER[c.key]}`) : c.label
      if (c.type !== 'number') {
        return {
          id: c.key, header: label, accessor: (r) => (r[c.key] as string | number | null) ?? null,
          filter: c.filter === 'select' ? 'select' : 'text', size: c.width ?? 160, pinned: c.key === table.columns[0].key,
          cellClassName: c.key === 'conceptId' ? 'font-mono' : undefined,
        }
      }
      const value = (r: Row) => r[c.key] as number | null
      return {
        id: c.key, header: label, accessor: (r) => value(r), align: 'right', cellClassName: 'tabular-nums', size: 110, minSize: 70, filter: 'number',
        cell: (r) => {
          if (table.kind === 'concepts') return r._anon ? masked : (value(r) ?? 0).toLocaleString()
          const st = r._st as number
          if (st === 2) {
            return (
              <span className="text-amber-600 line-through decoration-dotted dark:text-amber-400" title={table.maskTip?.[2]}>{value(r)?.toLocaleString()}</span>
            )
          }
          if (st) return <span title={table.maskTip?.[st]}>{masked}</span>
          return value(r)?.toLocaleString() ?? ''
        },
      }
    })
  }, [table, threshold, t])
  return (
    <DataTable
      data={table.rows}
      columns={columns}
      rowKey={(r) => table.columns.filter((c) => c.type !== 'number').map((c) => String(r[c.key])).join('|')}
      pageSize={100}
      stickyHeader
      cellTooltips="all"
      initialSorting={table.initialSort ? { columnId: table.initialSort.key, desc: table.initialSort.desc } : undefined}
      emptyMessage={t('data_catalog.no_results')}
    />
  )
}
