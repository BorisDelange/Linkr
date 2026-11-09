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
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Info,
  Undo2,
  Search,
  FileCode2,
  Waypoints,
  SquarePen,
  FolderPlus,
  FolderInput,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatabaseSelect } from '@/components/ui/database-select'
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
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { usableExploreSql } from '@/lib/duckdb/data-quality'
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
import { buildPointer } from '@/lib/import-identity'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { useDatabaseOptions } from '@/hooks/use-database-options'
import { AddSchemaChecksDialog } from './AddSchemaChecksDialog'
import { DqCheckRow } from './DqCheckRow'
import { DqTestResult } from './DqTestResult'
import { useCheckTest } from './use-check-test'
import { DeleteGroupDialog, MoveChecksDialog, NewGroupDialog } from './DqCheckGroupDialogs'
import { FoldLevelButton } from './FoldLevelButton'
import { OPEN_GROUPS_UP_TO, useFoldState } from './use-fold-state'
import type { DqCustomCheck } from '@/types'

interface Props {
  ruleSetId: string
  dataSourceId: string
  /** Opens the rule set's investigation console with this query. */
  onInvestigate: (sql: string) => void
}

type OriginFilter = 'all' | DqCheckOrigin
type CategoryFilter = 'all' | DqCategory
type GroupSort = 'list' | 'asc' | 'desc'

const GROUP_SORTS: GroupSort[] = ['list', 'asc', 'desc']
const GROUP_SORT_KEY = 'dq:group-sort'

function readGroupSort(): GroupSort {
  try {
    const stored = localStorage.getItem(GROUP_SORT_KEY)
    return GROUP_SORTS.find((s) => s === stored) ?? 'list'
  } catch {
    return 'list'
  }
}

const ORIGINS: DqCheckOrigin[] = ['ddl', 'mapping', 'manual']
const NO_SUBCATEGORY = '__none__'

interface CheckGroup {
  key: string
  label: string
  checks: DqCustomCheck[]
}

export function DqChecksTab({ ruleSetId, dataSourceId, onInvestigate }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const {
    customChecks,
    selectedCheckId,
    selectCheck,
    createCustomCheck,
    deleteCustomCheck,
    deleteCustomChecks,
    updateCustomCheck,
    updateCheckQuery,
    isCheckDirty,
    saveCheck,
    revertCheck,
    setChecksDisabled,
    updateChecks,
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

  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [groupSort, setGroupSortState] = useState<GroupSort>(readGroupSort)
  const setGroupSort = (sort: GroupSort) => {
    setGroupSortState(sort)
    try { localStorage.setItem(GROUP_SORT_KEY, sort) } catch { /* private window: the choice just doesn't stick */ }
  }
  const search = useSidebarSearch()
  const { testing, result: testResult, run: runTest, clear: clearTestResult } = useCheckTest(dataSourceId)
  const [queryField, setQueryField] = useState<CheckQueryField>('sql')
  // Set when a run is asked for with no database picked; cleared by picking one.
  const [databaseMissing, setDatabaseMissing] = useState(false)
  const [addFromSchema, setAddFromSchema] = useState<'ddl' | 'mapping' | null>(null)
  // A group is the `tableName` its checks share; one with no check yet is kept
  // on the rule set (`checkGroups`) until a check is moved into it.
  const storedEmptyGroups = useDqStore((s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId)?.checkGroups)
  const emptyGroups = useMemo(() => storedEmptyGroups ?? [], [storedEmptyGroups])
  // Why the last change to the list (a group renamed, checks moved, deleted,
  // enabled) failed; every such change is all-or-nothing, so the list is as it was.
  const [opError, setOpError] = useState<string | null>(null)
  const runOp = useCallback(async (op: () => Promise<unknown>): Promise<boolean> => {
    setOpError(null)
    try {
      await op()
      return true
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [])
  const setEmptyGroups = (update: (prev: string[]) => string[]) => {
    const next = update(emptyGroups)
    if (next.length === emptyGroups.length && next.every((g, i) => g === emptyGroups[i])) return
    void runOp(() => updateRuleSet(ruleSetId, { checkGroups: next.length ? next : null }))
  }
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  const [moving, setMoving] = useState<string[] | null>(null)
  const fold = useFoldState(() => customChecks.length <= OPEN_GROUPS_UP_TO)

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
    if (!search.query && originFilter === 'all' && categoryFilter === 'all') {
      for (const name of emptyGroups) {
        if (!byKey.has(name)) byKey.set(name, { key: name, label: name, checks: [] })
      }
    }
    const other = byKey.get('')
    byKey.delete('')
    const named = [...byKey.values()]
    if (groupSort !== 'list') {
      named.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
      if (groupSort === 'desc') named.reverse()
    }
    return other ? [...named, other] : named
  }, [filteredChecks, emptyGroups, search.query, originFilter, categoryFilter, groupSort, t])

  const groupNames = useMemo(() => {
    const names = new Set(customChecks.map((c) => c.tableName).filter((n): n is string => !!n))
    for (const name of emptyGroups) names.add(name)
    return [...names]
  }, [customChecks, emptyGroups])
  // Always shown, "Other checks" included: a header is where a group is renamed or deleted.
  const showGroupHeaders = groups.length > 0
  /** `''` is "Other checks", the checks with no group. */
  const idsInGroup = (name: string) => customChecks.filter((c) => (c.tableName ?? '') === name).map((c) => c.id)

  const renameGroup = async (from: string, to: string) => {
    if (to === from) {
      setRenamingGroup(null)
      return
    }
    // The field stays open on failure, with the name typed.
    if (!(await runOp(() => updateChecks(idsInGroup(from), { tableName: to })))) return
    setRenamingGroup(null)
    setEmptyGroups((prev) => prev.map((g) => (g === from ? to : g)))
    fold.rename(from, to)
  }

  const deleteGroup = async (name: string, withChecks: boolean): Promise<boolean> => {
    const ids = idsInGroup(name)
    const ok = await runOp(() => (withChecks ? deleteCustomChecks(ids) : updateChecks(ids, { tableName: null })))
    if (!ok) return false
    setEmptyGroups((prev) => prev.filter((g) => g !== name))
    setDeletingGroup(null)
    return true
  }

  const moveChecks = async (ids: string[], group: string | null): Promise<boolean> => {
    if (!(await runOp(() => updateChecks(ids, { tableName: group })))) return false
    setEmptyGroups((prev) => prev.filter((g) => g !== group))
    setMoving(null)
    return true
  }
  const movingFrom = moving && new Set(customChecks.filter((c) => moving.includes(c.id)).map((c) => c.tableName)).size === 1
    ? customChecks.find((c) => c.id === moving[0])?.tableName ?? null
    : undefined

  const isGroupOpen = (key: string) => !!search.query || !showGroupHeaders || fold.isOpen(key)

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
    const ok = await runOp(() => (ids.length === 1 ? deleteCustomCheck(ids[0]) : deleteCustomChecks(ids)))
    setDeleteTarget(null)
    if (!ok) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }, [deleteTarget, selectedIds, deleteCustomCheck, deleteCustomChecks, runOp])

  const handleTest = useCallback(async () => {
    if (!dataSourceId) {
      setDatabaseMissing(true)
      return
    }
    if (selectedCheck) await runTest(selectedCheck)
  }, [selectedCheck, dataSourceId, runTest])

  const investigate = () => {
    if (!dataSourceId) {
      setDatabaseMissing(true)
      return
    }
    if (selectedCheck) onInvestigate(usableExploreSql(selectedCheck) ?? selectedCheck.sql)
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
            <DatabaseSelect
              workspaceId={ruleSetWorkspaceId}
              value={dataSourceId}
              onChange={(value) => {
                setDatabaseMissing(false)
                void updateRuleSet(ruleSetId, {
                  dataSourceId: value,
                  dataSourceRef: value ? buildPointer(dbSources, value) : undefined,
                })
              }}
              disabled={!canWrite}
              size="xs"
              icon
              placeholder={t('data_quality.select_database')}
              noneLabel={t('data_quality.rs_database_none')}
              className="w-auto border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50"
            />
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
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button variant={filtered ? 'secondary' : 'ghost'} size="icon-xs">
                              <Filter size={12} />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t('data_quality.filters')}</TooltipContent>
                      </Tooltip>
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
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('data_quality.sort_groups')}</DropdownMenuLabel>
                        {GROUP_SORTS.map((sort) => (
                          <DropdownMenuCheckboxItem key={sort} checked={groupSort === sort} onCheckedChange={() => setGroupSort(sort)}>
                            {t(`data_quality.sort_groups_${sort}`)}
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
                    <FoldLevelButton
                      levels={[groups.map((g) => ({ key: g.key }))]}
                      isOpen={fold.isOpen}
                      onFold={fold.setOpen}
                      disabled={!showGroupHeaders || !!search.query}
                    />
                    <SidebarSearchToggle
                      open={search.open}
                      onToggle={search.toggle}
                      label={t('data_quality.search_checks')}
                    />
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" disabled={!canWrite}>
                              <Plus size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t('data_quality.add_menu')}</TooltipContent>
                      </Tooltip>
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setNewGroupOpen(true)}>
                          <FolderPlus />
                          {t('data_quality.new_group')}
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

                {opError && moving === null && deletingGroup === null && (
                  <div className="flex items-center gap-2 border-b bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                    <AlertTriangle size={12} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={opError}>{t('data_quality.checks_change_failed', { message: opError })}</span>
                    <Button variant="ghost" size="icon-xs" className="h-5 w-5 text-destructive" onClick={() => setOpError(null)} title={t('common.close')}>
                      <X size={12} />
                    </Button>
                  </div>
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
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => void runOp(() => setChecksDisabled([...selectedIds], false))}>
                          <Eye size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.enable_check')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => void runOp(() => setChecksDisabled([...selectedIds], true))}>
                          <EyeOff size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.disable_check')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => setMoving([...selectedIds])}>
                          <FolderInput size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.move_to')}</TooltipContent>
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
                <ScrollArea className="min-h-0 flex-1 overflow-hidden">
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
                          {showGroupHeaders && (renamingGroup === group.key ? (
                            <div className="flex h-6 w-full items-center gap-1 rounded px-1 text-[10px] font-semibold text-muted-foreground">
                              <ChevronDown size={12} className="shrink-0" />
                              <InlineRenameField
                                initialValue={group.key || group.label}
                                onSubmit={(next) => void renameGroup(group.key, next)}
                                onCancel={() => setRenamingGroup(null)}
                                hasClash={(candidate) => groupNames.some((g) => g !== group.key && g.toLowerCase() === candidate.toLowerCase())}
                                className="-ml-0.5 h-5 font-mono"
                              />
                            </div>
                          ) : (
                            <ContextMenu>
                              <ContextMenuTrigger asChild disabled={!canWrite}>
                                <button
                                  type="button"
                                  onClick={() => fold.toggle(group.key)}
                                  className="flex h-6 w-full items-center gap-1 rounded px-1 text-left text-[10px] font-semibold text-muted-foreground hover:bg-accent/50"
                                >
                                  {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                                  <span className={cn('min-w-0 flex-1 truncate', group.key && 'font-mono')}>{group.label}</span>
                                  <span className="shrink-0 font-normal tabular-nums text-muted-foreground/70">
                                    {disabledCount ? `${group.checks.length - disabledCount}/${group.checks.length}` : group.checks.length}
                                  </span>
                                </button>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem onClick={() => setRenamingGroup(group.key)}>
                                  <Pencil size={14} />
                                  {t('common.rename')}
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem variant="destructive" onClick={() => setDeletingGroup(group.key)}>
                                  <Trash2 size={14} />
                                  {t('data_quality.delete_group')}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          ))}
                          {open && group.checks.length === 0 && (
                            <p className="py-1 pl-7 pr-2 text-[10px] text-muted-foreground/70">{t('data_quality.group_empty')}</p>
                          )}
                          {open && (
                            <div className={cn('space-y-0.5', showGroupHeaders && 'pl-3')}>
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
                                  renaming={renamingId === check.id}
                                  onSelect={() => (editMode ? toggleSelected(check.id) : selectCheck(check.id))}
                                  onToggleSelected={() => toggleSelected(check.id)}
                                  onRename={commitRename}
                                  onCancelRename={() => setRenamingId(null)}
                                  menu={canWrite && (
                                    <>
                                      <ContextMenuItem onClick={() => setRenamingId(check.id)}>
                                        <Pencil size={14} />
                                        {t('common.rename')}
                                      </ContextMenuItem>
                                      <ContextMenuItem onClick={() => void runOp(() => setChecksDisabled([check.id], !check.disabled))}>
                                        {check.disabled ? <Eye size={14} /> : <EyeOff size={14} />}
                                        {check.disabled ? t('data_quality.enable_check') : t('data_quality.disable_check')}
                                      </ContextMenuItem>
                                      <ContextMenuItem onClick={() => setMoving([check.id])}>
                                        <FolderInput size={14} />
                                        {t('data_quality.move_to')}
                                      </ContextMenuItem>
                                      <ContextMenuSeparator />
                                      <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget(check.id)}>
                                        <Trash2 size={14} />
                                        {t('common.delete')}
                                      </ContextMenuItem>
                                    </>
                                  )}
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
                      completion={{ kind: 'sql', dataSourceId }}
                      readOnly={!canWrite}
                      onSave={() => void handleSave()}
                      onRunSelectionOrLine={() => (queryField === 'sql' ? void handleTest() : investigate())}
                      onRunFile={() => (queryField === 'sql' ? void handleTest() : investigate())}
                    />
                  </div>

                  {/* Output pane */}
                  {testResult && <DqTestResult result={testResult} onClose={clearTestResult} />}
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

      <NewGroupDialog
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
        groups={groupNames}
        onCreate={(name) => {
          setEmptyGroups((prev) => [...prev, name])
          setOriginFilter('all')
          setCategoryFilter('all')
        }}
      />
      <MoveChecksDialog
        open={moving !== null}
        onOpenChange={(open) => { if (!open) { setMoving(null); setOpError(null) } }}
        count={moving?.length ?? 0}
        groups={groupNames}
        current={movingFrom}
        error={opError}
        onMove={(group) => (moving ? moveChecks(moving, group) : Promise.resolve(true))}
      />
      <DeleteGroupDialog
        group={deletingGroup === null ? null : deletingGroup || t('data_quality.group_other')}
        count={deletingGroup === null ? 0 : idsInGroup(deletingGroup).length}
        canKeepChecks={!!deletingGroup}
        onOpenChange={(open) => { if (!open) { setDeletingGroup(null); setOpError(null) } }}
        error={opError}
        onDelete={(withChecks) => (deletingGroup !== null ? deleteGroup(deletingGroup, withChecks) : Promise.resolve(true))}
      />

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
