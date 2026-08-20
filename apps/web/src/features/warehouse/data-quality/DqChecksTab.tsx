import { useState, useEffect, useCallback, useMemo } from 'react'
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
  Search,
  Pencil,
  Eye,
  EyeOff,
  ListChecks,
  X,
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
import { Badge } from '@/components/ui/badge'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { queryDataSource } from '@/lib/duckdb/engine'
import { generateChecks } from '@/lib/duckdb/data-quality'
import type { DqCheck, DqCategory, DqSeverity } from '@/lib/duckdb/data-quality'
import { useDqStore } from '@/stores/dq-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { CATEGORIES, SEVERITIES, CATEGORY_COLORS } from './DqConstants'
import type { DqCustomCheck } from '@/types'

interface Props {
  ruleSetId: string
  dataSourceId: string
}

type SidebarFilter = 'all' | 'builtin' | 'custom'

interface TestResult {
  success: boolean
  message: string
}

// Simple fuzzy match: every character of the query must appear in order in the target
function fuzzyMatch(target: string, query: string): boolean {
  const t = target.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti)
    if (idx === -1) return false
    ti = idx + 1
  }
  return true
}

export function DqChecksTab({ ruleSetId, dataSourceId }: Props) {
  const { t } = useTranslation()
  const canWrite = useMyWorkspaceRole().can('data-quality:write')
  const {
    customChecks,
    selectedCheckId,
    selectCheck,
    createCustomCheck,
    deleteCustomCheck,
    updateCustomCheck,
    updateCheckSql,
    isCheckDirty,
    saveCheck,
    setChecksDisabled,
    _dirtyVersion,
  } = useDqStore()
  const disabledCheckIds = useDqStore(
    (s) => s.dqRuleSets.find((rs) => rs.id === ruleSetId)?.disabledCheckIds,
  )
  const isDisabled = useCallback(
    (id: string) => !!disabledCheckIds?.includes(id),
    [disabledCheckIds],
  )
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const activeSource = dataSources.find((ds) => ds.id === dataSourceId)

  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [builtinChecks, setBuiltinChecks] = useState<DqCheck[]>([])
  const [builtinLoading, setBuiltinLoading] = useState(false)
  // Local overrides for built-in check SQL (in-memory, not persisted)
  const [builtinSqlOverrides, setBuiltinSqlOverrides] = useState<Map<string, string>>(new Map())

  // Sidebar edit mode: multi-select via checkboxes + bulk enable/disable/delete.
  const [editMode, setEditMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Inline rename of a custom check name (IDE-style).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Delete confirmation: a single custom check id, or 'bulk' for the selection.
  const [deleteTarget, setDeleteTarget] = useState<string | 'bulk' | null>(null)

  // Force re-render when dirty state changes
  void _dirtyVersion

  // Load built-in checks for this data source
  useEffect(() => {
    let cancelled = false
    // The database is optional until the user picks one — nothing to discover yet.
    if (!dataSourceId) { setBuiltinChecks([]); return }
    const loadBuiltin = async () => {
      setBuiltinLoading(true)
      try {
        // The source may have been unmounted since it was seeded — remount before
        // discovering tables/columns, or generateChecks sees an empty database.
        await ensureMounted(dataSourceId)
        const checks = await generateChecks(dataSourceId, activeSource?.schemaMapping)
        if (!cancelled) {
          setBuiltinChecks(checks)
          setBuiltinSqlOverrides(new Map())
        }
      } catch {
        // Ignore errors — built-in checks are optional display
      } finally {
        if (!cancelled) setBuiltinLoading(false)
      }
    }
    loadBuiltin()
    return () => { cancelled = true }
  }, [dataSourceId, activeSource?.schemaMapping, ensureMounted])

  // Selected item: could be a custom check or a built-in check
  const selectedCustomCheck = customChecks.find((c) => c.id === selectedCheckId)
  const selectedBuiltinCheck = !selectedCustomCheck ? builtinChecks.find((c) => c.id === selectedCheckId) : null

  // Filtered + searched sidebar items
  const filteredCustomChecks = useMemo(() => {
    if (sidebarFilter === 'builtin') return []
    if (!searchQuery) return customChecks
    return customChecks.filter((c) => fuzzyMatch(c.name, searchQuery))
  }, [sidebarFilter, searchQuery, customChecks])

  const filteredBuiltinChecks = useMemo(() => {
    if (sidebarFilter === 'custom') return []
    if (!searchQuery) return builtinChecks
    return builtinChecks.filter((c) => fuzzyMatch(c.description || c.name, searchQuery))
  }, [sidebarFilter, searchQuery, builtinChecks])

  const handleNewCheck = useCallback(async () => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const check: DqCustomCheck = {
      id,
      ruleSetId,
      name: `Check ${customChecks.length + 1}`,
      description: '',
      category: 'plausibility',
      severity: 'warning',
      threshold: 0,
      sql: '-- Write SQL that returns violated_rows and total_rows\nSELECT\n  COUNT(*) FILTER (WHERE 1=0)::BIGINT AS violated_rows,\n  COUNT(*)::BIGINT AS total_rows\nFROM "your_table"',
      order: customChecks.length,
      createdAt: now,
      updatedAt: now,
    }
    await createCustomCheck(check)
    selectCheck(id)
    setSidebarFilter((f) => f === 'builtin' ? 'all' : f)
  }, [ruleSetId, customChecks.length, createCustomCheck, selectCheck])

  // --- Inline rename (custom checks only) ---
  const startRename = useCallback((id: string, name: string) => {
    setRenamingId(id)
    setRenameValue(name)
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    const name = renameValue.trim()
    if (name) void updateCustomCheck(renamingId, { name })
    setRenamingId(null)
  }, [renamingId, renameValue, updateCustomCheck])

  // --- Enable/disable ---
  const toggleDisabled = useCallback((id: string) => {
    void setChecksDisabled(ruleSetId, [id], !isDisabled(id))
  }, [ruleSetId, isDisabled, setChecksDisabled])

  // --- Multi-select (edit mode) ---
  const allVisibleIds = useMemo(
    () => [...filteredCustomChecks.map((c) => c.id), ...filteredBuiltinChecks.map((c) => c.id)],
    [filteredCustomChecks, filteredBuiltinChecks],
  )
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
    setSelectedIds((prev) => (prev.size === allVisibleIds.length ? new Set() : new Set(allVisibleIds)))
  }, [allVisibleIds])

  const exitEditMode = useCallback(() => {
    setEditMode(false)
    setSelectedIds(new Set())
  }, [])

  const handleBulkSetDisabled = useCallback((disabled: boolean) => {
    if (selectedIds.size === 0) return
    void setChecksDisabled(ruleSetId, [...selectedIds], disabled)
  }, [selectedIds, ruleSetId, setChecksDisabled])

  // Only custom checks can be deleted; built-in ones in the selection are ignored.
  const selectedCustomIds = useMemo(
    () => [...selectedIds].filter((id) => customChecks.some((c) => c.id === id)),
    [selectedIds, customChecks],
  )

  const handleConfirmDelete = useCallback(async () => {
    const ids = deleteTarget === 'bulk' ? selectedCustomIds : deleteTarget ? [deleteTarget] : []
    for (const id of ids) await deleteCustomCheck(id)
    setDeleteTarget(null)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }, [deleteTarget, selectedCustomIds, deleteCustomCheck])

  const getEffectiveSql = useCallback((check: DqCheck): string => {
    return builtinSqlOverrides.get(check.id) ?? check.sql
  }, [builtinSqlOverrides])

  const handleTest = useCallback(async () => {
    const sql = selectedCustomCheck?.sql ?? (selectedBuiltinCheck ? getEffectiveSql(selectedBuiltinCheck) : null)
    if (!sql || testing) return
    setTesting(true)
    setTestResult(null)

    try {
      const rows = await queryDataSource(dataSourceId, sql)
      if (!rows.length) {
        setTestResult({ success: false, message: t('data_quality.test_result_no_rows') })
        return
      }
      const violated = Number(rows[0].violated_rows ?? 0)
      const total = Number(rows[0].total_rows ?? 0)
      const threshold = selectedCustomCheck?.threshold ?? selectedBuiltinCheck?.threshold ?? 0
      const pct = total > 0 ? ((violated / total) * 100).toFixed(1) : '0'
      const passed = threshold === 0 ? violated === 0 : Number(pct) <= threshold

      const stats = t('data_quality.test_result_stats', { violated, total, pct, threshold })
      if (passed) {
        setTestResult({ success: true, message: `${t('data_quality.test_result_pass')}\n${stats}` })
      } else {
        setTestResult({ success: false, message: `${t('data_quality.test_result_fail', { pct, violated, total })}\n${stats}` })
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: t('data_quality.test_result_error', { message: err instanceof Error ? err.message : String(err) }),
      })
    } finally {
      setTesting(false)
    }
  }, [selectedCustomCheck, selectedBuiltinCheck, getEffectiveSql, dataSourceId, testing, t])

  const handleSave = useCallback(async () => {
    if (selectedCheckId && selectedCustomCheck) await saveCheck(selectedCheckId)
  }, [selectedCheckId, selectedCustomCheck, saveCheck])

  // The SQL to display in the editor
  const editorSql = selectedCustomCheck?.sql
    ?? (selectedBuiltinCheck ? getEffectiveSql(selectedBuiltinCheck) : '')

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (selectedCustomCheck) {
      updateCheckSql(selectedCustomCheck.id, value ?? '')
    } else if (selectedBuiltinCheck) {
      setBuiltinSqlOverrides((prev) => {
        const next = new Map(prev)
        next.set(selectedBuiltinCheck.id, value ?? '')
        return next
      })
    }
  }, [selectedCustomCheck, selectedBuiltinCheck, updateCheckSql])

  const filterCount = filteredCustomChecks.length + filteredBuiltinChecks.length

  // One sidebar row, shared by custom and built-in checks. `name` is truncated with
  // an ellipsis and revealed in full via a tooltip, so the action cluster on the
  // right stays pinned to the visible edge of the (resizable) sidebar.
  const renderRow = (opts: {
    id: string
    category: DqCategory
    name: string
    isCustom: boolean
    dirty: boolean
  }) => {
    const { id, category, name, isCustom, dirty } = opts
    const disabled = isDisabled(id)
    const renaming = renamingId === id
    return (
      <div
        key={id}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
          selectedCheckId === id && !editMode
            ? 'bg-accent text-accent-foreground'
            : 'text-foreground hover:bg-accent/50',
          disabled && 'opacity-50',
        )}
      >
        {editMode && (
          <Checkbox
            checked={selectedIds.has(id)}
            onCheckedChange={() => toggleSelected(id)}
            className="size-3.5 shrink-0"
            aria-label={t('common.select')}
          />
        )}
        <span className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full',
          CATEGORY_COLORS[category]?.split(' ')[0] ?? 'bg-gray-400',
        )} />

        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
            }}
            // No border/vertical padding: a ring keeps the input the same height as the
            // static label so entering rename mode doesn't reflow the row or the list.
            className="-mx-0.5 min-w-0 flex-1 rounded bg-background px-0.5 text-xs leading-[inherit] text-foreground outline-none ring-1 ring-primary"
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => (editMode ? toggleSelected(id) : selectCheck(id))}
                className={cn('min-w-0 flex-1 truncate text-left', disabled && 'line-through')}
              >
                {name}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{name}</TooltipContent>
          </Tooltip>
        )}

        {dirty && <span className="size-1.5 shrink-0 rounded-full bg-orange-500" title={t('data_quality.unsaved')} />}

        {canWrite && !editMode && !renaming && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {isCustom && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); startRename(id, name) }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Pencil size={11} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('common.rename')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleDisabled(id) }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {disabled ? <EyeOff size={11} /> : <Eye size={11} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{disabled ? t('data_quality.enable_check') : t('data_quality.disable_check')}</TooltipContent>
            </Tooltip>
            {isCustom && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(id) }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 size={11} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('common.delete')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
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

          {(selectedCustomCheck || selectedBuiltinCheck) && (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={handleTest}
                disabled={testing || !canWrite}
                className="h-6 gap-1 px-2 text-xs"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testing ? t('data_quality.testing') : t('data_quality.test_check')}
              </Button>

              {selectedCheckId && selectedCustomCheck && isCheckDirty(selectedCheckId) && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={!canWrite}
                  onClick={handleSave}
                >
                  <Save size={14} />
                </Button>
              )}
            </>
          )}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            {/* Check list sidebar */}
            <Allotment.Pane preferredSize={280} minSize={180} maxSize={600} visible={sidebarVisible}>
              <div className="flex h-full min-h-0 flex-col border-r">
                <div className="flex items-center justify-between border-b px-3 py-1.5">
                  <SectionLabel>
                    {t('data_quality.checks')}
                  </SectionLabel>
                  <div className="flex items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs">
                          <Filter size={12} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuCheckboxItem
                          checked={sidebarFilter === 'all'}
                          onCheckedChange={() => setSidebarFilter('all')}
                        >
                          {t('data_quality.filter_all')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={sidebarFilter === 'custom'}
                          onCheckedChange={() => setSidebarFilter('custom')}
                        >
                          {t('data_quality.filter_custom_only')}
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuCheckboxItem
                          checked={sidebarFilter === 'builtin'}
                          onCheckedChange={() => setSidebarFilter('builtin')}
                        >
                          {t('data_quality.filter_builtin_only')}
                        </DropdownMenuCheckboxItem>
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
                    <Button variant="ghost" size="icon-xs" disabled={!canWrite} onClick={handleNewCheck}>
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>

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
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => handleBulkSetDisabled(false)}>
                          <Eye size={12} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('data_quality.enable_check')}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" disabled={selectedIds.size === 0} onClick={() => handleBulkSetDisabled(true)}>
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
                          disabled={selectedCustomIds.length === 0}
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

                {/* Search input */}
                <div className="border-b px-2 py-1.5">
                  <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t('common.search')}
                      className="h-6 border-0 bg-accent/50 pl-6 text-xs shadow-none placeholder:text-muted-foreground/60"
                    />
                  </div>
                </div>

                {/* Radix wraps viewport children in a shrink-to-fit `display:table` div;
                    force it to a full-width block so rows can't grow past the sidebar
                    (and thus truncate + pin their action cluster to the visible edge). */}
                <ScrollArea className="min-h-0 flex-1 overflow-hidden [&>[data-slot=scroll-area-viewport]>div]:!block">
                  <div className="space-y-0.5 p-1.5">
                    {filterCount === 0 ? (
                      <div className="py-8 text-center">
                        <ShieldCheck size={20} className="mx-auto text-muted-foreground/50" />
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {searchQuery ? t('common.no_results') : t('data_quality.no_checks')}
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* Custom checks */}
                        {filteredCustomChecks.length > 0 && (
                          <>
                            {sidebarFilter === 'all' && (
                              <div className="mb-1 mt-1 px-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {t('data_quality.source_custom')}
                              </div>
                            )}
                            {filteredCustomChecks.map((check) => renderRow({
                              id: check.id,
                              category: check.category,
                              name: check.name,
                              isCustom: true,
                              dirty: isCheckDirty(check.id),
                            }))}
                          </>
                        )}

                        {/* Built-in checks */}
                        {filteredBuiltinChecks.length > 0 && (
                          <>
                            {sidebarFilter === 'all' && (
                              <div className="mb-1 mt-2 px-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {t('data_quality.source_builtin')}
                              </div>
                            )}
                            {builtinLoading ? (
                              <div className="flex items-center justify-center py-4">
                                <Loader2 size={14} className="animate-spin text-muted-foreground" />
                              </div>
                            ) : (
                              filteredBuiltinChecks.map((check) => renderRow({
                                id: check.id,
                                category: check.category,
                                name: check.description || check.name,
                                isCustom: false,
                                dirty: builtinSqlOverrides.has(check.id),
                              }))
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </Allotment.Pane>

            {/* Editor area */}
            <Allotment.Pane minSize={400}>
              {(selectedCustomCheck || selectedBuiltinCheck) ? (
                <div className="flex h-full flex-col">
                  {/* Check metadata bar */}
                  <div className="flex items-center gap-2 border-b px-3 py-1.5">
                    {selectedCustomCheck ? (
                      <>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-[10px] text-muted-foreground">{t('data_quality.col_category')}:</Label>
                          <Select
                            value={selectedCustomCheck.category}
                            onValueChange={(v) => updateCustomCheck(selectedCustomCheck.id, { category: v as DqCategory })}
                          >
                            <SelectTrigger className="w-36 data-[size=xs]:h-6">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper" side="bottom">
                              {CATEGORIES.map((c) => (
                                <SelectItem key={c} value={c}>{t(`data_quality.category_${c}`)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-[10px] text-muted-foreground">{t('data_quality.col_severity')}:</Label>
                          <Select
                            value={selectedCustomCheck.severity}
                            onValueChange={(v) => updateCustomCheck(selectedCustomCheck.id, { severity: v as DqSeverity })}
                          >
                            <SelectTrigger className="w-32 data-[size=xs]:h-6">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper" side="bottom">
                              {SEVERITIES.map((s) => (
                                <SelectItem key={s} value={s}>{t(`data_quality.severity_${s}`)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-[10px] text-muted-foreground">{t('data_quality.custom_threshold')}:</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            value={selectedCustomCheck.threshold}
                            onChange={(e) => updateCustomCheck(selectedCustomCheck.id, { threshold: Number(e.target.value) })}
                            className="h-6 w-16 text-[13px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          />
                        </div>
                      </>
                    ) : selectedBuiltinCheck && (
                      <>
                        <span className="text-xs font-medium truncate">{selectedBuiltinCheck.description || selectedBuiltinCheck.name}</span>
                        <Badge variant="outline" className="shrink-0">
                          {selectedBuiltinCheck.source === 'schema' ? t('data_quality.source_schema') : t('data_quality.source_builtin')}
                        </Badge>
                        <Badge variant="outline" className="shrink-0">
                          {t(`data_quality.category_${selectedBuiltinCheck.category}`)}
                        </Badge>
                        <Badge variant="outline" className="shrink-0">
                          {t(`data_quality.severity_${selectedBuiltinCheck.severity}`)}
                        </Badge>
                      </>
                    )}
                  </div>

                  {/* Monaco editor */}
                  <div className="min-h-0 flex-1">
                    <CodeEditor
                      value={editorSql}
                      onChange={handleEditorChange}
                      language="sql"
                      onSave={() => handleSave()}
                      onRunSelectionOrLine={() => handleTest()}
                      onRunFile={() => handleTest()}
                    />
                  </div>

                  {/* Output pane */}
                  {testResult && (
                    <div className={cn(
                      'border-t px-3 py-2 text-xs',
                      testResult.success
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-red-500/30 bg-red-500/5',
                    )}>
                      <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                        {testResult.message}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <ShieldCheck size={32} className="mx-auto text-muted-foreground/50" />
                    <p className="mt-3 text-sm font-medium">{t('data_quality.no_checks')}</p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">{t('data_quality.no_checks_description')}</p>
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

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('data_quality.delete_check_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget === 'bulk'
                ? t('data_quality.delete_checks_confirm', { count: selectedCustomIds.length })
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
