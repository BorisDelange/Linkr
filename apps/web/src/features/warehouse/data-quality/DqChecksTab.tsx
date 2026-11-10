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
  AlertTriangle,
  Info,
  Undo2,
  Search,
  FileCode2,
  Waypoints,
  SquarePen,
  FolderPlus,
  FolderInput,
  Languages,
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
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import { SectionLabel } from '@/components/ui/section-label'
import {
  SidebarSearchField,
  SidebarSearchToggle,
  matchesSidebarSearch,
  useSidebarSearch,
} from '@/components/SidebarSearch'
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
import { DeleteGroupDialog, GroupDialog, MoveChecksDialog } from './DqCheckGroupDialogs'
import { DqCheckTree, type DqCheckTreeDnd } from './DqCheckTree'
import { foldLevels, groupFoldKey } from './check-tree'
import { checkNames } from './check-names'
import { FoldLevelButton } from './FoldLevelButton'
import { OPEN_GROUPS_UP_TO, useFoldState } from './use-fold-state'
import {
  allGroups, canMoveGroup, groupLabel, groupPath, groupTree, moveGroup, newGroupKey, readCheckGroups,
  removeGroup, removeSubtree, renameGroup, subtreeKeys,
} from '@/lib/dq-groups'
import { localized, setLocalized } from '@/lib/localized'
import { LocalizedFields, trimLocalized } from '@/components/ui/localized-fields'
import type { DqCheckGroup, DqCustomCheck, LocalizedString } from '@/types'

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

type Tree = ReturnType<typeof groupTree<DqCustomCheck>>

const nullIfEmpty = (groups: DqCheckGroup[]) => (groups.length ? groups : null)

/** `moveGroup` only when the parent changes: moving puts a category last among its siblings. */
function moveGroupIfChanged(groups: DqCheckGroup[], key: string, parentKey: string | null): DqCheckGroup[] {
  const current = groups.find((g) => g.key === key)?.parentKey ?? null
  return current === parentKey ? groups : moveGroup(groups, key, parentKey)
}

/** The tree with each level sorted by name, when the list is not in its own order. */
function sortTree(nodes: Tree['roots'], sort: GroupSort, lang: string): Tree['roots'] {
  const sorted = nodes.map((n) => ({ ...n, children: sortTree(n.children, sort, lang) }))
  if (sort === 'list') return sorted
  sorted.sort((a, b) => groupLabel(a, lang).localeCompare(groupLabel(b, lang), undefined, { numeric: true, sensitivity: 'base' }))
  return sort === 'desc' ? sorted.reverse() : sorted
}

export function DqChecksTab({ ruleSetId, dataSourceId, onInvestigate }: Props) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
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
  const storedGroupsRaw = useDqStore((s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId)?.checkGroups)
  const storedGroups = useMemo(() => readCheckGroups(storedGroupsRaw), [storedGroupsRaw])
  // The declared categories and the ones only checks name (a generated check's table).
  const everyGroup = useMemo(() => allGroups(storedGroups, customChecks), [storedGroups, customChecks])
  // Why the last change to the list (a category renamed, checks moved, deleted,
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
  const saveGroups = (next: DqCheckGroup[]) =>
    runOp(() => updateRuleSet(ruleSetId, { checkGroups: next.length ? next : null }))
  // The category dialog: a new one (under `parent`) or one being edited.
  const [groupDialog, setGroupDialog] = useState<{ editing?: DqCheckGroup; parent?: string | null } | null>(null)
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
  const groupName = useCallback((key: string) => {
    const group = everyGroup.find((g) => g.key === key)
    return group ? groupLabel(group, lang) : key
  }, [everyGroup, lang])

  const filteredChecks = useMemo(() => customChecks.filter((c) =>
    (originFilter === 'all' || c.origin === originFilter)
    && (categoryFilter === 'all' || c.category === categoryFilter)
    && (matchesSidebarSearch(localized(c.name, lang), search.query)
      || groupPath(everyGroup, c.groupKey).some((step) => matchesSidebarSearch(groupLabel(step, lang), search.query))),
  ), [customChecks, originFilter, categoryFilter, search.query, everyGroup, lang])

  const filtered = originFilter !== 'all' || categoryFilter !== 'all'
  const tree = useMemo(() => {
    const { roots, ungrouped } = groupTree(storedGroups, filteredChecks, { keepEmpty: !filtered && !search.query })
    return { roots: sortTree(roots, groupSort, lang), ungrouped }
  }, [storedGroups, filteredChecks, filtered, search.query, groupSort, lang])

  /** The checks filed under `key` or one of its sub-categories; `''` is "Other checks". */
  const idsUnder = (key: string) => {
    if (!key) return customChecks.filter((c) => !c.groupKey || !everyGroup.some((g) => g.key === c.groupKey)).map((c) => c.id)
    const keys = subtreeKeys(everyGroup, key)
    return customChecks.filter((c) => c.groupKey && keys.has(c.groupKey)).map((c) => c.id)
  }

  const createGroup = (name: LocalizedString, parentKey: string | null) => {
    const key = newGroupKey(name, everyGroup.map((g) => g.key))
    return saveGroups([...storedGroups, { key, name, parentKey }]).then((ok) => (ok ? key : null))
  }

  const editGroup = (key: string, name: LocalizedString, parentKey: string | null) =>
    saveGroups(moveGroupIfChanged(renameGroup(storedGroups, key, name), key, parentKey))

  const renameGroupInline = async (key: string, text: string) => {
    const current = everyGroup.find((g) => g.key === key)
    if (!current || text === groupLabel(current, lang)) {
      setRenamingGroup(null)
      return
    }
    // The field stays open on failure, with the name typed.
    if (await saveGroups(renameGroup(storedGroups, key, setLocalized(current.name, lang, text)))) setRenamingGroup(null)
  }

  const deleteGroup = async (key: string, withChecks: boolean): Promise<boolean> => {
    const ids = idsUnder(key)
    if (!key) {
      if (!(await runOp(() => deleteCustomChecks(ids)))) return false
      setDeletingGroup(null)
      return true
    }
    // Kept checks of the category itself go up to its parent; those of its
    // sub-categories stay in them, which move up too.
    const parentKey = everyGroup.find((g) => g.key === key)?.parentKey ?? null
    const own = customChecks.filter((c) => c.groupKey === key).map((c) => c.id)
    const ok = await runOp(async () => {
      if (withChecks) await deleteCustomChecks(ids)
      else await updateChecks(own, { groupKey: parentKey })
      await updateRuleSet(ruleSetId, { checkGroups: nullIfEmpty(withChecks ? removeSubtree(storedGroups, key) : removeGroup(storedGroups, key)) })
    })
    if (ok) setDeletingGroup(null)
    return ok
  }

  const moveChecks = async (ids: string[], key: string | null): Promise<boolean> => {
    if (!(await runOp(() => updateChecks(ids, { groupKey: key })))) return false
    setMoving(null)
    return true
  }

  const dnd: DqCheckTreeDnd | undefined = canWrite ? {
    onDropChecks: (ids, key) => {
      const moved = ids.filter((id) => customChecks.find((c) => c.id === id)?.groupKey !== key)
      if (moved.length) void moveChecks(moved, key)
    },
    onDropGroup: (key, parentKey) => {
      if ((everyGroup.find((g) => g.key === key)?.parentKey ?? null) === parentKey) return
      void saveGroups(moveGroup(storedGroups, key, parentKey))
    },
    canMoveGroup: (key, parentKey) => canMoveGroup(everyGroup, key, parentKey),
  } : undefined

  const movingFrom = moving && new Set(customChecks.filter((c) => moving.includes(c.id)).map((c) => c.groupKey)).size === 1
    ? customChecks.find((c) => c.id === moving[0])?.groupKey ?? null
    : undefined

  const isGroupOpen = (foldKey: string) => !!search.query || fold.isOpen(foldKey)

  const handleNewCheck = useCallback(async (groupKey: string | null = null) => {
    const check = makeCheck(ruleSetId, customChecks.reduce((max, c) => Math.max(max, c.order + 1), 0), {
      name: checkNames()('data_quality.new_check_name', { n: customChecks.filter((c) => c.origin === 'manual').length + 1 }),
      description: {},
      category: 'plausibility',
      subcategory: 'atemporal',
      severity: 'warning',
      threshold: 0,
      sql: t('data_quality.new_check_sql'),
      exploreSql: t('data_quality.new_check_explore_sql'),
      origin: 'manual',
      templateKey: null,
      groupKey,
    })
    await createCustomCheck(check)
    selectCheck(check.id)
    if (groupKey) fold.setOpen([...groupPath(everyGroup, groupKey).map((step) => groupFoldKey('', step.key))], true)
    setOriginFilter((f) => (f === 'all' || f === 'manual' ? f : 'all'))
    setCategoryFilter((f) => (f === 'all' || f === check.category ? f : 'all'))
  }, [ruleSetId, customChecks, createCustomCheck, selectCheck, t, fold, everyGroup])

  const commitRename = useCallback((name: string) => {
    const check = customChecks.find((c) => c.id === renamingId)
    if (!check || !name) return
    void updateCustomCheck(check.id, { name: setLocalized(check.name, lang, name) })
    setRenamingId(null)
  }, [renamingId, customChecks, updateCustomCheck, lang])

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


  const foldLevelsWithOther = useMemo(() => {
    const levels = foldLevels(tree.roots, '')
    const other = { key: groupFoldKey('', '') }
    return tree.ungrouped.length ? [[...(levels[0] ?? []), other], ...levels.slice(1)] : levels
  }, [tree])

  const groupMenu = (key: string | null) => {
    if (key === null) {
      return tree.ungrouped.length ? (
        <ContextMenuItem variant="destructive" onClick={() => setDeletingGroup('')}>
          <Trash2 size={14} />
          {t('data_quality.delete_group')}
        </ContextMenuItem>
      ) : null
    }
    const group = everyGroup.find((g) => g.key === key)
    return (
      <>
        <ContextMenuItem onClick={() => void handleNewCheck(key)}>
          <SquarePen size={14} />
          {t('data_quality.new_check_here')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setGroupDialog({ parent: key })}>
          <FolderPlus size={14} />
          {t('data_quality.new_subgroup')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setRenamingGroup(key)}>
          <Pencil size={14} />
          {t('common.rename')}
        </ContextMenuItem>
        {group && (
          <ContextMenuItem onClick={() => setGroupDialog({ editing: group })}>
            <Languages size={14} />
            {t('data_quality.edit_group')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => setDeletingGroup(key)}>
          <Trash2 size={14} />
          {t('data_quality.delete_group')}
        </ContextMenuItem>
      </>
    )
  }

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
                      levels={foldLevelsWithOther}
                      isOpen={fold.isOpen}
                      onFold={fold.setOpen}
                      disabled={!!search.query}
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
                        <DropdownMenuItem onClick={() => setGroupDialog({})}>
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

                <ScrollArea className="min-h-0 flex-1 overflow-hidden">
                  <div className="p-1.5">
                    {filteredChecks.length === 0 && tree.roots.length === 0 ? (
                      <div className="py-8 text-center">
                        <ShieldCheck size={20} className="mx-auto text-muted-foreground/50" />
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {search.query || filtered ? t('common.no_results') : t('data_quality.no_checks')}
                        </p>
                      </div>
                    ) : (
                      <DqCheckTree
                        roots={tree.roots}
                        ungrouped={tree.ungrouped}
                        isOpen={isGroupOpen}
                        onToggle={fold.toggle}
                        isDisabled={(c) => c.disabled}
                        renaming={renamingGroup}
                        onRename={(key, name) => void renameGroupInline(key, name)}
                        onCancelRename={() => setRenamingGroup(null)}
                        dnd={dnd}
                        groupMenu={canWrite ? groupMenu : undefined}
                        renderCheck={(check) => (
                          <DqCheckRow
                            key={check.id}
                            id={check.id}
                            name={localized(check.name, lang)}
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
                            dragIds={dnd ? () => (selectedIds.has(check.id) ? [...selectedIds] : [check.id]) : undefined}
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
                        )}
                      />
                    )}
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
                  <CheckTextFields key={selectedCheck.id} check={selectedCheck} disabled={!canWrite} onCommit={(changes) => void updateCustomCheck(selectedCheck.id, changes)} />

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
                    <Button variant="outline" size="sm" className="mt-4 gap-1.5" disabled={!canWrite} onClick={() => void handleNewCheck()}>
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

      <GroupDialog
        open={groupDialog !== null}
        onOpenChange={(open) => { if (!open) setGroupDialog(null) }}
        groups={everyGroup}
        editing={groupDialog?.editing}
        defaultParent={groupDialog?.parent ?? null}
        onSave={async (name, parentKey) => {
          const editing = groupDialog?.editing
          if (editing) return editGroup(editing.key, name, parentKey)
          const key = await createGroup(name, parentKey)
          if (!key) return false
          setOriginFilter('all')
          setCategoryFilter('all')
          if (parentKey) fold.setOpen(groupPath(everyGroup, parentKey).map((step) => groupFoldKey('', step.key)), true)
          return true
        }}
      />
      <MoveChecksDialog
        open={moving !== null}
        onOpenChange={(open) => { if (!open) { setMoving(null); setOpError(null) } }}
        count={moving?.length ?? 0}
        groups={everyGroup}
        current={movingFrom}
        error={opError}
        onMove={async (target) => {
          if (!moving) return true
          const key = 'name' in target ? await createGroup(target.name, null) : target.key
          if ('name' in target && !key) return false
          return moveChecks(moving, key)
        }}
      />
      <DeleteGroupDialog
        group={deletingGroup === null ? null : deletingGroup ? groupName(deletingGroup) : t('data_quality.group_other')}
        count={deletingGroup === null ? 0 : idsUnder(deletingGroup).length}
        hasChildren={!!deletingGroup && everyGroup.some((g) => g.parentKey === deletingGroup)}
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
                    name: localized(customChecks.find((c) => c.id === deleteTarget)?.name, lang),
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
 * A check's name and description, in English and French side by side. Saved
 * when a field is left; a name emptied in every language is not saved.
 */
function CheckTextFields({ check, disabled, onCommit }: {
  check: DqCustomCheck
  disabled: boolean
  onCommit: (changes: Partial<Pick<DqCustomCheck, 'name' | 'description'>>) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState<LocalizedString>(check.name)
  const [description, setDescription] = useState<LocalizedString>(check.description)
  // A rename from the sidebar lands here too; resetting during render, not on
  // a remount, keeps the focus of the field being typed in.
  const [saved, setSaved] = useState({ name: check.name, description: check.description })
  if (saved.name !== check.name || saved.description !== check.description) {
    setSaved({ name: check.name, description: check.description })
    setName(check.name)
    setDescription(check.description)
  }
  const same = (a: LocalizedString, b: LocalizedString) => JSON.stringify(trimLocalized(a)) === JSON.stringify(trimLocalized(b))
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
      <Label className="text-[10px] text-muted-foreground">{t('data_quality.check_name')}</Label>
      <LocalizedFields
        layout="row"
        size="xs"
        value={name}
        disabled={disabled}
        onChange={setName}
        onCommit={(next) => {
          const trimmed = trimLocalized(next)
          if (!Object.keys(trimmed).length) setName(check.name)
          else if (!same(trimmed, check.name)) onCommit({ name: trimmed })
        }}
      />
      <Label className="text-[10px] text-muted-foreground">{t('data_quality.check_description')}</Label>
      <LocalizedFields
        layout="row"
        size="xs"
        value={description}
        disabled={disabled}
        placeholder={t('data_quality.check_description_placeholder')}
        onChange={setDescription}
        onCommit={(next) => {
          if (!same(next, check.description)) onCommit({ description: trimLocalized(next) })
        }}
      />
    </div>
  )
}
