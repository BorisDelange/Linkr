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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { queryDataSource } from '@/lib/duckdb/engine'
import { generateChecks } from '@/lib/duckdb/data-quality'
import type { DqCheck, DqCategory, DqSeverity } from '@/lib/duckdb/data-quality'
import { useDqStore } from '@/stores/dq-store'
import { useDataSourceStore } from '@/stores/data-source-store'
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
    _dirtyVersion,
  } = useDqStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
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

  // Force re-render when dirty state changes
  void _dirtyVersion

  // Load built-in checks for this data source
  useEffect(() => {
    let cancelled = false
    const loadBuiltin = async () => {
      setBuiltinLoading(true)
      try {
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
  }, [dataSourceId, activeSource?.schemaMapping])

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
        setTestResult({ success: false, message: 'Query returned no rows' })
        return
      }
      const violated = Number(rows[0].violated_rows ?? 0)
      const total = Number(rows[0].total_rows ?? 0)
      const threshold = selectedCustomCheck?.threshold ?? selectedBuiltinCheck?.threshold ?? 0
      const pct = total > 0 ? ((violated / total) * 100).toFixed(1) : '0'
      const passed = threshold === 0 ? violated === 0 : Number(pct) <= threshold

      const stats = `${violated} / ${total} violated rows (${pct}%) · threshold: ${threshold}%`
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
                disabled={testing}
                className="h-6 gap-1 px-2 text-xs"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {testing ? t('data_quality.testing') : t('data_quality.test_check')}
              </Button>

              {selectedCheckId && selectedCustomCheck && isCheckDirty(selectedCheckId) && (
                <Button
                  size="icon-xs"
                  variant="ghost"
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
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('data_quality.checks')}
                  </span>
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
                    <Button variant="ghost" size="icon-xs" onClick={handleNewCheck}>
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>

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

                <ScrollArea className="min-h-0 flex-1 overflow-hidden">
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
                            {filteredCustomChecks.map((check) => {
                              const dirty = isCheckDirty(check.id)
                              return (
                                <button
                                  key={check.id}
                                  onClick={() => selectCheck(check.id)}
                                  className={cn(
                                    'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                                    selectedCheckId === check.id
                                      ? 'bg-accent text-accent-foreground'
                                      : 'text-foreground hover:bg-accent/50',
                                  )}
                                >
                                  <span className={cn(
                                    'inline-block h-2 w-2 shrink-0 rounded-full',
                                    CATEGORY_COLORS[check.category].split(' ')[0],
                                  )} />
                                  <span className="min-w-0 flex-1 truncate">{check.name}</span>
                                  {dirty && <span className="size-1.5 shrink-0 rounded-full bg-orange-500" />}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); deleteCustomCheck(check.id) }}
                                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                                  >
                                    <Trash2 size={10} />
                                  </button>
                                </button>
                              )
                            })}
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
                              filteredBuiltinChecks.map((check) => {
                                const label = check.description || check.name
                                return (
                                  <button
                                    key={check.id}
                                    onClick={() => selectCheck(check.id)}
                                    className={cn(
                                      'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                                      selectedCheckId === check.id
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-foreground hover:bg-accent/50',
                                    )}
                                  >
                                    <span className={cn(
                                      'inline-block h-2 w-2 shrink-0 rounded-full',
                                      CATEGORY_COLORS[check.category]?.split(' ')[0] ?? 'bg-gray-400',
                                    )} />
                                    <span className="min-w-0 flex-1 truncate">{label}</span>
                                    {builtinSqlOverrides.has(check.id) && (
                                      <span className="size-1.5 shrink-0 rounded-full bg-orange-500" />
                                    )}
                                  </button>
                                )
                              })
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
                        <Input
                          value={selectedCustomCheck.name}
                          onChange={(e) => updateCustomCheck(selectedCustomCheck.id, { name: e.target.value })}
                          className="h-6 w-40 border-0 bg-transparent px-1 text-xs font-medium shadow-none"
                        />
                        <Select
                          value={selectedCustomCheck.category}
                          onValueChange={(v) => updateCustomCheck(selectedCustomCheck.id, { category: v as DqCategory })}
                        >
                          <SelectTrigger className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[10px] shadow-none">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CATEGORIES.map((c) => (
                              <SelectItem key={c} value={c}>{t(`data_quality.category_${c}`)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={selectedCustomCheck.severity}
                          onValueChange={(v) => updateCustomCheck(selectedCustomCheck.id, { severity: v as DqSeverity })}
                        >
                          <SelectTrigger className="h-6 w-auto gap-1 border-0 bg-transparent px-1.5 text-[10px] shadow-none">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SEVERITIES.map((s) => (
                              <SelectItem key={s} value={s}>{t(`data_quality.severity_${s}`)}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1">
                          <Label className="text-[10px] text-muted-foreground">{t('data_quality.custom_threshold')}:</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            value={selectedCustomCheck.threshold}
                            onChange={(e) => updateCustomCheck(selectedCustomCheck.id, { threshold: Number(e.target.value) })}
                            className="h-6 w-14 border-0 bg-transparent px-1 text-[10px] shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          />
                        </div>
                      </>
                    ) : selectedBuiltinCheck && (
                      <>
                        <span className="text-xs font-medium truncate">{selectedBuiltinCheck.description || selectedBuiltinCheck.name}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {selectedBuiltinCheck.source === 'schema' ? t('data_quality.source_schema') : t('data_quality.source_builtin')}
                        </Badge>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {t(`data_quality.category_${selectedBuiltinCheck.category}`)}
                        </Badge>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
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
                    <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={handleNewCheck}>
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
    </TooltipProvider>
  )
}
