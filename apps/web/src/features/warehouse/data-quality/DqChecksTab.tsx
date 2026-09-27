import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  Plus,
  Trash2,
  PanelLeft,
  Play,
  Loader2,
  Save,
  ShieldCheck,
  Filter,
  Pencil,
  Eye,
  EyeOff,
  ListChecks,
  X,
  Database,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Info,
  Undo2,
  Search,
  FileCode2,
  Waypoints,
  SquarePen,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import { SectionLabel } from '@/components/ui/section-label'
import { InlineRenameField } from '@/components/InlineRenameField'
import {
  SidebarSearchField,
  SidebarSearchToggle,
  matchesSidebarSearch,
  useSidebarSearch,
} from '@/components/SidebarSearch'
import { useOverflowTooltip } from '@/hooks/use-overflow-tooltip'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { queryDataSource } from '@/lib/duckdb/engine'
import { checkStatus } from '@/lib/duckdb/data-quality'
import {
  DQ_CATEGORIES,
  DQ_SEVERITIES,
  DQ_SUBCATEGORIES,
  subcategoryFor,
  type DqCategory,
  type DqCheckOrigin,
  type DqSeverity,
  type DqSubcategory,
} from '@/lib/dq-taxonomy'
import { makeCheck } from '@/lib/dq-templates'
import { useDqStore, type CheckQueryField } from '@/stores/dq-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { localized } from '@/lib/localized'
import { buildPointer } from '@/lib/import-identity'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { CATEGORY_COLORS } from './DqConstants'
import { AddSchemaChecksDialog } from './AddSchemaChecksDialog'
import type { DqCustomCheck } from '@/types'

interface Props {
  ruleSetId: string
  dataSourceId: string
  /** Opens the rule set's investigation console with this query. */
  onInvestigate: (sql: string) => void
}

type OriginFilter = 'all' | DqCheckOrigin
type CategoryFilter = 'all' | DqCategory

const ORIGINS: DqCheckOrigin[] = ['ddl', 'mapping', 'manual']
const NO_SUBCATEGORY = '__none__'
// Up to this many checks every group starts open; beyond, they start folded.
const OPEN_GROUPS_UP_TO = 40

interface TestResult {
  success: boolean
  lines: string[]
}

interface CheckGroup {
  key: string
  label: string
  checks: DqCustomCheck[]
}

export function DqChecksTab({ ruleSetId, dataSourceId, onInvestigate }: Props) {
  const { t, i18n } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const {
    customChecks,
    selectedCheckId,
    selectCheck,
    createCustomCheck,
    deleteCustomCheck,
    updateCustomCheck,
    updateCheckQuery,
    isCheckDirty,
    saveCheck,
    revertCheck,
    setChecksDisabled,
    _dirtyVersion,
  } = useDqStore()
  const ruleSetWorkspaceId = useDqStore(
    (s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId)?.workspaceId,
  )
  const updateRuleSet = useDqStore((s) => s.updateRuleSet)
  // Resolving the CURRENT database stays unscoped, so one selected earlier is
  // still nameable; only what the picker OFFERS is scoped to the rule set's
  // own workspace.
  const dbSources = useDatabaseOptions(ruleSetWorkspaceId)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const search = useSidebarSearch()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [queryField, setQueryField] = useState<CheckQueryField>('sql')
  // Set when a run is asked for with no database picked; cleared by picking one.
  const [databaseMissing, setDatabaseMissing] = useState(false)
  const [addFromSchema, setAddFromSchema] = useState<'ddl' | 'mapping' | null>(null)
  // Groups the user folded or unfolded, against the default for the list size.
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(new Set())

  // Sidebar edit mode: multi-select via checkboxes + bulk enable/disable/delete.
  const [editMode, setEditMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Delete confirmation: a single check id, or 'bulk' for the selection.
  const [deleteTarget, setDeleteTarget] = useState<string | 'bulk' | null>(null)

  // Force re-render when dirty state changes
  void _dirtyVersion

  const selectedCheck = customChecks.find((c) => c.id === selectedCheckId)

  const filteredChecks = useMemo(() => customChecks.filter((c) =>
    (originFilter === 'all' || c.origin === originFilter)
    && (categoryFilter === 'all' || c.category === categoryFilter)
    && (matchesSidebarSearch(c.name, search.query) || matchesSidebarSearch(c.tableName ?? '', search.query)),
  ), [customChecks, originFilter, categoryFilter, search.query])

  // One group per table or relation, in list order; hand-written checks that
  // name none share a last group.
  const groups = useMemo<CheckGroup[]>(() => {
    const byKey = new Map<string, CheckGroup>()
    for (const check of filteredChecks) {
      const key = check.tableName ?? ''
      let group = byKey.get(key)
      if (!group) {
        group = { key, label: check.tableName ?? t('data_quality.group_other'), checks: [] }
        byKey.set(key, group)
      }
      group.checks.push(check)
    }
    const other = byKey.get('')
    byKey.delete('')
    return other ? [...byKey.values(), other] : [...byKey.values()]
  }, [filteredChecks, t])

  const groupsOpenByDefault = customChecks.length <= OPEN_GROUPS_UP_TO
  const isGroupOpen = (key: string) =>
    !!search.query || groups.length === 1 || (groupsOpenByDefault !== toggledGroups.has(key))
  const toggleGroup = (key: string) => setToggledGroups((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const handleNewCheck = useCallback(async () => {
    const check = makeCheck(ruleSetId, customChecks.reduce((max, c) => Math.max(max, c.order + 1), 0), {
      name: t('data_quality.new_check_name', { n: customChecks.filter((c) => c.origin === 'manual').length + 1 }),
      description: '',
      category: 'plausibility',
      subcategory: 'atemporal',
      severity: 'warning',
      threshold: 0,
      sql: t('data_quality.new_check_sql'),
      exploreSql: t('data_quality.new_check_explore_sql'),
      origin: 'manual',
      templateKey: null,
      tableName: null,
    })
    await createCustomCheck(check)
    selectCheck(check.id)
    setOriginFilter((f) => (f === 'all' || f === 'manual' ? f : 'all'))
    setCategoryFilter((f) => (f === 'all' || f === check.category ? f : 'all'))
  }, [ruleSetId, customChecks, createCustomCheck, selectCheck, t])

  const commitRename = useCallback((name: string) => {
    if (!renamingId || !name) return
    void updateCustomCheck(renamingId, { name })
    setRenamingId(null)
  }, [renamingId, updateCustomCheck])

  // --- Multi-select (edit mode) ---
  const allVisibleIds = useMemo(() => filteredChecks.map((c) => c.id), [filteredChecks])
  const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selectedIds.has(id))

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(allVisibleIds))
  }, [allSelected, allVisibleIds])

  const exitEditMode = useCallback(() => {
    setEditMode(false)
    setSelectedIds(new Set())
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    const ids = deleteTarget === 'bulk' ? [...selectedIds] : deleteTarget ? [deleteTarget] : []
    for (const id of ids) await deleteCustomCheck(id)
    setDeleteTarget(null)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }, [deleteTarget, selectedIds, deleteCustomCheck])

  const formatPct = useCallback(
    (n: number) => n.toLocaleString(i18n.language, { maximumFractionDigits: 2 }),
    [i18n.language],
  )

  const handleTest = useCallback(async () => {
    if (!dataSourceId) {
      setDatabaseMissing(true)
      return
    }
    if (!selectedCheck || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      await ensureMounted(dataSourceId)
      const rows = await queryDataSource(dataSourceId, selectedCheck.sql)
      if (!rows.length) {
        setTestResult({ success: false, lines: [t('data_quality.test_result_no_rows'), t('data_quality.test_expected_shape')] })
        return
      }
      const row = rows[0]
      if (!('violated_rows' in row) || !('total_rows' in row)) {
        setTestResult({
          success: false,
          lines: [
            t('data_quality.test_result_missing_columns', { columns: Object.keys(row).join(', ') }),
            t('data_quality.test_expected_shape'),
          ],
        })
        return
      }
      const violated = Number(row.violated_rows ?? 0)
      const total = Number(row.total_rows ?? 0)
      const status = checkStatus(violated, total, selectedCheck.threshold)
      const pct = total > 0 ? (violated / total) * 100 : 0
      const counts = t('data_quality.test_result_counts', {
        violated: violated.toLocaleString(i18n.language),
        total: total.toLocaleString(i18n.language),
        pct: formatPct(pct),
      })
      const rule = selectedCheck.threshold === 0
        ? t('data_quality.test_rule_zero')
        : t('data_quality.test_rule_threshold', { threshold: formatPct(selectedCheck.threshold) })
      if (status === 'not_applicable') {
        setTestResult({ success: true, lines: [t('data_quality.test_result_not_applicable'), counts] })
      } else {
        setTestResult({
          success: status === 'pass',
          lines: [status === 'pass' ? t('data_quality.test_result_pass') : t('data_quality.test_result_fail'), counts, rule],
        })
      }
    } catch (err) {
      setTestResult({
        success: false,
        lines: [t('data_quality.test_result_error', { message: err instanceof Error ? err.message : String(err) })],
      })
    } finally {
      setTesting(false)
    }
  }, [selectedCheck, testing, dataSourceId, ensureMounted, formatPct, i18n.language, t])

  const investigate = () => {
    if (!dataSourceId) {
      setDatabaseMissing(true)
      return
    }
    if (selectedCheck) onInvestigate(selectedCheck.exploreSql?.trim() ? selectedCheck.exploreSql : selectedCheck.sql)
  }

  const handleSave = useCallback(async () => {
    if (selectedCheck) await saveCheck(selectedCheck.id)
  }, [selectedCheck, saveCheck])

  const handleCategoryChange = (check: DqCustomCheck, category: DqCategory) => {
    void updateCustomCheck(check.id, {
      category,
      subcategory: subcategoryFor(category, check.subcategory) ?? DQ_SUBCATEGORIES[category][0] ?? null,
    })
  }

  const filtered = originFilter !== 'all' || categoryFilter !== 'all'

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-1 border-b px-3 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={sidebarVisible ? 'secondary' : 'ghost'}
                size="icon-xs"
                onClick={() => setSidebarVisible(!sidebarVisible)}
              >
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('data_quality.checks')}</TooltipContent>
          </Tooltip>

          {selectedCheck && (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={handleTest}
                disabled={testing || !dataSourceId}
                className="h-6 gap-1 px-2 text-xs"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testing ? t('data_quality.testing') : t('data_quality.test_check')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={investigate}
                disabled={!dataSourceId}
                className="h-6 gap-1 px-2 text-xs"
              >
                <Search size={14} />
                {t('data_quality.investigate')}
              </Button>
            </>
          )}

          {/* The database the checks run against. It lives here rather than on
              the page's tab row because it is what Test runs against — beside
              the button it governs. */}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {databaseMissing && !dataSourceId && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle size={12} className="shrink-0" />
                {t('data_quality.select_database_first')}
              </span>
            )}
            <Select
              value={dataSourceId}
              onValueChange={(value) => {
                setDatabaseMissing(false)
                void updateRuleSet(ruleSetId, {
                  dataSourceId: value,
                  dataSourceRef: buildPointer(dbSources, value),
                })
              }}
              disabled={!canWrite}
            >
              <SelectTrigger size="xs" className="w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
                <Database size={12} className="text-muted-foreground" />
                <SelectValue placeholder={t('data_quality.select_database')} />
              </SelectTrigger>
              <SelectContent>
                {dbSources.map((ds) => (
                  <SelectItem key={ds.id} value={ds.id}>
                    {localized(ds.name, i18n.language)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            {/* Check list sidebar */}
            <Allotment.Pane preferredSize={300} minSize={180} maxSize={600} visible={sidebarVisible}>
              <div className="flex h-full min-h-0 flex-col border-r">
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <SectionLabel>
                    {t('data_quality.checks')}
                    <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70">
                      {filtered || search.query ? `${filteredChecks.length}/${customChecks.length}` : customChecks.length}
                    </span>
                  </SectionLabel>
                  <div className="flex items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant={filtered ? 'secondary' : 'ghost'} size="icon-xs">
                          <Filter size={12} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" density="compact" className="w-44">
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('data_quality.filter_origin')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem checked={originFilter === 'all'} onCheckedChange={() => setOriginFilter('all')}>
                          {t('data_quality.filter_all')}
                        </DropdownMenuCheckboxItem>
                        {ORIGINS.map((o) => (
                          <DropdownMenuCheckboxItem key={o} checked={originFilter === o} onCheckedChange={() => setOriginFilter(o)}>
                            {t(`data_quality.origin_${o}`)}
                          </DropdownMenuCheckboxItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('data_quality.filter_category')}</DropdownMenuLabel>
                        <DropdownMenuCheckboxItem checked={categoryFilter === 'all'} onCheckedChange={() => setCategoryFilter('all')}>
                          {t('data_quality.filter_all')}
                        </DropdownMenuCheckboxItem>
                        {DQ_CATEGORIES.map((c) => (
                          <DropdownMenuCheckboxItem key={c} checked={categoryFilter === c} onCheckedChange={() => setCategoryFilter(c)}>
                            {t(`data_quality.category_${c}`)}
                          </DropdownMenuCheckboxItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {canWrite && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant={editMode ? 'secondary' : 'ghost'}
                            size="icon-xs"
                            onClick={() => (editMode ? exitEditMode() : setEditMode(true))}
                          >
                            <ListChecks size={13} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{editMode ? t('common.done') : t('data_quality.select_multiple')}</TooltipContent>
                      </Tooltip>
                    )}
                    <SidebarSearchToggle
                      open={search.open}
                      onToggle={search.toggle}
                      label={t('data_quality.search_checks')}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={!canWrite}>
                          <Plus size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" density="compact" className="w-48">
                        <DropdownMenuItem onClick={() => void handleNewCheck()}>
                          <SquarePen />
                          {t('data_quality.add_manual')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setAddFromSchema('ddl')}>
                          <FileCode2 />
                          {t('data_quality.add_from_ddl')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setAddFromSchema('mapping')}>
                          <Waypoints />
                          {t('data_quality.add_from_mapping')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {search.open && (
                  <SidebarSearchField
                    value={search.query}
                    onChange={search.setQuery}
                    onClose={search.toggle}
                    placeholder={t('data_quality.search_checks')}
                  />
                )}

                {/* Bulk action bar (edit mode) */}
                {editMode && (
                  <div className="flex items-center gap-1 border-b bg-accent/30 px-2 py-1">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleSelectAll}
                      className="size-3.5 shrink-0"
                      aria-label={t('data_quality.select_all')}
                    />
                    <span className="mr-auto text-[10px] text-muted-foreground">
                      {t('data_quality.n_selected', { count: selectedIds.size })}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => void setChecksDisabled([...selectedIds], false)}>
                          <Eye size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.enable_check')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => void setChecksDisabled([...selectedIds], true)}>
                          <EyeOff size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.disable_check')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={selectedIds.size === 0}
                          onClick={() => setDeleteTarget('bulk')}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('common.delete')}</TooltipContent>
                    </Tooltip>
                    <Button variant="ghost" size="icon-xs" onClick={exitEditMode}>
                      <X size={12} />
                    </Button>
                  </div>
                )}

                {/* Radix wraps viewport children in a shrink-to-fit `display:table` div;
                    force it to a full-width block so rows can't grow past the sidebar
                    (and thus truncate + pin their action cluster to the visible edge). */}
                <ScrollArea className="min-h-0 flex-1 overflow-hidden [&>[data-slot=scroll-area-viewport]>div]:!block">
                  <div className="p-1.5">
                    {filteredChecks.length === 0 ? (
                      <div className="py-8 text-center">
                        <ShieldCheck size={20} className="mx-auto text-muted-foreground/50" />
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {search.query || filtered ? t('common.no_results') : t('data_quality.no_checks')}
                        </p>
                      </div>
                    ) : groups.map((group) => {
                      const open = isGroupOpen(group.key)
                      const disabledCount = group.checks.filter((c) => c.disabled).length
                      return (
                        <div key={group.key || '__other__'} className="mb-0.5">
                          {groups.length > 1 && (
                            <button
                              type="button"
                              onClick={() => toggleGroup(group.key)}
                              className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[10px] font-semibold text-muted-foreground hover:bg-accent/50"
                            >
                              {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                              <span className={cn('min-w-0 flex-1 truncate', group.key && 'font-mono')}>{group.label}</span>
                              <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">
                                {disabledCount ? `${group.checks.length - disabledCount}/${group.checks.length}` : group.checks.length}
                              </span>
                            </button>
                          )}
                          {open && (
                            <div className={cn('space-y-0.5', groups.length > 1 && 'pl-3')}>
                              {group.checks.map((check) => (
                                <DqCheckRow
                                  key={check.id}
                                  id={check.id}
                                  name={check.name}
                                  category={check.category}
                                  dirty={isCheckDirty(check.id)}
                                  disabled={check.disabled}
                                  selected={selectedCheckId === check.id && !editMode}
                                  editMode={editMode}
                                  checked={selectedIds.has(check.id)}
                                  canWrite={canWrite}
                                  renaming={renamingId === check.id}
                                  onSelect={() => (editMode ? toggleSelected(check.id) : selectCheck(check.id))}
                                  onToggleSelected={() => toggleSelected(check.id)}
                                  onStartRename={() => setRenamingId(check.id)}
                                  onRename={commitRename}
                                  onCancelRename={() => setRenamingId(null)}
                                  onToggleDisabled={() => void setChecksDisabled([check.id], !check.disabled)}
                                  onDelete={() => setDeleteTarget(check.id)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            </Allotment.Pane>

            {/* Editor area */}
            <Allotment.Pane minSize={400}>
              {selectedCheck ? (
                <div className="flex h-full flex-col">
                  {/* Check metadata */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-[10px] text-muted-foreground">{t('data_quality.col_category')}</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info size={12} className="-ml-1 shrink-0 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm space-y-1.5 py-2">
                          {DQ_CATEGORIES.map((c) => (
                            <p key={c}>
                              <span className="font-semibold">{t(`data_quality.category_${c}`)}</span>
                              {' — '}
                              {t(`data_quality.category_${c}_help`)}
                            </p>
                          ))}
                          <p className="opacity-70">{t('data_quality.category_source')}</p>
                        </TooltipContent>
                      </Tooltip>
                      <Select
                        value={selectedCheck.category}
                        onValueChange={(v) => handleCategoryChange(selectedCheck, v as DqCategory)}
                        disabled={!canWrite}
                      >
                        <SelectTrigger size="xs" className="w-32 px-2 text-xs data-[size=xs]:h-6">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" side="bottom">
                          {DQ_CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>{t(`data_quality.category_${c}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-[10px] text-muted-foreground">{t('data_quality.col_subcategory')}</Label>
                      <Select
                        value={selectedCheck.subcategory ?? NO_SUBCATEGORY}
                        onValueChange={(v) => updateCustomCheck(selectedCheck.id, { subcategory: v === NO_SUBCATEGORY ? null : v as DqSubcategory })}
                        disabled={!canWrite || DQ_SUBCATEGORIES[selectedCheck.category].length === 0}
                      >
                        <SelectTrigger size="xs" className="w-32 px-2 text-xs data-[size=xs]:h-6">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" side="bottom">
                          {DQ_SUBCATEGORIES[selectedCheck.category].length === 0 && (
                            <SelectItem value={NO_SUBCATEGORY}>—</SelectItem>
                          )}
                          {DQ_SUBCATEGORIES[selectedCheck.category].map((sc) => (
                            <SelectItem key={sc} value={sc}>{t(`data_quality.subcategory_${sc}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-[10px] text-muted-foreground">{t('data_quality.col_severity')}</Label>
                      <Select
                        value={selectedCheck.severity}
                        onValueChange={(v) => updateCustomCheck(selectedCheck.id, { severity: v as DqSeverity })}
                        disabled={!canWrite}
                      >
                        <SelectTrigger size="xs" className="w-28 px-2 text-xs data-[size=xs]:h-6">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" side="bottom">
                          {DQ_SEVERITIES.map((sv) => (
                            <SelectItem key={sv} value={sv}>{t(`data_quality.severity_${sv}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <ThresholdField
                      key={selectedCheck.id}
                      value={selectedCheck.threshold}
                      disabled={!canWrite}
                      onCommit={(threshold) => updateCustomCheck(selectedCheck.id, { threshold })}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="ml-auto shrink-0">
                          {t(`data_quality.origin_${selectedCheck.origin}`)}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        {selectedCheck.templateKey
                          ? <span className="font-mono">{selectedCheck.templateKey}</span>
                          : t('data_quality.origin_manual_hint')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="border-b px-3 py-1">
                    <Input
                      key={selectedCheck.id}
                      defaultValue={selectedCheck.description}
                      placeholder={t('data_quality.check_description_placeholder')}
                      disabled={!canWrite}
                      onBlur={(e) => {
                        const description = e.target.value.trim()
                        if (description !== selectedCheck.description) void updateCustomCheck(selectedCheck.id, { description })
                      }}
                      className="h-6 border-0 px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0"
                    />
                  </div>

                  {/* The two queries of a check, one editor; Save and Cancel cover both. */}
                  <div className="flex items-center gap-1 border-b px-3 py-1">
                    {(['sql', 'exploreSql'] as const).map((field) => (
                      <Button
                        key={field}
                        variant={queryField === field ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setQueryField(field)}
                        className="h-6 px-2 text-xs"
                      >
                        {t(field === 'sql' ? 'data_quality.query_count' : 'data_quality.query_explore')}
                      </Button>
                    ))}
                    {isCheckDirty(selectedCheck.id) && (
                      <span className="ml-1 size-2 shrink-0 rounded-full bg-orange-400" title={t('data_quality.unsaved')} />
                    )}
                    <div className="flex-1" />
                    {canWrite && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => revertCheck(selectedCheck.id)}
                          disabled={!isCheckDirty(selectedCheck.id)}
                          className="h-6 gap-1 text-xs"
                        >
                          <Undo2 size={12} />
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleSave()}
                          disabled={!isCheckDirty(selectedCheck.id)}
                          className="h-6 gap-1 text-xs"
                        >
                          <Save size={12} />
                          {t('common.save')}
                        </Button>
                      </>
                    )}
                  </div>
                  {queryField === 'exploreSql' && (
                    <p className="border-b bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground">
                      {t('data_quality.query_explore_help')}
                    </p>
                  )}
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      key={`${selectedCheck.id}:${queryField}`}
                      value={(queryField === 'sql' ? selectedCheck.sql : selectedCheck.exploreSql) ?? ''}
                      onChange={(value) => updateCheckQuery(selectedCheck.id, queryField, value ?? '')}
                      language="sql"
                      readOnly={!canWrite}
                      onSave={() => void handleSave()}
                      onRunSelectionOrLine={() => (queryField === 'sql' ? void handleTest() : investigate())}
                      onRunFile={() => (queryField === 'sql' ? void handleTest() : investigate())}
                    />
                  </div>

                  {/* Output pane */}
                  {testResult && (
                    <div className={cn(
                      'flex items-start gap-2 border-t px-3 py-2 text-xs',
                      testResult.success
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-red-500/30 bg-red-500/5',
                    )}>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {testResult.lines.map((line, i) => (
                          <p key={i} className={cn(i === 0 ? 'font-medium' : 'text-muted-foreground', 'whitespace-pre-wrap')}>{line}</p>
                        ))}
                      </div>
                      <Button variant="ghost" size="icon-xs" onClick={() => setTestResult(null)}>
                        <X size={12} />
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <ShieldCheck size={32} className="mx-auto text-muted-foreground/50" />
                    <p className="mt-3 text-sm font-medium">
                      {customChecks.length ? t('data_quality.select_check') : t('data_quality.no_checks')}
                    </p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                      {customChecks.length ? t('data_quality.select_check_description') : t('data_quality.no_checks_description')}
                    </p>
                    <Button variant="outline" size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={handleNewCheck}>
                      <Plus size={14} />
                      {t('data_quality.new_check')}
                    </Button>
                  </div>
                </div>
              )}
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>

      <AddSchemaChecksDialog
        open={addFromSchema !== null}
        origin={addFromSchema ?? 'ddl'}
        ruleSetId={ruleSetId}
        onOpenChange={(open) => { if (!open) setAddFromSchema(null) }}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_quality.delete_check_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget === 'bulk'
                ? t('data_quality.delete_checks_confirm', { count: selectedIds.size })
                : t('data_quality.delete_check_confirm', {
                    name: customChecks.find((c) => c.id === deleteTarget)?.name ?? '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} className="bg-destructive text-white hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

/**
 * The threshold, 0–100 %. Typed as free text so the field can be emptied while
 * editing; only a valid value is saved, and an invalid one says why beside the
 * field instead of snapping back. Keyed by check, so switching checks resets it.
 */
function ThresholdField({ value, disabled, onCommit }: {
  value: number
  disabled: boolean
  onCommit: (threshold: number) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(String(value))
  const trimmed = draft.trim().replace(',', '.')
  const parsed = Number(trimmed)
  const error = trimmed === ''
    ? t('data_quality.threshold_required')
    : !Number.isFinite(parsed)
      ? t('data_quality.threshold_invalid')
      : parsed < 0 || parsed > 100
        ? t('data_quality.threshold_range')
        : null

  return (
    <div className="flex items-center gap-1.5">
      <Label className="text-[10px] text-muted-foreground">{t('data_quality.custom_threshold')}</Label>
      <Input
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        aria-invalid={!!error}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const n = Number(next.trim().replace(',', '.'))
          if (next.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 && n !== value) onCommit(n)
        }}
        className="h-6 w-14 px-2 text-xs tabular-nums"
      />
      {error && (
        <span className="flex items-center gap-1 text-[10px] text-destructive">
          <AlertTriangle size={11} className="shrink-0" />
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * One check in the sidebar. Rename, enable/disable and delete live on the
 * right-click menu rather than hover icons, matching the IDE and plugin file
 * sidebars — hover clusters competed with the name for the row's width.
 */
function DqCheckRow({
  id,
  name,
  category,
  dirty,
  disabled,
  selected,
  editMode,
  checked,
  canWrite,
  renaming,
  onSelect,
  onToggleSelected,
  onStartRename,
  onRename,
  onCancelRename,
  onToggleDisabled,
  onDelete,
}: {
  id: string
  name: string
  category: DqCategory
  dirty: boolean
  disabled: boolean
  selected: boolean
  editMode: boolean
  checked: boolean
  canWrite: boolean
  renaming: boolean
  onSelect: () => void
  onToggleSelected: () => void
  onStartRename: () => void
  onRename: (next: string) => void
  onCancelRename: () => void
  onToggleDisabled: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const { ref: nameRef, overflows, triggerProps } = useOverflowTooltip()

  const dot = (
    <span className={cn(
      'inline-block h-2 w-2 shrink-0 rounded-full',
      CATEGORY_COLORS[category]?.split(' ')[0] ?? 'bg-gray-400',
    )} />
  )

  // A fixed height, not vertical padding: the rename field then fits inside the
  // row (h-5, `-ml-0.5` absorbing its border) and neither the row nor the text moves.
  const rowClass = cn(
    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors',
    selected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50',
    disabled && 'opacity-50',
  )

  if (renaming) {
    return (
      <div className={rowClass}>
        {editMode && <Checkbox checked={checked} disabled className="size-3.5 shrink-0" />}
        {dot}
        <InlineRenameField
          initialValue={name}
          onSubmit={onRename}
          onCancel={onCancelRename}
          className="-ml-0.5 h-5"
        />
      </div>
    )
  }

  return (
    <Tooltip>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={cn(rowClass, 'group')} data-check-id={id}>
            {editMode && (
              <Checkbox
                checked={checked}
                onCheckedChange={onToggleSelected}
                className="size-3.5 shrink-0"
                aria-label={t('common.select')}
              />
            )}
            {dot}
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onSelect}
                {...triggerProps}
                className={cn('min-w-0 flex-1 truncate text-left', disabled && 'line-through')}
              >
                <span ref={nameRef} className="block truncate">{name}</span>
              </button>
            </TooltipTrigger>
            {dirty && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-orange-400"
                title={t('data_quality.unsaved')}
              />
            )}
          </div>
        </ContextMenuTrigger>
        {canWrite && !editMode && (
          <ContextMenuContent>
            <ContextMenuItem onClick={onStartRename}>
              <Pencil size={14} />
              {t('common.rename')}
            </ContextMenuItem>
            <ContextMenuItem onClick={onToggleDisabled}>
              {disabled ? <Eye size={14} /> : <EyeOff size={14} />}
              {disabled ? t('data_quality.enable_check') : t('data_quality.disable_check')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 size={14} />
              {t('common.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      {overflows && <TooltipContent side="right">{name}</TooltipContent>}
    </Tooltip>
  )
}
